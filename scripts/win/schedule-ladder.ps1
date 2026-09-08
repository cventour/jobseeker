# Step the daily run down when nobody is using what it produces, and turn it off if the whole
# system goes untouched. Twin of scripts/schedule-ladder.sh — change both together.
#
#   powershell -File scripts\win\schedule-ladder.ps1          evaluate and act (called at the end of every run)
#   powershell -File scripts\win\schedule-ladder.ps1 --show   print the current tier and what happens next
#   powershell -File scripts\win\schedule-ladder.ps1 --reset  back to daily, clock restarted (the dashboard's Restore)
#
# The ladder:
#   1  every day            -> 2 after 3 days with no roles reviewed
#   2  Mondays + Thursdays  -> 3 after 3 more
#   3  Mondays only         -> 4 only if NOTHING is touched for 14 days
#   4  not scheduled
#
# Two rules make this safe to run unattended:
#
#   * IT WARNS FIRST. A step is only taken on the run AFTER the one that warned, so there is always
#     a full cycle in which the dashboard says what is about to happen and how to stop it. A change
#     to someone's schedule that they discover afterwards is a change made behind their back.
#   * THE CLOCK STARTS WHEN THE LADDER IS ARMED, never from history. An install upgrading into this
#     feature has, by definition, never seen a warning — stepping it down on the first run for a
#     month of backdated silence would be punishing someone for evidence they were never shown.
#
# Recovery is deliberately NOT automatic: when reviewing resumes the dashboard offers a button.
# The decision to speed your machine back up is yours, in the same way the warning was.
#
# The verdict logic is the same `node -e` snippets as the bash twin, copied verbatim, so the two
# cannot drift on what a field means. Notifications are Windows toasts instead of osascript and are
# best-effort: a failed toast never fails the ladder.

$ErrorActionPreference = "Stop"
Set-StrictMode -Off
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $Repo

$State = Join-Path $Repo "data\.schedule-tier.json"
$SetSchedule = Join-Path $PSScriptRoot "set-schedule.ps1"

$NodeBin = $env:NODE_BIN
if (-not $NodeBin) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodeBin = $cmd.Source }
}
if (-not $NodeBin) { $NodeBin = Join-Path $env:ProgramFiles "nodejs\node.exe" }

# FAKE_TODAY pins the clock so the test suite can drive the ladder across dated scenarios.
$Today = $env:FAKE_TODAY
if (-not $Today) { $Today = Get-Date -Format "yyyy-MM-dd" }

# ---- plumbing -----------------------------------------------------------------------------------

# Runs a native command with stderr swallowed and returns its stdout as one string. Windows
# PowerShell 5.1 turns redirected stderr into terminating errors under $ErrorActionPreference =
# Stop, so the preference is relaxed for the duration of the call. $stdin, when given, is piped in.
#
# Quoting: outside pwsh 7.3+'s Standard mode, PowerShell wraps an argument in quotes when it has
# spaces but passes an embedded `"` through raw, which splits the argument. Such quotes are escaped
# here as \" so the receiving program sees the argument whole.
function Invoke-Native([string]$exe, [string[]]$argv, $stdin = $null) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $mode = Get-Variable -Name PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue
  if ("$mode" -ne "Standard") {
    $argv = @($argv | ForEach-Object { ([string]$_).Replace('"', '\"') })
  }
  try {
    if ($null -ne $stdin) {
      $out = $stdin | & $exe @argv 2>$null | ForEach-Object { "$_" }
    } else {
      $out = & $exe @argv 2>$null | ForEach-Object { "$_" }
    }
    return (@($out) -join "`n")
  } catch {
    return ""
  } finally {
    $ErrorActionPreference = $prev
  }
}

# Runs one of the bash twin's `node -e` snippets, verbatim. The code travels in an environment
# variable rather than on the command line: every host's native-argument quoting mangles a JS
# snippet full of double quotes, whereas `eval(process.env...)` has neither quotes nor spaces.
# process.argv is numbered exactly as under `node -e`, so the snippets need no edits.
function Invoke-Node([string]$snippet, [string[]]$argv, $stdin = $null) {
  $env:JOBSEEKER_NODE_SNIPPET = $snippet
  try {
    return (Invoke-Native $NodeBin (@("-e", "eval(process.env.JOBSEEKER_NODE_SNIPPET)") + $argv) $stdin)
  } finally {
    Remove-Item -Path Env:JOBSEEKER_NODE_SNIPPET -ErrorAction SilentlyContinue
  }
}

# scripts\win\set-schedule.ps1, run in this same host; its output and errors are discarded exactly
# as the bash twin's `>/dev/null 2>&1` does, and a failure never stops the ladder.
function Invoke-SetSchedule([string[]]$argv) {
  $stderr = [Console]::Error
  try {
    [Console]::SetError([System.IO.TextWriter]::Null)
    $out = & $SetSchedule @argv 2>$null
    return (@($out) | ForEach-Object { "$_" })
  } catch {
    return @()
  } finally {
    [Console]::SetError($stderr)
  }
}

