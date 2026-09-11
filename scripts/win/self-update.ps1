# Replace this install with a newer release, and start it again.
#
#   powershell -File scripts\win\self-update.ps1 v0.7.0     the dashboard's Update button
#   powershell -File scripts\win\self-update.ps1 -Check     download and verify only, change nothing
#
# Twin of scripts/self-update.sh. Same order, same guarantees, same keep-lists -- change both.
#
# THE ORDER IS THE DESIGN. Everything that can plausibly fail happens BEFORE anything is stopped or
# replaced, so the ordinary failure is reported to a dashboard that is still running with the
# install untouched.
#
# Three things differ from the Mac, and all are Windows facts rather than choices:
#   * The stage-1 copy is NOT about the parser. PowerShell reads the whole file into an AST before
#     it runs a line, so it cannot be rewritten under itself the way bash can. It moves out because
#     Windows refuses to remove a directory that is any process's current directory, and the server
#     spawns this with the repo as its cwd -- the swap would fail half way with "being used by
#     another process".
#   * There is no app bundle to rebuild and no window to reopen: the window is the user's own
#     browser in --app mode, and scripts\win\launch.ps1 brings the server back without touching it.
#   * launch.ps1 is started, not piped. Its Start-Process with redirected logs hands the new server
#     every inheritable handle it holds, including a pipe we would be reading its output through, so
#     that read would not end until the server did -- see "start it again". The Mac `open`s the app,
#     which returns at once and passes nothing down, so scripts/self-update.sh needs no matching change.

