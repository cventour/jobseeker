# Memory watchdog for a job-run (or any Claude Code session). Twin of scripts/rss-guard.sh —
# change both together.
#
# Why this exists: on 2026-07-29 an interactive run fanned out 7 subagents at once. Three extra
# `claude` processes grew at ~14.5 MB/s each with essentially no CPU, held 15.9 / 12.0 / 6.1 GB
# within 17 minutes, and the kernel's memory killer took the whole machine down. Nothing in this
# repo leaks (every helper is bounded) — so this guard does not try to fix the leak, it makes sure
# a leaking child can never take the machine down again.
#
# What it does: every INTERVAL seconds it walks the process tree under ROOT_PID and
#   * stops (then force-kills) any single descendant over MAX_RSS_MB,
#   * if the tree total still exceeds TOTAL_RSS_MB, stops ROOT_PID itself so the run aborts cleanly
#     (job-run.ps1 will retry) instead of the OS taking the desktop with it.
# It never touches a process outside ROOT_PID's tree, so other Claude Code sessions are safe.
#
# Usage:
#   powershell -File scripts\win\rss-guard.ps1 <root-pid>       # watch that pid's descendants until it exits
#   $env:GUARD_ABORT_ROOT=0; ...rss-guard.ps1 $PID              # log only, never kill the root
#
# Tunables (environment):
#   GUARD_MAX_RSS_MB     per-process kill threshold   (default 4096)
#   GUARD_TOTAL_RSS_MB   whole-tree abort threshold   (default 12288)
#   GUARD_INTERVAL_SECS  poll interval                (default 15)
#   GUARD_ABORT_ROOT     1 = abort the run at the tree ceiling, 0 = log only (default 1)
#
# Caveat: this samples the working set (WorkingSet64), i.e. resident pages only — memory already
# paged out or compressed does not appear. That makes it an UNDER-estimate under pressure, which is
# the safe direction: at ~14.5 MB/s a leaker trips the 4 GB threshold in under 5 minutes.
#
# Exit codes, as the bash: 2 usage, 1 aborted the root at the tree ceiling, 0 root exited normally.
param([Parameter(Position = 0)][string]$RootPidArg)

$ErrorActionPreference = "Stop"

if (-not $RootPidArg -or $RootPidArg -notmatch '^\d+$') {
  [Console]::Error.WriteLine("usage: rss-guard.ps1 <root-pid>")
  exit 2
}
$ROOT_PID = [int]$RootPidArg

function Env-Or([string]$name, [string]$default) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ($null -eq $v -or $v -eq "") { return $default }
  return $v
}
$MAX_RSS_MB   = [long](Env-Or "GUARD_MAX_RSS_MB" "4096")
$TOTAL_RSS_MB = [long](Env-Or "GUARD_TOTAL_RSS_MB" "12288")
$INTERVAL     = [int](Env-Or "GUARD_INTERVAL_SECS" "15")
$ABORT_ROOT   = Env-Or "GUARD_ABORT_ROOT" "1"

function Say([string]$msg) { Write-Output ("[rss-guard " + (Get-Date -Format "HH:mm:ss") + "] " + $msg) }

function Test-Alive([int]$id) {
  try { $null = Get-Process -Id $id -ErrorAction Stop; return $true } catch { return $false }
}

function Get-RssKb([int]$id) {
  try { return [long]((Get-Process -Id $id -ErrorAction Stop).WorkingSet64 / 1024) } catch { return 0 }
}

# Every descendant of ROOT_PID (the root itself excluded) as objects {Pid, RssKb, Cmd}. One process
# listing per tick; the transitive closure is computed to a fixpoint because a leaking process is
# typically a grandchild (claude -> shell -> claude), not a direct child.
function Get-Snapshot {
  $rows = @()
  $procs = $null
  try {
    $procs = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
      ForEach-Object { [PSCustomObject]@{ Pid = [int]$_.ProcessId; PPid = [int]$_.ParentProcessId; Cmd = $(if ($_.CommandLine) { $_.CommandLine } else { $_.Name }) } }
  } catch {
    # No CIM (pwsh on macOS/Linux): fall back to Get-Process's Parent property.
    try {
      $procs = Get-Process -ErrorAction Stop | ForEach-Object {
        $pp = 0
        try { if ($_.Parent) { $pp = [int]$_.Parent.Id } } catch { }
        [PSCustomObject]@{ Pid = [int]$_.Id; PPid = $pp; Cmd = $_.ProcessName }
      }
    } catch { $procs = @() }
  }
  $inTree = @{}
  $inTree[$ROOT_PID] = $true
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $procs) {
      if (-not $inTree.ContainsKey($p.Pid) -and $inTree.ContainsKey($p.PPid)) { $inTree[$p.Pid] = $true; $changed = $true }
    }
  }
  foreach ($p in $procs) {
    if ($inTree.ContainsKey($p.Pid) -and $p.Pid -ne $ROOT_PID) {
      $rows += [PSCustomObject]@{ Pid = $p.Pid; RssKb = (Get-RssKb $p.Pid); Cmd = $p.Cmd }
    }
  }
  return $rows
}

# Stop, give it 10s to unwind, then force. (The bash sends TERM, then KILL from a background sleep.)
function Reap([int]$id, [string]$why) {
  Say ("KILL pid=" + $id + " - " + $why)
  try { Stop-Process -Id $id -ErrorAction Stop } catch { }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Alive $id)) { return }
    Start-Sleep -Milliseconds 500
  }
  try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { }
}

Say ("watching pid " + $ROOT_PID + " (per-process " + $MAX_RSS_MB + "MB, tree " + $TOTAL_RSS_MB + "MB, every " + $INTERVAL + "s)")

while (Test-Alive $ROOT_PID) {
  [long]$total_kb = Get-RssKb $ROOT_PID

  foreach ($row in (Get-Snapshot)) {
    $total_kb += $row.RssKb
    if ($row.RssKb -gt ($MAX_RSS_MB * 1024)) {
      Reap $row.Pid ("" + [long]($row.RssKb / 1024) + "MB > " + $MAX_RSS_MB + "MB cap :: " + $row.Cmd)
      $total_kb -= $row.RssKb
    }
  }

  $total_mb = [long]($total_kb / 1024)
  if ($total_mb -gt $TOTAL_RSS_MB) {
    if ($ABORT_ROOT -eq "1") {
      Say ("ABORT - tree at " + $total_mb + "MB > " + $TOTAL_RSS_MB + "MB ceiling; terminating root pid " + $ROOT_PID)
      try { Stop-Process -Id $ROOT_PID -ErrorAction Stop } catch { }
      exit 1
    }
    Say ("WARN - tree at " + $total_mb + "MB > " + $TOTAL_RSS_MB + "MB ceiling (GUARD_ABORT_ROOT=0, not killing)")
  }

  Start-Sleep -Seconds $INTERVAL
}

Say ("root pid " + $ROOT_PID + " exited; guard done")
exit 0
