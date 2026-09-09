# Reset-JobSeeker.ps1
#
# Puts this PC back to how it was before JobSeeker was ever installed, so the next install is a
# genuine first run. Removes the installed copies, the shortcuts, the scheduled daily run, the
# WhatsApp link and every leftover from testing.
#
# It does NOT touch Node, Git, Chrome or Claude Code: those are ordinary applications you may want
# for other things, and reinstalling them each time proves nothing.
#
#   Right-click > Run with PowerShell, or:  powershell -ExecutionPolicy Bypass -File Reset-JobSeeker.ps1

$ErrorActionPreference = "Continue"

function Say([string]$m) { Write-Host "  $m" }
function Did([string]$m) { Write-Host "  removed " -ForegroundColor DarkGray -NoNewline; Write-Host $m }

Write-Host ""
Write-Host "  Resetting JobSeeker" -ForegroundColor Cyan
Write-Host ""

# ---- 1. stop anything of ours that is running -------------------------------------------------
# Only node: killing Chrome or Edge would take the user's own windows with it.
$stopped = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like "*dashboard.mjs*" -or $_.CommandLine -like "*setup-server.mjs*" -or $_.CommandLine -like "*bridge.mjs*") } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $stopped++ } catch { } }
if ($stopped -gt 0) { Did "$stopped running JobSeeker process(es)" } else { Say "nothing was running" }

# ---- 2. the scheduled daily run, and every task used while testing -----------------------------
schtasks /delete /tn "JobSeeker\JobRun" /f 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { Did "the scheduled daily run" }
foreach ($t in "JSDash", "ChromeStart", "ScratchDash", "Shot", "CShot", "FShot", "ChromeCDP") {
  schtasks /delete /tn $t /f 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Did "scheduled task $t" }
}

# ---- 3. the installed copies -------------------------------------------------------------------
# Everything under these goes, data included. That is the point of a reset.
foreach ($d in "JobSeeker", "JobSeekerTest", "jobseeker") {
  $p = Join-Path $env:USERPROFILE $d
  if (Test-Path -LiteralPath $p) {
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $p) { Write-Host "  COULD NOT REMOVE $p - is something still open in it?" -ForegroundColor Yellow }
    else { Did $p }
  }
}

# ---- 4. shortcuts, WhatsApp link, logs ----------------------------------------------------------
$sm = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\JobSeeker"
if (Test-Path -LiteralPath $sm) { Remove-Item -LiteralPath $sm -Recurse -Force -ErrorAction SilentlyContinue; Did "the Start Menu folder" }
$dsk = Join-Path $env:USERPROFILE "Desktop\JobSeeker.lnk"
if (Test-Path -LiteralPath $dsk) { Remove-Item -LiteralPath $dsk -Force -ErrorAction SilentlyContinue; Did "the Desktop shortcut" }
# ---- 4a. everything WhatsApp leaves behind -----------------------------------------------------
# The link itself is a folder, but the plugin that made it is installed inside Claude Code and its
# marketplace is declared in the user's settings. Leaving those meant the next "fresh" install
# reused a cached marketplace and a half-written credential -- which is how a reset PC reported
# "connected as +971..." to someone who had never received a pairing code.
$wa = Join-Path $env:USERPROFILE ".whatsapp-channel"
if (Test-Path -LiteralPath $wa) { Remove-Item -LiteralPath $wa -Recurse -Force -ErrorAction SilentlyContinue; Did "the WhatsApp link (you will pair again)" }

$claudeExe = @(
  (Join-Path $env:USERPROFILE ".local\bin\claude.exe"),
  (Join-Path $env:APPDATA "npm\claude.cmd")
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $claudeExe) { $claudeExe = (Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source) }
if ($claudeExe) {
  # By name is not safe here: the author renamed the plugin, so a machine may hold either. Ask
  # Claude what it has and remove whatever answers to "whatsapp".
  $installed = ""
  try { $installed = (& $claudeExe plugin list 2>&1 | Out-String) } catch { $installed = "" }
  foreach ($n in @("whatsapp-channel", "whatsapp-claude-channel")) {
    if ($installed -match [Regex]::Escape($n)) {
      & $claudeExe plugin uninstall ($n + "@whatsapp-claude-plugin") 2>&1 | Out-Null
      Did "the $n plugin"
    }
  }
  & $claudeExe plugin marketplace remove whatsapp-claude-plugin 2>&1 | Out-Null
}
# Whatever the CLI could not do, do by hand: a cached clone is what makes the next install think it
# already knows what the marketplace contains.
$mkt = Join-Path $env:USERPROFILE ".claude\plugins\marketplaces\whatsapp-claude-plugin"
if (Test-Path -LiteralPath $mkt) { Remove-Item -LiteralPath $mkt -Recurse -Force -ErrorAction SilentlyContinue; Did "the cached plugin marketplace" }
$pl = Join-Path $env:USERPROFILE ".claude\plugins\repos"
if (Test-Path -LiteralPath $pl) {
  Get-ChildItem -LiteralPath $pl -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*whatsapp*" } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue; Did $_.FullName }
}
$ag = Join-Path $env:USERPROFILE ".claude\agents\jobseeker.md"
if (Test-Path -LiteralPath $ag) { Remove-Item -LiteralPath $ag -Force -ErrorAction SilentlyContinue; Did "the global jobseeker agent" }
$il = Join-Path $env:TEMP "jobseeker-install.log"
if (Test-Path -LiteralPath $il) { Remove-Item -LiteralPath $il -Force -ErrorAction SilentlyContinue; Did "the installer log" }

# ---- 5. the one thing this script cannot do ----------------------------------------------------
Write-Host ""
Write-Host "  One thing left, by hand:" -ForegroundColor Yellow
Write-Host "  Chrome will not let a script remove an extension. Open chrome://extensions and click"
Write-Host "  Remove on JobSeeker Bridge. Its folder has just been deleted, so leaving it there gives"
Write-Host "  you a broken entry and a pairing that can never work."
Write-Host ""
Write-Host "  Done. Run Install-JobSeeker.ps1 for a clean first run." -ForegroundColor Green
Write-Host ""