function Log-Activity([string]$msg) {
  Invoke-Native $NodeBin @((Join-Path $Repo "server\record.mjs"), "log", "schedule-ladder", $msg) | Out-Null
}

# WinRT toast from Windows PowerShell 5.1. Best-effort only: pwsh, or any host without WinRT, simply
# gets no notification — the ladder's stdout and the dashboard banner carry the same message.
function Show-Toast([string]$Title, [string]$Body) {
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $aumid = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    $esc = { param($s) [System.Security.SecurityElement]::Escape([string]$s) }
    $xmlText = "<toast><visual><binding template=`"ToastGeneric`"><text>$(& $esc $Title)</text><text>$(& $esc $Body)</text></binding></visual></toast>"
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($xmlText)
    $toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
  } catch {
    # no toast on this host; nothing else to do
  }
}

# ---- the ladder itself --------------------------------------------------------------------------

# The cadence the USER chose, written by the wizard as `schedule_days` in the config file. Tier 1 is
# whatever that says — not "every day".
#
# Hardcoding daily here meant the ladder's own Restore button PROMOTED anyone who had asked for less:
# a twice-a-week user pressed "back to normal" and got seven runs a week they never asked for. A
# ladder is allowed to run things less often than you chose. It is not allowed to run them more.
function Baseline-Days {
  $snippet = @'

    const fs=require("fs");
    try{
      const t=fs.readFileSync(process.argv[1],"utf8");
      /* [^\S\n] not \s: \s matches the newline, so an EMPTY value swallows the line break and
         captures whatever follows — which made a blank setting read as "---". */
      const m=/^schedule_days:[^\S\n]*(.*)$/m.exec(t);
      process.stdout.write(m ? m[1].trim() : "");
    }catch{ process.stdout.write(""); }
'@
  $v = Invoke-Node $snippet @((Join-Path $Repo "config\job-seeker.config.md"))
  # "off" is printed through, not turned into an empty string: empty already means "every day" to
  # set-schedule, and the two must not collide — an off baseline that read as every-day let the
  # ladder step an unscheduled install onto Mondays and Thursdays.
  switch ($v) {
    "off"   { return "off" }
    ""      { return "0,1,2,3,4,5,6" }
    default { return $v }
  }
}

# Days present in BOTH lists, in order. An empty baseline means every day, so everything survives.
function Intersect-Days([string]$base, [string]$want) {
  if (-not $base) { return $want }
  $out = @()
  foreach ($d in ($want -split ",")) {
    if ((",$base,").Contains(",$d,")) { $out += $d }
  }
  # An empty intersection means the tier has nothing left to cut — treat it as the last day of the
  # baseline rather than as "no schedule", which is tier 4's job and needs its own warning.
  if ($out.Count -eq 0) { return ($base -split ",")[0] }
  return ($out -join ",")
}

# Tier -> the day list set-schedule understands. Tier 4 has none: it is removal.
#
# Tiers 2 and 3 are INTERSECTED with the baseline, so a step is always a reduction. Without that,
# stepping a Mondays-only user "down" to tier 2 would move them to Mondays AND Thursdays.
function Tier-Days([string]$tier) {
  $base = Baseline-Days
  # Nothing to step down from. Every tier is "not scheduled".
  if ($base -eq "off") { return "" }
  switch ($tier) {
    "1"     { return $base }
    "2"     { return (Intersect-Days $base "1,4") }
    "3"     { return (Intersect-Days $base "1") }
    default { return "" }
  }
}

function Days-Label([string]$days) {
  switch ($days) {
    ""              { return "every day" }
    "0,1,2,3,4,5,6" { return "every day" }
    "1,2,3,4,5"     { return "weekdays" }
    "1,4"           { return "Mondays and Thursdays" }
    "1"             { return "Mondays only" }
    default         { return "on days $days" }
  }
}
function Tier-Label([string]$tier) {
  switch ($tier) {
    { $_ -eq "1" -or $_ -eq "2" -or $_ -eq "3" } {
      if ((Baseline-Days) -eq "off") { return "not scheduled" }
      return (Days-Label (Tier-Days $tier))
    }
    default { return "not scheduled" }
  }
}

# Keep the time the user chose. Re-scheduling must never quietly move the hour as well as the days.
function Current-Time {
  $shown = @(Invoke-SetSchedule @("--show")) | Select-Object -First 1
  if ($shown -and $shown -match "^[0-2][0-9]:[0-5][0-9]") { return ($shown -split " ")[0] }
  return "08:00"
}

function Write-State([string]$tier, [string]$warnedAt, [string]$armedOn, [string]$why) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Repo "data") | Out-Null
  $warned = "null"
  if ($warnedAt) { $warned = "`"$warnedAt`"" }
  $json = "{`n" +
    "  `"tier`": $tier,`n" +
    "  `"warned_at`": $warned,`n" +
    "  `"armed_on`": `"$armedOn`",`n" +
    "  `"changed_at`": `"$Today`",`n" +
    "  `"why`": `"$($why.Replace('"', '\"'))`"`n" +
    "}`n"
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText("$State.tmp", $json, $utf8)
  Move-Item -LiteralPath "$State.tmp" -Destination $State -Force
}

