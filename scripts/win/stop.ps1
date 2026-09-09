# Stop the JobSeeker dashboard. Start Menu > JobSeeker > Quit JobSeeker runs this, and so does the
# dashboard's own Quit button.
#
# It exists because on Windows, unlike the Mac, closing the window does not stop the server:
# scripts\win\launch.ps1 deliberately leaves it up so the scheduled daily run keeps working. That
# makes quitting an explicit act, and this is it.
#
#   powershell -File scripts\win\stop.ps1
#
# The care taken below is about ONE failure: a pid file outlives the process it names, Windows
# hands that number to something else, and quitting JobSeeker kills a stranger. So a pid is never
# trusted on its own -- it is only killed once the process it points at turns out to be a node
# running THIS repo's server\dashboard.mjs. Without a usable pid file, the same test is run over
# every node process instead, which finds a dashboard started by an older build or by hand.

$ErrorActionPreference = "Stop"
Set-StrictMode -Off
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$OnWindows = ([System.Environment]::OSVersion.Platform -eq "Win32NT")

# Join a Windows-style relative path onto a base, splitting on the backslash so the same code also
# runs under pwsh on macOS/Linux (which is where the tests exercise it). Same helper as install.ps1.
function Sub([string]$base, [string]$rel) {
  $p = $base
  foreach ($part in ($rel -split '[\\/]')) { if ($part) { $p = Join-Path $p $part } }
  return $p
}

# Native command with stderr swallowed -> @(exitCode, stdout). Windows PowerShell 5.1 turns
# redirected stderr into terminating errors under $ErrorActionPreference = Stop.
function Invoke-Native([string]$exe, [string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & $exe @argv 2>$null | ForEach-Object { "$_" }
    return @($LASTEXITCODE, (@($out) -join "`n"))
  } finally {
    $ErrorActionPreference = $prev
  }
}

$PidFile = Sub $Repo "data\.setup\server.pid"
# Command lines are compared with every slash turned into a backslash, so the same test matches
# whether the dashboard was started as server\dashboard.mjs (launch.ps1) or server/dashboard.mjs
# (a hand-typed run, or a config carried over from the Mac).
$Target = (Sub $Repo "server\dashboard.mjs") -replace '/', '\'

function Test-IsOurDashboard([string]$name, [string]$commandLine) {
  if (-not $commandLine) { return $false }
  $n = "$name".ToLower()
  if ($n -ne "node.exe" -and $n -ne "node") { return $false }
  $c = $commandLine -replace '/', '\'
  return ($c.IndexOf($Target, [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

# @(name, commandLine) for one pid, or $null if there is no such process.
#
# Win32_Process is the Windows path and the only one that matters in production. macOS and Linux
# have no CIM, so there is a `ps` fallback -- not for users, but so this script can be tested off
# Windows like the rest of scripts\win.
function Get-ProcInfo([int]$procId) {
  if ($OnWindows) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    return @("$($p.Name)", "$($p.CommandLine)")
  }
  $r = Invoke-Native "ps" @("-o", "command=", "-p", "$procId")
  if ($r[0] -ne 0 -or -not $r[1]) { return $null }
  $cmd = "$($r[1])".Split("`n")[0].Trim()
  if (-not $cmd) { return $null }
  return @([IO.Path]::GetFileName(($cmd -split '\s+')[0]), $cmd)
}

# Every pid whose process is this repo's dashboard. Same two implementations, same reason.
function Find-Dashboards {
  $hits = @()
  if ($OnWindows) {
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)) {
      if (Test-IsOurDashboard "$($p.Name)" "$($p.CommandLine)") { $hits += [int]$p.ProcessId }
    }
    return $hits
  }
  $r = Invoke-Native "ps" @("-A", "-o", "pid=,command=")
  foreach ($line in ("$($r[1])" -split "`n")) {
    if ($line -notmatch '^\s*(\d+)\s+(.*)$') { continue }
    $procId = [int]$Matches[1]
    $cmd = $Matches[2]
    if ($procId -eq $PID) { continue }
    if (Test-IsOurDashboard ([IO.Path]::GetFileName(($cmd -split '\s+')[0])) $cmd) { $hits += $procId }
  }
  return $hits
}

function Stop-One([int]$procId) {
  try {
    Stop-Process -Id $procId -Force -ErrorAction Stop
    return $true
  } catch {
    [Console]::Error.WriteLine("could not stop JobSeeker (pid $procId): $($_.Exception.Message)")
    return $false
  }
}

$stopped = @()
$said = $false   # whether the pid-file branch already explained itself

if (Test-Path -LiteralPath $PidFile) {
  $raw = ""
  try { $raw = (Get-Content -LiteralPath $PidFile -Raw).Trim() } catch { $raw = "" }
  if ($raw -match '^\d+$') {
    $procId = [int]$raw
    $info = Get-ProcInfo $procId
    if (-not $info) {
      Write-Host "JobSeeker was not running (the recorded process $procId is gone)."
      $said = $true
    } elseif (-not (Test-IsOurDashboard $info[0] $info[1])) {
      # The pid was reused. Leave whatever now owns that number completely alone.
      Write-Host "JobSeeker was not running (process $procId belongs to something else now)."
      $said = $true
    } elseif (Stop-One $procId) {
      $stopped += $procId
    }
  } else {
    Write-Host "The recorded process id is unreadable; looking for JobSeeker by hand."
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  if ($stopped.Count -gt 0) {
    Write-Host "Stopped JobSeeker (pid $($stopped -join ', '))."
    exit 0
  }
}

# No pid file, or it named a process that was not ours: look for the dashboard itself. This is what
# catches a server started by an older build, or by hand from a terminal.
$found = @(Find-Dashboards)
if ($found.Count -eq 0) {
  if (-not $said) { Write-Host "JobSeeker was not running." }
  exit 0
}
foreach ($procId in $found) {
  if (Stop-One $procId) { $stopped += $procId }
}
if ($stopped.Count -gt 0) {
  Write-Host "Stopped JobSeeker (pid $($stopped -join ', '))."
} else {
  Write-Host "JobSeeker is running but could not be stopped."
  exit 1
}
exit 0
