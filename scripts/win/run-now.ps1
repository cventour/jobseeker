# Run one of the job-search commands right now, from the dashboard's "Run now" buttons.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win\run-now.ps1 track
#
# Twin of scripts/run-now.sh — change both together.
#
# The scheduled path (scripts\win\job-run.ps1) already existed; this is the same work when you do
# not want to wait for 08:00, or have no schedule installed at all. It never applies and never
# sends: every command below queues approvals for you, exactly as the scheduled run does.
#
# It SPENDS MONEY. The per-run budget and the monthly ceiling from your config are honoured here
# for the same reason they are honoured by the scheduler — a cap that only applies to the paths you
# are not looking at is not a cap.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location -LiteralPath $Repo
. "$PSScriptRoot\lib\claude-run.ps1"

$Slug = ""
$Target = ""
if ($args.Count -ge 1) { $Slug = [string]$args[0] }
if ($args.Count -ge 2) { $Target = [string]$args[1] }
$Log = [IO.Path]::Combine($Repo, "data", ".run-now.log")
$Status = [IO.Path]::Combine($Repo, "data", ".run-now.status.json")

# The whole menu, in one place: slug -> slash command, label, per-run budget default.
#
# `apply` is the only one that takes an argument. It shares this script — and therefore the run lock
# and the spend caps — because it drives Chrome like the others, and two agents in the same browser
# read each other's tabs (AGENT-RULES §13).
switch ($Slug) {
  "job-run"  { $Prompt = "/job-run";  $Label = "Full daily run";       $DefaultBudget = "5" }
  "track"    { $Prompt = "/track";    $Label = "Read my channels";     $DefaultBudget = "3" }
  "curate"   { $Prompt = "/curate";   $Label = "Find new roles";       $DefaultBudget = "3" }
  "followup" { $Prompt = "/followup"; $Label = "Draft due follow-ups"; $DefaultBudget = "2" }
  "apply" {
    # The id reaches this from a web form, and it is about to be interpolated into a prompt. An
    # allow-list on the SHAPE, checked again here rather than trusted from the caller.
    if ($Target -notmatch '^prop_[a-z0-9]+$') {
      [Console]::Error.WriteLine("invalid proposal id '$Target' — expected prop_xxxxxx")
      exit 64
    }
    if (-not (Test-Path -LiteralPath ([IO.Path]::Combine($Repo, "data", "proposals", "$Target.md")) -PathType Leaf)) {
      [Console]::Error.WriteLine("no such proposal: $Target")
      exit 66
    }
    $Prompt = "/apply-fill $Target"; $Label = "Fill an application"; $DefaultBudget = "3"
  }
  default {
    [Console]::Error.WriteLine("usage: run-now.ps1 <job-run|track|curate|followup|apply <proposal-id>>")
    exit 64
  }
}

function Write-Status { # state, detail
  param([string]$State, [string]$Detail)
  $json = @"
{
  "slug": "$Slug",
  "label": "$Label",
  "state": "$State",
  "started": "$Started",
  "finished": "$(Get-UtcStamp)",
  "detail": "$(ConvertTo-JsonString $Detail)"
}
"@
  Write-Utf8File $Status ($json + "`n")   # the bash heredoc ends with a newline; match it byte for byte
}

$Started = Get-UtcStamp

$JobRunStatus = [IO.Path]::Combine($Repo, "data", ".job-run.status.json")

function Read-JobRunStatus { # raw text, or "" when there is none
  if (-not (Test-Path -LiteralPath $JobRunStatus -PathType Leaf)) { return "" }
  try { return (Get-Content -LiteralPath $JobRunStatus -Raw -Encoding UTF8) } catch { return "" }
}

# One field out of the status file job-run.ps1 writes. Whether that file belongs to the run WE
# started is decided by the caller comparing its contents before and after, not by comparing
# timestamps: these stamps have one-second resolution, so a job-run that died instantly would
# sometimes carry the same second as our own start and be accepted as fresh. Handing back last
# hour's "ok" is worse than handing back nothing at all, and it is the same class of bug as the one
# this whole change is about.
function Get-JobRunField { # field -> value, or ""
  param([string]$Field)
  $raw = Read-JobRunStatus
  if (-not $raw) { return "" }
  try {
    $s = $raw | ConvertFrom-Json
    if ($s.state -eq "running") { return "" }   # still in flight; not a verdict
    if ($null -eq $s.$Field) { return "" }
    return [string]$s.$Field
  } catch { return "" }
}