function Read-Field([string]$key) {
  if (-not (Test-Path -LiteralPath $State)) { return "" }
  $snippet = @'

    const fs=require("fs");
    try{ const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const v=d[process.argv[2]]; process.stdout.write(v==null?"":String(v)); }
    catch{ process.stdout.write(""); }
'@
  return (Invoke-Node $snippet @($State, $key))
}

# The verdict comes from server/audit.mjs, which owns the definition of "reviewed" and "active".
# This script decides only what to DO about it.
function Ladder-Json {
  $gaps = Invoke-Native $NodeBin @((Join-Path $Repo "server\audit.mjs"), "--gaps", $Today)
  $snippet = @'
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{ process.stdout.write(JSON.stringify(JSON.parse(s).schedule_ladder||{})); }
        catch{ process.stdout.write("{}"); }})
'@
  $out = Invoke-Node $snippet @() $gaps
  if (-not $out) { return "{}" }
  return $out
}
function Field([string]$json, [string]$key) {
  $snippet = @'

    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{ const v=JSON.parse(s)[process.argv[1]]; process.stdout.write(v==null?"":String(v)); }
      catch{ process.stdout.write(""); }})
'@
  return (Invoke-Node $snippet @($key) $json)
}

# ---- entry points -------------------------------------------------------------------------------

$mode = ""
if ($args.Count -ge 1) { $mode = [string]$args[0] }

switch ($mode) {
  "--reset" {
    $Time = Current-Time
    $Base = Tier-Days "1"
    if ($Base) {
      Invoke-SetSchedule @($Time, $Base) | Out-Null
    } else {
      Invoke-SetSchedule @($Time) | Out-Null
    }
    Write-State "1" "" $Today "Restored to $(Days-Label $Base) by the user"
    Log-Activity "Schedule restored to $(Days-Label $Base) (user)"
    "restored: $(Days-Label $Base) at $Time"
    exit 0
  }
  "--show" {
    $L = Ladder-Json
    "tier $(Field $L 'tier') — $(Field $L 'schedule')"
    "last reviewed roles: $(Field $L 'last_curation')  (dry days: $(Field $L 'dry_days'))"
    "last activity:       $(Field $L 'last_activity')  (idle days: $(Field $L 'idle_days'))"
    "next action:         $(Field $L 'action') $(Field $L 'why')"
    exit 0
  }
}

# ---- arm on first sight, and do nothing else that day -----------------------------------------
$Armed = Read-Field "armed_on"
if (-not $Armed) {
  Write-State "1" "" $Today "Ladder armed; the clock starts today, not from earlier history"
  "schedule ladder armed on $Today (no change; history before today is never counted)"
  exit 0
}

$L = Ladder-Json
$Action = Field $L "action"
$Tier = Field $L "tier"
if (-not $Tier) { $Tier = "1" }
$Next = Field $L "next_tier"
$Why = Field $L "why"
$NextOrTier = $Next
if (-not $NextOrTier) { $NextOrTier = $Tier }

switch ($Action) {
  "warn" {
    # Record only. The dashboard reads .schedule-tier.json and shows the banner; acting this run
    # would mean the user's first sight of the warning is also the day it took effect.
    Write-State $Tier $Today $Armed $Why
    "schedule ladder: WARNING issued — $Why Next run drops to $(Tier-Label $NextOrTier) unless roles are reviewed."
    Log-Activity "Warned: schedule drops to $(Tier-Label $NextOrTier) next run — $Why"
    Show-Toast "JobSeeker is slowing down" "$Why Next run drops to $(Tier-Label $NextOrTier)."
  }
  "step" {
    $Time = Current-Time
    $Days = Tier-Days $Next
    $nextNum = 0
    $isNum = [int]::TryParse($Next, [ref]$nextNum)
    if ((-not $Days) -or ($isNum -and $nextNum -ge 4)) {
      Invoke-SetSchedule @("--remove") | Out-Null
    } else {
      Invoke-SetSchedule @($Time, $Days) | Out-Null
    }
    # warned_at cleared, so the NEXT step needs its own warning. Otherwise one quiet fortnight
    # could walk an install from daily to off without a second word.
    Write-State $Next "" $Armed $Why
    "schedule ladder: now $(Tier-Label $Next) — $Why"
    Log-Activity "Schedule changed to $(Tier-Label $Next) — $Why"
    Show-Toast "JobSeeker schedule changed" "Now running $(Tier-Label $Next). Change it in Settings."
  }
  "offer-restore" {
    "schedule ladder: reviewing has resumed — the dashboard is offering to restore the daily run"
  }
  default {
    "schedule ladder: no change (tier $Tier, $(Field $L 'dry_days') days since roles were reviewed)"
  }
}
exit 0
