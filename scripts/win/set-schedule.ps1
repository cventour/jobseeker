# Set (or remove) the time the daily run fires. Twin of scripts/set-schedule.sh — change both together.
#
# This exists because the schedule had a TRAP in it. config/job-seeker.config.md carried a
# `schedule_job_run` cron expression, /onboard wrote it, and NOTHING READ IT -- the real schedule
# lives in the OS scheduler (launchd on macOS, Task Scheduler here). A user who set 09:00 still got
# 08:00, with no warning. A settings form would make that worse, because a form looks authoritative
# in a way a config comment does not. So there is exactly one way to change the schedule, and it
# edits the Task Scheduler task.
#
#   powershell -File scripts\win\set-schedule.ps1 09:15            install / move the run, every day
#   powershell -File scripts\win\set-schedule.ps1 09:15 1,2,3,4,5  weekdays only (0 = Sunday … 6 = Saturday)
#   powershell -File scripts\win\set-schedule.ps1 --remove         unschedule it
#   powershell -File scripts\win\set-schedule.ps1 --show           print the schedule, read back from the task
#
# Days are optional and default to every day. Task Scheduler has a real day-list field, so unlike
# launchd's one-dict-per-weekday array this is ONE task with either a Daily trigger (every day) or a
# Weekly trigger carrying a DaysOfWeek bitmask (Sunday = 1, Monday = 2, … Saturday = 64).
#
# The task is \JobSeeker\JobRun (JOBSEEKER_TASK_NAME=JobSeeker\JobRunTest overrides both halves, for
# tests). It runs wscript.exe run-hidden.vbs job-run.ps1 in the repo, so no console window appears.
#
# Environment: the launchd plist handed the run a PATH so `claude` would resolve. Task Scheduler
# cannot set per-task environment variables, so nothing is passed here — scripts\win\job-run.ps1
# derives its own repo path (from $PSScriptRoot) and locates node/claude itself.
#
# Output is byte-for-byte what the bash twin prints, because server/platform.mjs scheduleShow()
# parses it: `not scheduled` | `HH:MM` | `HH:MM 1,4`. Exit codes match too (64 bad input,
# 66 missing launcher, 70 scheduler refused).

$ErrorActionPreference = "Stop"
Set-StrictMode -Off
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Launcher = Join-Path $Repo "scripts\win\run-hidden.vbs"
$JobRun = Join-Path $Repo "scripts\win\job-run.ps1"

