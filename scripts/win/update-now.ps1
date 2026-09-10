# Update a JobSeeker that is too old to update itself.
# macOS twin: scripts/update-now.sh — change both together.
#
#   powershell -ExecutionPolicy Bypass -File update-now.ps1
#   powershell -ExecutionPolicy Bypass -File update-now.ps1 -Target C:\JobSeeker
#   powershell -ExecutionPolicy Bypass -File update-now.ps1 -Check
#
# It exists for the gap that only opens once. Self-updating arrived in v0.7.0, so every install
# older than that has no Update button and no updater to run — and the only advice left was
# "reinstall", which throws away data\, config\ and templates\ or forces someone to move them by
# hand. This is the bridge across that one version: it fetches the updater FROM the release and
# points it at the install that lacks it.
#
# It deliberately does NOT reimplement the update. Downloading, verifying, stopping the server,
# swapping the tree and walking back out of a failure are all difficult and all already written, in
# scripts\win\self-update.ps1. Duplicating any of that here would mean two versions of the risky
# part, and the copy that ran on the oldest installs would be the one nobody ever tested again.

param(
  [string]$Target = "",
  [switch]$Check
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Slug = if ($env:JOBSEEKER_REPO_SLUG) { $env:JOBSEEKER_REPO_SLUG } else { "cventour/jobseeker" }

function Die([string]$m) { Write-Host ""; Write-Error $m; exit 1 }

# Same search as scripts\win\collect-logs.ps1, for the same reason: the person running this was
# sent a file and told to run it, and "cd to the folder first" is the instruction that gets skipped.
function Find-Repo {
  $here = Split-Path -Parent $PSCommandPath
  $cands = @($env:JOBSEEKER_HOME, (Join-Path $here "..\.."), (Join-Path $here ".."), $here, $PWD.Path,
             (Join-Path $env:USERPROFILE "JobSeeker"),
             (Join-Path $env:LOCALAPPDATA "Programs\JobSeeker\app"))
  foreach ($c in $cands) {
    if (-not $c) { continue }
    if ((Test-Path (Join-Path $c "package.json")) -and (Test-Path (Join-Path $c "server\dashboard.mjs"))) {
      return (Resolve-Path $c).Path
    }
  }
  return $null
}

if ($Target) {
  if (-not (Test-Path (Join-Path $Target "package.json"))) { Die "No JobSeeker install at $Target" }
  $Repo = (Resolve-Path $Target).Path
} else {
  $Repo = Find-Repo
  if (-not $Repo) { Die "Could not find JobSeeker. Run this again with the folder:`n  update-now.ps1 -Target C:\JobSeeker" }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Die "Node is not installed. JobSeeker needs it - install it from https://nodejs.org and run this again." }

$have = & $node -p "require('$($Repo -replace '\\','/')/package.json').version" 2>$null
if (-not $have) { Die "There is a folder at $Repo but its package.json cannot be read." }

Write-Host "JobSeeker at $($Repo.Replace($env:USERPROFILE,'~'))"
Write-Host "installed:   $have"

# ---- what is the newest release -------------------------------------------------------------
try {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Slug/releases/latest" -TimeoutSec 20 `
                           -Headers @{ "User-Agent" = "jobseeker-update-now" }
  $tag = $rel.tag_name
} catch { $tag = $null }
if (-not $tag) { Die "Could not reach GitHub to find the newest version. Check the connection and try again." }
Write-Host "newest:      $($tag -replace '^v','')"

# Numeric compare - as text, 0.10.0 sorts below 0.9.0, and 0.10.0 is the release nobody would be
# offered. Same rule as compareVersions() in server/update.mjs.
function Test-Newer([string]$a, [string]$b) {
  $pa = ($a -replace '^v','') -split '[.\-+]' | ForEach-Object { if ($_ -match '^\d+$') { [int]$_ } else { -1 } }
  $pb = ($b -replace '^v','') -split '[.\-+]' | ForEach-Object { if ($_ -match '^\d+$') { [int]$_ } else { -1 } }
  for ($i = 0; $i -lt [Math]::Max($pa.Count, $pb.Count); $i++) {
    $x = if ($i -lt $pa.Count) { $pa[$i] } else { 0 }
    $y = if ($i -lt $pb.Count) { $pb[$i] } else { 0 }
    if ($x -ne $y) { return ($x -gt $y) }
  }
  return $false
}

if (-not (Test-Newer $tag $have)) {
  Write-Host ""
  Write-Host "Already up to date. Nothing to do."
  exit 0
}

if ($Check) {
  Write-Host ""
  Write-Host "An update to $($tag -replace '^v','') is available. Run this again without -Check to install it."
  exit 0
}

# ---- hand over to the real updater --------------------------------------------------------------
# From the release, not from main: an install should only ever land on a version someone decided to
# publish. If the install already has its own updater, that one is used and this script is a no-op
# wrapper - which is the right outcome, because from v0.7.0 onwards the Update button in Settings
# does this without anyone running a script at all.
Write-Host ""
$own = Join-Path $Repo "scripts\win\self-update.ps1"
if (Test-Path $own) {
  Write-Host "This install can already update itself - using its own updater."
  $updater = $own
  Remove-Item Env:\JOBSEEKER_REPO -ErrorAction SilentlyContinue
} else {
  Write-Host "Fetching the updater from $tag..."
  $tmp = Join-Path $env:TEMP ("jobseeker-bootstrap-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $url = "https://raw.githubusercontent.com/$Slug/$tag/scripts/win/self-update.ps1"
  $updater = Join-Path $tmp "self-update.ps1"
  try {
    Invoke-WebRequest -Uri $url -OutFile $updater -TimeoutSec 60 -UseBasicParsing
  } catch { Die "Could not download the updater from $url" }
  # It must be the script we asked for. A proxy or captive portal that answers every request with
  # an HTML login page would otherwise be run as PowerShell.
  $body = Get-Content -Raw -LiteralPath $updater
  if ($body -notmatch 'JOBSEEKER_UPDATE_STAGE') {
    Die "The downloaded updater is not the one this script knows how to drive."
  }
  $env:JOBSEEKER_REPO = $Repo
}

Write-Host "Updating $have -> $($tag -replace '^v',''). Your CV, settings and tracker are left alone."
Write-Host ""
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $updater -Tag $tag
$rc = $LASTEXITCODE

# self-update detaches and reports through data\.setup\update.json, so a zero here means "started
# cleanly", not "finished". Say that rather than implying more than was observed.
if ($rc -ne 0) { Die "The updater exited $rc. See $Repo\data\.setup\update.log" }

Write-Host "Update started. It takes a few seconds, and JobSeeker reopens itself when it is done."
Write-Host "If anything goes wrong it is written to $Repo\data\.setup\update.log,"
Write-Host "and the old version is put back."