param(
  [string]$Tag = "",
  [switch]$Check
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Off
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------- stage 1: get out of the tree
if (-not $env:JOBSEEKER_UPDATE_STAGE) {
  # Normally the install is the one this script lives in. JOBSEEKER_REPO overrides that, which is
  # what lets a NEWER copy of this script update an OLDER install that never shipped one --
  # see scripts\win\update-now.ps1. Without the override a downloaded copy would update the
  # throwaway directory it was downloaded into and report success.
  $repo = if ($env:JOBSEEKER_REPO) { $env:JOBSEEKER_REPO } else { Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
  if (-not (Test-Path (Join-Path $repo "package.json"))) {
    Write-Error "no JobSeeker install at $repo"; exit 1
  }
  $tmp = Join-Path $env:TEMP ("jobseeker-updater-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $tmp "self-update.ps1") -Force
  $env:JOBSEEKER_UPDATE_STAGE = "2"
  $env:JOBSEEKER_REPO = $repo
  $env:JOBSEEKER_UPDATER_TMP = $tmp
  $argv = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $tmp "self-update.ps1"))
  if ($Tag) { $argv += @("-Tag", $Tag) }
  if ($Check) { $argv += "-Check" }
  Start-Process -FilePath "powershell.exe" -ArgumentList $argv -WorkingDirectory $env:TEMP -WindowStyle Hidden
  exit 0
}

$Repo = $env:JOBSEEKER_REPO
$Data = Join-Path $Repo "data"
$Work = Join-Path $Data ".setup"
$StatusFile = Join-Path $Work "update.json"
$LogFile = Join-Path $Work "update.log"
$Broken = Join-Path $Work "update.broken"
$LockFile = Join-Path $Work "update.lock"
$Slug = if ($env:JOBSEEKER_REPO_SLUG) { $env:JOBSEEKER_REPO_SLUG } else { "cventour/jobseeker" }

New-Item -ItemType Directory -Force -Path $Work | Out-Null

function Say([string]$m) {
  $line = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") + "  " + $m
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
}

# Native command with stderr swallowed -> @(exitCode, stdout). Windows PowerShell 5.1 turns
# redirected stderr into terminating errors under $ErrorActionPreference = Stop. Same helper, same
# reason, as scripts\win\stop.ps1.
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

$FromV = ""
try { $FromV = (Get-Content -Raw -LiteralPath (Join-Path $Repo "package.json") | ConvertFrom-Json).version } catch { }
# Recorded BEFORE the swap: afterwards the old manifest is gone, and this is the only way to know
# whether the extension's code actually changed and Chrome needs reloading.
$ExtFrom = ""
try { $ExtFrom = (Get-Content -Raw -LiteralPath (Join-Path $Repo "extension\manifest.json") | ConvertFrom-Json).version } catch { }
$script:RolledBack = $false

function Set-Status([string]$phase, [int]$pct, [string]$err = "") {
  $o = [ordered]@{
    phase = $phase; pct = $pct; from = $FromV; to = ($Tag -replace '^v', ''); tag = $Tag
    ok = ($phase -eq "done"); rolledBack = $script:RolledBack; error = $err; extFrom = $ExtFrom
    updatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  try {
    ($o | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath "$StatusFile.tmp" -Encoding UTF8
    Move-Item -LiteralPath "$StatusFile.tmp" -Destination $StatusFile -Force
  } catch { }
}

function Fail([string]$m) { Say ("FAILED: " + $m); Set-Status "failed" $script:Pct $m; Cleanup; exit 1 }
$script:Pct = 0
$script:Stage = ""

function Cleanup {
  try { Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue } catch { }
  # $Stage\old holds the ONLY copy of what has been moved out. Keep it while the swap is unfinished.
  if ($script:Stage -and (Test-Path -LiteralPath $script:Stage)) {
    if (Test-Path -LiteralPath $Broken) { Say ("leaving " + $script:Stage + " in place: the swap did not finish") }
    else { Remove-Item -LiteralPath $script:Stage -Recurse -Force -ErrorAction SilentlyContinue }
  }
  if ($env:JOBSEEKER_UPDATER_TMP) {
    Remove-Item -LiteralPath $env:JOBSEEKER_UPDATER_TMP -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------- one at a time
if (Test-Path -LiteralPath $LockFile) {
  $other = (Get-Content -Raw -LiteralPath $LockFile -ErrorAction SilentlyContinue) -as [int]
  if ($other -and (Get-Process -Id $other -ErrorAction SilentlyContinue)) {
    Say "another update ($other) is already running"; exit 3
  }
}
Set-Content -LiteralPath $LockFile -Value $PID -Encoding ASCII

Say ("--- self-update " + $(if ($Tag) { $Tag } else { "latest" }) + " (from " + $FromV + ") ---")
Set-Status "preparing" 2

# ---------------------------------------------------------------- a developer's checkout
if ((Test-Path -LiteralPath (Join-Path $Repo ".git")) -and $env:JOBSEEKER_UPDATE_FORCE -ne "1") {
  Say "refused: $Repo is a git checkout"
  Set-Status "refused" 0 "This copy is a git checkout - update it with git pull."
  Cleanup; exit 2
}

# ---------------------------------------------------------------- which release
if (-not $Tag) {
  Say "asking github for the latest release"
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Slug/releases/latest" -UseBasicParsing -TimeoutSec 20
    $Tag = "$($rel.tag_name)"
  } catch { }
}
if ($Tag -notmatch '^v\d+\.\d+\.\d+$') { Fail ("no usable release tag (got '" + $Tag + "')") }
$NewV = $Tag -replace '^v', ''
Say "target $Tag"
if ($FromV -eq $NewV -and $env:JOBSEEKER_UPDATE_FORCE -ne "1") { Fail ("already on " + $NewV) }

# ---------------------------------------------------------------- fetch and check, changing nothing
# A SIBLING of the install, so every move below is a rename on one volume. %TEMP% can be another
# drive, where Move-Item silently degrades into a copy -- which is the slow, interruptible thing
# this whole design exists to avoid.
$script:Stage = Join-Path (Split-Path -Parent $Repo) (".jobseeker-update-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $script:Stage | Out-Null

$script:Pct = 15; Set-Status "downloading" 15
$zip = Join-Path $script:Stage "src.zip"
$url = if ($env:JOBSEEKER_URL) { $env:JOBSEEKER_URL } else { "https://codeload.github.com/$Slug/zip/refs/tags/$Tag" }
Say "downloading $url"
# A local archive is copied rather than fetched. PowerShell 7 refuses the file: scheme outright
# (5.1 allows it), so a test that hands this a local zip would fail on the runner and not on a
# user's machine -- which is the wrong way round for a test to behave.
$localSrc = ""
if ($url -match '^file://(.+)$') { $localSrc = $Matches[1] } elseif ($url -notmatch '^https?://') { $localSrc = $url }
if ($localSrc) {
  if (-not (Test-Path -LiteralPath $localSrc)) { Fail ("no archive at " + $localSrc) }
  Copy-Item -LiteralPath $localSrc -Destination $zip -Force
} else {
  try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing } catch { Fail ("could not download " + $Tag + " - check your internet connection") }
}
$size = (Get-Item -LiteralPath $zip).Length
if ($size -lt 50000) { Fail ("the download looks wrong (" + $size + " bytes)") }
Say ("downloaded " + [Math]::Round($size / 1KB) + " KB")

$script:Pct = 30; Set-Status "verifying" 30
$unz = Join-Path $script:Stage "unz"
try { Expand-Archive -LiteralPath $zip -DestinationPath $unz -Force } catch { Fail "could not unpack the download" }
# GitHub wraps the tree in one <repo>-<ref> folder.
$top = @(Get-ChildItem -LiteralPath $unz -Force)
$src = if ($top.Count -eq 1 -and $top[0].PSIsContainer) { $top[0].FullName } else { $unz }

foreach ($must in @("server\dashboard.mjs", "package.json", "installer\ui.html", "scripts", "public")) {
  if (-not (Test-Path -LiteralPath (Join-Path $src $must))) { Fail ("the download is missing " + $must) }
}
$count = @(Get-ChildItem -LiteralPath $src -Recurse -File -Force).Count
if ($count -lt 120) { Fail ("the download has only " + $count + " files - it looks truncated") }

$gotV = ""
try { $gotV = (Get-Content -Raw -LiteralPath (Join-Path $src "package.json") | ConvertFrom-Json).version } catch { }
if ($gotV -ne $NewV) { Fail ($Tag + " contains version " + $gotV + ", not " + $NewV) }
Say ("verified " + $Tag + " (" + $count + " files)")

if ($Check) { Say "-Check: stopping before anything is changed"; Set-Status "checked" 100; Cleanup; exit 0 }

# ---------------------------------------------------------------- stop what is running
# stop.ps1, not POST /quit: it is the one place that knows how to tell OUR dashboard from a stranger
# holding a reused pid, and it is still readable because nothing has been replaced yet.
$script:Pct = 45; Set-Status "stopping" 45
Say "stopping the dashboard"
# What stop.ps1 found goes in the log, not to Out-Null. "Stopped JobSeeker (pid 1234)" and
# "JobSeeker was not running" are the difference between a failure that can be read and one that
# cannot -- which is exactly what the silent stop step cost on the Mac.
#
# The install's own copy, falling back to the verified download: updating an install old enough to
# predate stop.ps1 must not leave the server running.
$stopper = Join-Path $Repo "scripts\win\stop.ps1"
if (-not (Test-Path -LiteralPath $stopper)) { $stopper = Join-Path $src "scripts\win\stop.ps1" }
if (Test-Path -LiteralPath $stopper) {
  try {
    $r = Invoke-Native "powershell.exe" @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $stopper)
    foreach ($line in ("$($r[1])" -split "`n")) { if ("$line".Trim()) { Say ("stop: " + "$line".Trim()) } }
    if ($r[0] -ne 0) { Say "the stop script reported it could not" }
  } catch { Say ("the stop script failed: " + $_.Exception.Message) }
} else {
  Say "WARNING: no stop.ps1 in this install or in the download; the server was not stopped"
}

$port = 4319
try {
  $cfg = Get-Content -Raw -LiteralPath (Join-Path $Repo "config\job-seeker.config.md") -ErrorAction SilentlyContinue
  if ($cfg -match '(?m)^dashboard_port:\s*(\d+)') { $port = [int]$Matches[1] }
} catch { }
# "Still up" means OUR install is still answering — /_whoami names the root it serves, so another
# JobSeeker holding the port is not a reason to refuse.
#
# Every spelling of this install's path is accepted. The dashboard reports its root as Node
# resolved it, which is not always the string this script was handed: a different letter case, a
# junction or a subst'd drive all give the same folder two true names, and JSON escapes every
# backslash in it. Matching one literal spelling would make a running dashboard invisible here --
# worse than the failure this check exists to catch, because the swap would then go ahead
# underneath a live server. (Its macOS twin resolves /var vs /private/var for the same reason.)
$RepoNames = @($Repo)
try {
  $full = [IO.Path]::GetFullPath($Repo)
  if ($RepoNames -notcontains $full) { $RepoNames += $full }
  $resolved = (Get-Item -LiteralPath $Repo -Force -ErrorAction SilentlyContinue)
  if ($resolved -and $resolved.Target -and $RepoNames -notcontains $resolved.Target) { $RepoNames += $resolved.Target }
} catch { }
function Ours-Is-Up {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/_whoami" -TimeoutSec 1 -UseBasicParsing
    $body = "$($r.Content)"
    foreach ($name in $RepoNames) {
      # As it appears in JSON: every backslash doubled.
      $asJson = '"root":"' + ($name -replace '\\', '\\') + '"'
      if ($body.IndexOf($asJson, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
  } catch { return $false }
}
for ($i = 0; $i -lt 10; $i++) {
  if (-not (Ours-Is-Up)) { break }
  Start-Sleep -Seconds 1
}

# Who is listening on the port, and on what command line. Used twice below: to escalate, and to
# name the holder if it survives that.
function Get-PortHolders([int]$p) {
  $ids = @()
  try {
    foreach ($c in @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)) {
      if ($c.OwningProcess -and $ids -notcontains [int]$c.OwningProcess) { $ids += [int]$c.OwningProcess }
    }
  } catch { }
  return $ids
}
function Describe-Proc([int]$procId) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
    if ($p) { return "$($p.Name) $($p.CommandLine)" }
  } catch { }
  return "unknown"
}

# Last resort: ask the PORT who is holding it. stop.ps1 looks for a node whose command line names
# this repo's dashboard, which is every ordinary case; this covers the one it cannot see -- a
# dashboard launched in some way that does not put the path on its command line, but which
# /_whoami has just told us is serving THIS root.
if (Ours-Is-Up) {
  foreach ($procId in (Get-PortHolders $port)) {
    if ($procId -eq $PID) { continue }
    Say ("port " + $port + " is held by pid " + $procId + ": " + (Describe-Proc $procId))
    try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { Say ("could not stop pid " + $procId + ": " + $_.Exception.Message) }
  }
  for ($i = 0; $i -lt 5; $i++) {
    if (-not (Ours-Is-Up)) { break }
    Start-Sleep -Seconds 1
  }
}

if (Ours-Is-Up) {
  # Name whoever is holding it. "Still answering", with nothing else to go on, is a bug report that
  # cannot be answered; the command line is the answer.
  $who = @(Get-PortHolders $port)
  $extra = ""
  if ($who.Count -gt 0) {
    Say ("still held by pid " + $who[0] + ": " + (Describe-Proc $who[0]))
    $extra = " (process " + $who[0] + ")"
  }
  Fail ("the dashboard is still answering on port " + $port + $extra + " - nothing was changed")
}

# ---------------------------------------------------------------- the swap
$script:Pct = 60
New-Item -ItemType File -Force -Path $Broken | Out-Null
Set-Status "swapping" 60
$old = Join-Path $script:Stage "old"
New-Item -ItemType Directory -Force -Path $old | Out-Null
$moves = New-Object System.Collections.ArrayList

$KeepWhole = @(".git", "node_modules", ".data", ".jobseeker.json", ".DS_Store")
$KeepMixed = @("data", "config", "templates", ".claude")

function Move-Retry([string]$from, [string]$to) {
  # Defender and the search indexer take brief handles on files that have just appeared.
  for ($i = 0; $i -lt 3; $i++) {
    try { Move-Item -LiteralPath $from -Destination $to -Force; return $true } catch { Start-Sleep -Milliseconds 300 }
  }
  return $false
}
function Record($from, $to) { [void]$moves.Add(@($from, $to)) }
function Rollback {
  Say "rolling back"
  for ($i = $moves.Count - 1; $i -ge 0; $i--) {
    $m = $moves[$i]
    if (Test-Path -LiteralPath $m[1]) { Move-Item -LiteralPath $m[1] -Destination $m[0] -Force -ErrorAction SilentlyContinue }
  }
  $script:RolledBack = $true
  Remove-Item -LiteralPath $Broken -Force -ErrorAction SilentlyContinue
}
function Swap-In([string]$from, [string]$to, [string]$rel) {
  if (Test-Path -LiteralPath $to) {
    $dest = Join-Path $old $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    if (-not (Move-Retry $to $dest)) { return $false }
    Record $to $dest
  }
  if (-not (Move-Retry $from $to)) { return $false }
  Record $from $to
  return $true
}

# What the archive holds, recorded BEFORE anything moves — the move-in pass empties $src, so a
# deletion pass reading it afterwards would sweep the whole new version straight back out.
$archNames = @(Get-ChildItem -LiteralPath $src -Force | ForEach-Object { $_.Name })

foreach ($e in @(Get-ChildItem -LiteralPath $Repo -Force)) {
  if ($KeepWhole -contains $e.Name -or $KeepMixed -contains $e.Name) { continue }
  if ($archNames -contains $e.Name) { continue }
  $dest = Join-Path $old $e.Name
  if (Move-Retry $e.FullName $dest) { Record $e.FullName $dest; Say ("removed " + $e.Name + " (gone upstream)") }
}

foreach ($e in @(Get-ChildItem -LiteralPath $src -Force)) {
  if ($KeepWhole -contains $e.Name -or $KeepMixed -contains $e.Name) { continue }
  if (-not (Swap-In $e.FullName (Join-Path $Repo $e.Name) $e.Name)) { Rollback; Fail ("could not replace " + $e.Name) }
}

# Mixed directories: replace only what the archive actually contains inside them. .gitignore keeps
# the user's files out of the archive, so this refreshes data\.example, the .example configs and the
# agent playbooks without ever touching a CV or someone's local Claude settings.
foreach ($k in $KeepMixed) {
  $ksrc = Join-Path $src $k
  if (-not (Test-Path -LiteralPath $ksrc)) { continue }
  New-Item -ItemType Directory -Force -Path (Join-Path $Repo $k) | Out-Null
  foreach ($e in @(Get-ChildItem -LiteralPath $ksrc -Force)) {
    $rel = Join-Path $k $e.Name
    if (-not (Swap-In $e.FullName (Join-Path $Repo $rel) $rel)) { Rollback; Fail ("could not replace " + $rel) }
  }
}

Remove-Item -LiteralPath $Broken -Force -ErrorAction SilentlyContinue
Say ("swapped in " + $Tag)

# ---------------------------------------------------------------- start it again
# Shortcuts are idempotent and point at a path that has not changed; repairing a deleted one is a
# bonus, and never a reason to fail an update.
try {
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Repo "scripts\win\make-shortcuts.ps1") 2>$null | Out-Null
} catch { }

$script:Pct = 90; Set-Status "restarting" 90
if ($env:JOBSEEKER_NO_LAUNCH -ne "1") {
  # NO_WINDOW: the user's --app window is still open and reloads itself once the server answers.
  # Opening another would leave a dead window beside a live one, which reads as a bug.
  $env:JOBSEEKER_NO_WINDOW = "1"
  Say "starting the dashboard again"
  # Started, never piped. `& powershell ... | Out-Null` reads launch.ps1's output through a pipe, and
  # launch.ps1 starts node with redirected logs, which on Windows PowerShell 5.1 is a CreateProcess
  # that hands the server every inheritable handle -- that pipe included. The read then waits for
  # the SERVER to exit: this sat at "restarting" for as long as the new dashboard ran, never said
  # done, and left update.lock naming a live pid, so the next update was refused as already running.
  #
  # Not -Wait either: in 5.1 that waits for the whole process tree, which is the server again. And
  # bounded, because a failing launch.ps1 raises a dialog that waits for a click. The poll below,
  # not this, is what decides whether the update worked.
  try {
    $launcher = Start-Process -FilePath "powershell.exe" -PassThru -WindowStyle Hidden -ArgumentList @(
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "`"$(Join-Path $Repo "scripts\win\launch.ps1")`"")
    if ($launcher.WaitForExit(30000)) { Say ("launch.ps1 exited " + $launcher.ExitCode) }
    else { Say "launch.ps1 is still running after 30s" }
  } catch { Say ("could not start launch.ps1: " + $_.Exception.Message) }

  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/_whoami" -TimeoutSec 1 -UseBasicParsing
      if ("$($r.Content)" -match '"version"\s*:\s*"' + [regex]::Escape($NewV) + '"') {
        Set-Status "done" 100; Say ("updated to " + $NewV); Cleanup; exit 0
      }
    } catch { }
    Start-Sleep -Seconds 1
  }
  Set-Status "failed" 95 ("updated to " + $NewV + " but the dashboard did not come back - open JobSeeker from the Start Menu")
  Say "did not see the dashboard come back"
  Cleanup; exit 1
}

Set-Status "done" 100
Say ("updated to " + $NewV + " (no relaunch: JOBSEEKER_NO_LAUNCH)")
Cleanup
exit 0