# "JobSeeker\JobRun" -> TaskPath "\JobSeeker\", TaskName "JobRun".
$FullName = "JobSeeker\JobRun"
if ($env:JOBSEEKER_TASK_NAME) { $FullName = $env:JOBSEEKER_TASK_NAME.Trim("\") }
$slash = $FullName.LastIndexOf("\")
if ($slash -ge 0) {
  $TaskPath = "\" + $FullName.Substring(0, $slash) + "\"
  $TaskName = $FullName.Substring($slash + 1)
} else {
  $TaskPath = "\"
  $TaskName = $FullName
}

$OnWindows = [System.Environment]::OSVersion.Platform -eq "Win32NT"
$HasCmdlets = $OnWindows -and [bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)

function Write-Err([string]$msg) { [Console]::Error.WriteLine($msg) }

# Runs a native command with stderr swallowed and returns @(exitCode, stdoutText). Wrapped because
# Windows PowerShell 5.1 turns redirected stderr into terminating errors under $ErrorActionPreference
# = Stop, which would abort the script on schtasks' own "task not found" chatter.
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

# Bitmask -> "1,4" (0 = Sunday … 6 = Saturday, ascending). Empty for a full week or no mask.
function DaysFromMask([int]$mask) {
  $days = @()
  for ($d = 0; $d -le 6; $d++) {
    if ($mask -band (1 -shl $d)) { $days += $d }
  }
  if ($days.Count -eq 0 -or $days.Count -eq 7) { return "" }
  return ($days -join ",")
}

# XML weekday names (schtasks /Query /XML fallback) -> bitmask.
function MaskFromXmlDays($node) {
  if (-not $node) { return 0 }
  $names = @("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
  $mask = 0
  for ($d = 0; $d -le 6; $d++) {
    # local-name(): the weekday elements sit in the task XML's default namespace.
    if ($node.SelectSingleNode("*[local-name()='$($names[$d])']")) { $mask = $mask -bor (1 -shl $d) }
  }
  return $mask
}

# Prints "HH:MM" for an every-day schedule, or "HH:MM 1,2,3,4,5" when it runs on named days —
# the same shape this script accepts as input, so what it prints can be fed straight back in.
function Show {
  if (-not $OnWindows) { "not scheduled"; return }
  $start = $null; $mask = 0
  if ($HasCmdlets) {
    $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { "not scheduled"; return }
    $trig = @($task.Triggers) | Select-Object -First 1
    if ($trig) {
      $start = "$($trig.StartBoundary)"
      $dow = $trig.PSObject.Properties["DaysOfWeek"]
      if ($dow -and $dow.Value) { $mask = [int]$dow.Value }
    }
  } else {
    $r = Invoke-Native "schtasks.exe" @("/Query", "/TN", ($TaskPath.TrimStart("\") + $TaskName), "/XML")
    if ($r[0] -ne 0 -or -not $r[1]) { "not scheduled"; return }
    try {
      $xml = [xml]$r[1]
      $ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
      $ns.AddNamespace("t", "http://schemas.microsoft.com/windows/2004/02/mit/task")
      $cal = $xml.SelectSingleNode("//t:CalendarTrigger", $ns)
      if ($cal) {
        $sb = $cal.SelectSingleNode("t:StartBoundary", $ns)
        if ($sb) { $start = $sb.InnerText }
        $mask = MaskFromXmlDays $cal.SelectSingleNode("t:ScheduleByWeek/t:DaysOfWeek", $ns)
      }
    } catch { $start = $null }
  }
  if (-not $start -or $start -notmatch "T(\d\d):(\d\d)") { "scheduled (no time found in task)"; return }
  $time = "{0}:{1}" -f $Matches[1], $Matches[2]
  $days = DaysFromMask $mask
  if ($days) { "$time $days" } else { $time }
}

function Remove-Schedule {
  if (-not $OnWindows) { Write-Err "Task Scheduler is only available on Windows"; exit 1 }
  if ($HasCmdlets) {
    Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  } else {
    Invoke-Native "schtasks.exe" @("/Delete", "/TN", ($TaskPath.TrimStart("\") + $TaskName), "/F") | Out-Null
  }
  "unscheduled"
}

$mode = "--show"
if ($args.Count -ge 1) { $mode = [string]$args[0] }
switch ($mode) {
  "--show"   { Show; exit 0 }
  "--remove" { Remove-Schedule; exit 0 }
}

$Time = $mode
# Accept HH:MM only. This runs from a web request, so the input is not trusted: anything else could
# end up interpolated into a task definition.
if ($Time -notmatch '^([01][0-9]|2[0-3]):[0-5][0-9]$') {
  Write-Err "invalid time '$Time' — expected HH:MM in 24-hour form, e.g. 09:15"
  exit 64
}
$Hour = [int]$Time.Substring(0, 2)
$Min = [int]$Time.Substring(3, 2)

# Days: 0-6, comma separated, Sunday first — the same numbering Task Scheduler's bitmask order,
# launchd and JavaScript all use, so nothing has to be translated between the browser and the task.
# Empty means every day, which is what every existing caller passes.
$Days = ""
if ($args.Count -ge 2) { $Days = [string]$args[1] }
if ($Days -ne "") {
  if ($Days -notmatch '^[0-6](,[0-6])*$') {
    Write-Err "invalid days '$Days' — expected digits 0-6 separated by commas, e.g. 1,2,3,4,5"
    exit 64
  }
  # Duplicates would install the same run twice on one day.
  $Days = (@($Days -split "," | Sort-Object -Unique) -join ",")
  if ($Days -eq "0,1,2,3,4,5,6") { $Days = "" }   # every day is the plain schedule, not a seven-day mask
}

if (-not (Test-Path -LiteralPath $Launcher)) { Write-Err "missing launcher: $Launcher"; exit 66 }
if (-not $OnWindows) { Write-Err "Task Scheduler is only available on Windows"; exit 1 }

$WScript = Join-Path $env:SystemRoot "System32\wscript.exe"
$At = Get-Date -Hour $Hour -Minute $Min -Second 0 -Millisecond 0
$DayList = @()
if ($Days -ne "") { $DayList = @($Days -split "," | ForEach-Object { [int]$_ }) }

try {
  if ($HasCmdlets) {
    $action = New-ScheduledTaskAction -Execute $WScript -Argument ('"{0}" "{1}"' -f $Launcher, $JobRun) -WorkingDirectory $Repo
    if ($DayList.Count -eq 0) {
      $trigger = New-ScheduledTaskTrigger -Daily -At $At
    } else {
      $dow = [System.DayOfWeek[]]($DayList | ForEach-Object { [System.DayOfWeek]$_ })
      $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $dow -At $At
    }
    $settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -MultipleInstances IgnoreNew `
      -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    # Ask Windows who we are rather than assembling a name from the environment. USERDOMAIN is
    # "WORKGROUP" on a machine that is not domain-joined, and "WORKGROUP\name" maps to no account
    # at all -- Task Scheduler rejects it with "No mapping between account names and security IDs
    # was done", which is how the daily run failed to install on a plain Windows 11 Home PC. The
    # identity's own name is already the right "COMPUTER\User"; its SID is the last resort, and
    # Task Scheduler accepts one in place of a name.
    $me = $null
    try { $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name } catch { $me = $null }
    if (-not $me) {
      try { $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { $me = $null }
    }
    if (-not $me) { $me = "$env:USERDOMAIN\$env:USERNAME" }
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Action $action -Trigger $trigger `
      -Settings $settings -Principal $principal -Force | Out-Null
  } else {
    # Minimal fallback for a Windows without the ScheduledTasks module. No working directory here:
    # job-run.ps1 finds the repo from its own location, so the absolute paths are enough.
    $tr = '"{0}" "{1}" "{2}"' -f $WScript, $Launcher, $JobRun
    $tn = $TaskPath.TrimStart("\") + $TaskName
    $argv = @("/Create", "/TN", $tn, "/TR", $tr, "/ST", $Time, "/F")
    if ($DayList.Count -eq 0) {
      $argv += @("/SC", "DAILY")
    } else {
      $abbr = @("SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT")
      $argv += @("/SC", "WEEKLY", "/D", (($DayList | ForEach-Object { $abbr[$_] }) -join ","))
    }
    $r = Invoke-Native "schtasks.exe" $argv
    if ($r[0] -ne 0) { throw "schtasks exited $($r[0]): $($r[1])" }
  }
} catch {
  Write-Err "task could not be registered with Task Scheduler — see docs/SCHEDULER.md ($($_.Exception.Message))"
  exit 70
}
"run scheduled for $(Show)"
exit 0
