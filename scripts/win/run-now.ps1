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

New-Item -ItemType Directory -Path ([IO.Path]::Combine($Repo, "data")) -Force | Out-Null
$script:LogFile = $Log
$rc = 1
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
  } else {
    $rc = Invoke-ClaudeRun $Prompt $Budget "$Label (dashboard)"
  }

  [void](Invoke-Record @("log", "run-finish", "$Label finished (exit $rc)"))
  if ($rc -eq 0) { Write-Status "ok" "$Label completed" } else { Write-Status "failed" "$Label exited $rc" }

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
