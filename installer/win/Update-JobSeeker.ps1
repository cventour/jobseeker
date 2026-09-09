# Update-JobSeeker.ps1
#
# Pull the latest code over an existing install and open the setup window on the checklist.
#
# For when everything is already installed and connected and you only want the newest build --
# no prerequisites re-checked, no wizard walked through, and nothing in data\ config\ templates\
# touched. The window opens on the list of steps with every row where it stands, so an optional one
# can be revisited: reconnect the Chrome extension, or send a WhatsApp test message.
#
#   Right-click > Run with PowerShell, or:
#     powershell -ExecutionPolicy Bypass -File Update-JobSeeker.ps1

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Branch = "windows-support"
$Home_  = $env:USERPROFILE
$Root   = Join-Path $Home_ "JobSeeker"

function Say([string]$m) { Write-Host "  $m" }
function Did([string]$m) { Write-Host "  " -NoNewline; Write-Host $m -ForegroundColor DarkGray }

Write-Host ""
Write-Host "  Updating JobSeeker from $Branch" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path -LiteralPath (Join-Path $Root "server\dashboard.mjs"))) {
  Write-Host "  There is no JobSeeker at $Root." -ForegroundColor Yellow
  Write-Host "  Run Install-JobSeeker.ps1 instead - this only updates an install that exists."
  Write-Host ""
  exit 1
}

# ---- stop what is running, so files can be replaced -------------------------------------------
# Only ours, and only by what it is running: killing every node would take unrelated work with it.
$stopped = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and (
      $_.CommandLine -like "*dashboard.mjs*" -or
      $_.CommandLine -like "*setup-server.mjs*" -or
      $_.CommandLine -like "*bridge.mjs*")
  } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $stopped++ } catch { } }
if ($stopped -gt 0) { Did "stopped $stopped running JobSeeker process(es)" }

# ---- fetch the branch --------------------------------------------------------------------------
$zipUrl = "https://codeload.github.com/cventour/jobseeker/zip/refs/heads/$Branch"
$tmp    = Join-Path $env:TEMP ("jobseeker-update-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
$zip    = Join-Path $tmp "src.zip"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Say "downloading $Branch"
try {
  Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing
} catch {
  Write-Host ("  Could not download it: " + $_.Exception.Message) -ForegroundColor Yellow
  exit 1
}
Say ("got " + [Math]::Round((Get-Item $zip).Length / 1MB, 1) + " MB")

Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
$src = Get-ChildItem -LiteralPath $tmp -Directory | Where-Object { $_.Name -like "jobseeker-*" } | Select-Object -First 1
if (-not $src) { Write-Host "  The download did not contain what was expected." -ForegroundColor Yellow; exit 1 }
if (-not (Test-Path -LiteralPath (Join-Path $src.FullName "server\dashboard.mjs"))) {
  Write-Host "  The download is missing server\dashboard.mjs; nothing was changed." -ForegroundColor Yellow
  exit 1
}

# ---- copy the code, leave everything of yours alone --------------------------------------------
# data\ is the tracker, config\ is your settings, templates\ may have been edited. Nothing else in
# the folder is yours, so the rest is simply overwritten with what the branch says.
$keep = @("data", "config", "templates")
$n = 0
foreach ($item in Get-ChildItem -LiteralPath $src.FullName -Force) {
  if ($keep -contains $item.Name) { continue }
  $dest = Join-Path $Root $item.Name
  if ($item.PSIsContainer) {
    Copy-Item -LiteralPath $item.FullName -Destination $Root -Recurse -Force
  } else {
    Copy-Item -LiteralPath $item.FullName -Destination $dest -Force
  }
  $n++
}
Did "updated $n item(s) in $Root"
foreach ($k in $keep) { if (Test-Path -LiteralPath (Join-Path $Root $k)) { Say "kept your $k\" } }

try { $v = (Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json).version } catch { $v = "" }
if ($v) { Say "version $v" }
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

# ---- open the setup window on the checklist ----------------------------------------------------
# --stay is what stops it handing straight over to the dashboard on a machine with nothing left to
# install, which is exactly the machine this script is for.
$node = @(
  "$env:ProgramFiles\nodejs\node.exe",
  "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) {
  Write-Host "  Updated, but node was not found to open the window with." -ForegroundColor Yellow
  exit 0
}

Write-Host ""
Say "opening the setup window"
Start-Process -FilePath $node `
  -ArgumentList ('"' + (Join-Path $Root "installer\win\setup-server.mjs") + '" --stay') `
  -WorkingDirectory $Root -WindowStyle Hidden
Write-Host ""
Write-Host "  Done." -ForegroundColor Green
Write-Host "  The window opens on the list of steps. Connect WhatsApp has the new"
Write-Host "  Send test message button once the row is green."
Write-Host ""