New-Item -ItemType Directory -Path ([IO.Path]::Combine($Repo, "data")) -Force | Out-Null
$script:LogFile = $Log
$rc = 1
$jrState = ""
$jrDetail = ""
try {
  Write-RunLog "==================== run-now '$Slug' $(Get-LocalStamp) ===================="

  if (-not (Require-Claude)) { Write-Status "failed" "claude CLI not found on PATH"; exit 127 }

  # Taken here rather than inside the claude call, so a second click is refused before it has
  # spent anything, and the dashboard can see who holds it.
  if (-not (Take-RunLock $Slug)) {
    Write-Status "skipped-busy" "another run was already in progress"
    exit 75
  }

  if (Test-MonthCeiling) {
    Write-Status "skipped-budget" "monthly spend ceiling reached; run not started"
    [void](Invoke-Record @("log", "run-skipped", "monthly spend ceiling reached: '$Slug' not started from the dashboard"))
    exit 0
  }

  $Budget = Get-RunBudget $DefaultBudget
  Write-RunLog "---- $Label ($Prompt), budget `$$Budget ----"
  [void](Invoke-Record @("log", "run-start", "$Label started from the dashboard ($Prompt)"))

  if ($Slug -eq "job-run") {
    # The daily pipeline has hardening the other commands do not need — a watchdog, one retry, a
    # memory guard, a full wake before it touches Chrome. Delegate rather than reimplement a
    # weaker copy of it here; it writes its own log and its own status file.
    # Snapshot the verdict already on disk, so "job-run wrote one" can be told from "job-run died
    # before it could". Contents, not timestamps — see Get-JobRunField.
    $jrBefore = Read-JobRunStatus
    $jobRun = [IO.Path]::Combine($Repo, "scripts", "win", "job-run.ps1")
    if (Test-Path -LiteralPath $jobRun -PathType Leaf) {
      $env:JOBRUN_SOURCE = "manual"
      $shell = (Get-Process -Id $PID).Path
      $r = Invoke-Native -FilePath $shell -WorkingDirectory $Repo `
        -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $jobRun)
      $rc = [int]$r.ExitCode
      if ($r.Out) { Write-RunLog $r.Out.TrimEnd("`n", "`r") }
      if ($r.Err) { Write-RunLog $r.Err.TrimEnd("`n", "`r") }
    } else {
      Write-RunLog "$jobRun not found"
      $rc = 127
    }
    Write-RunLog "job-run.ps1 exited $rc (its own output is in data/.job-run.log)"
    # And its status file is the verdict, not its exit code. job-run deliberately records `failed`
    # for a run that finished but wrote no digest — the one deliverable it exists to produce —
    # while still exiting 0, so trusting $rc here reported "Full daily run completed" for a run
    # whose own status file, written seconds earlier, said the opposite. That is what "it said it
    # finished and nothing appeared" is: not a run that lied, a verdict thrown away by the caller
    # that displayed it.
    $jrAfter = Read-JobRunStatus
    if ($jrAfter -and $jrAfter -ne $jrBefore) {
      $jrState = Get-JobRunField "state"
      $jrDetail = Get-JobRunField "detail"
    }
  } else {
    # How much of the log was already there, so a failure can be explained in words rather than as
    # an exit code.
    $before = 0
    if (Test-Path $Log) { $before = @(Get-Content $Log -ErrorAction SilentlyContinue).Count }
    $rc = Invoke-ClaudeRun $Prompt $Budget "$Label (dashboard)"
    $runOut = ""
    if (Test-Path $Log) {
      $runOut = (@(Get-Content $Log -ErrorAction SilentlyContinue) | Select-Object -Skip $before) -join "`n"
    }
  }

  if ($null -eq $runOut) { $runOut = "" }
  [void](Invoke-Record @("log", "run-finish", "$Label finished (exit $rc)"))
  if ($jrState) {
    if (-not $jrDetail) { $jrDetail = "finished" }
    Write-Status $jrState "$Label $jrDetail"
    # Keep the exit code and the status agreeing. Nothing consumes this one — the dashboard reads
    # the file — but a script whose exit code contradicts what it just wrote down is how this bug
    # got here in the first place.
    if ($jrState -ne "ok" -and $jrState -ne "partial") { $rc = 1 }
  } elseif ($rc -eq 0) {
    Write-Status "ok" "$Label completed"
  } else {
    # Say why, and say it where someone will see it. job-run writes its own row, so this covers the
    # other buttons; a status file is overwritten by the next run, the activity log is not.
    $why = Get-FailureReason $runOut "$Label exited $rc — the full output is in data\.run-now.log."
    Write-Status "failed" $why
    Write-Problem "run-failed" "$Label did not finish. $why"
  }

  Write-RunLog "==================== done $(Get-LocalStamp) (exit $rc) ===================="
  exit $rc
} catch {
  # bash runs without -e and would have limped on; here anything unexpected is a failed run that
  # still says so in the status file, so the button does not stay lit.
  Write-RunLog "ERROR: $($_.Exception.Message)"
  try { Write-Status "failed" "$Label failed: $($_.Exception.Message)" } catch { }
  exit 1
} finally {
  Release-RunLock
}
