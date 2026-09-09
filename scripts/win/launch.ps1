# Opening JobSeeker on Windows. This is what the Start Menu and Desktop shortcuts end up running,
# by way of installer\win\JobSeeker.vbs (which is there only to keep a console window from flashing).
#
# Twin of installer/JobSeeker.js on the Mac, minus the window: JobSeeker.app IS a window, drawn by
# a compiled AppleScript that every Mac already has. Windows has no such thing, so the two halves
# of that app are split -- installer\win\setup-server.mjs draws the first-run window, and after
# setup the app window is Edge or Chrome in --app mode, which is a real chromeless window on the
# machine the user already has.
#
# The order below is the same one JobSeeker.js walks:
#   1. which port                    (config\job-seeker.config.md, default 4319)
#   2. is this a first run?          (the same three tests the dashboard's needsWelcome() uses)
#   3. is our dashboard up already?  (/_whoami, and it must say OUR repo)
#   4. open the window
#
#   powershell -File scripts\win\launch.ps1
#
# Knobs:
#   JOBSEEKER_NO_WINDOW=1   do everything except open the browser window. What the tests use --
#                           step 4 is the one step that needs Edge or Chrome and a desktop, and on
#                           a Mac or a CI box the fallback would otherwise try to open a URL.

$ErrorActionPreference = "Stop"
Set-StrictMode -Off
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$NoWindow = ($env:JOBSEEKER_NO_WINDOW -eq "1")
$OnWindows = ([System.Environment]::OSVersion.Platform -eq "Win32NT")

# -WindowStyle is the whole point of every Start-Process below -- it is what keeps a node console
# from appearing -- but pwsh on macOS/Linux refuses the parameter outright rather than ignoring it,
# and the tests run there. Splatted so the real launch keeps it and a test run simply does without.
$Hidden = @{}
if ($OnWindows) { $Hidden["WindowStyle"] = "Hidden" }

function Write-Err([string]$msg) { [Console]::Error.WriteLine($msg) }

# This script is started by a shortcut, hidden, with no console anyone will ever look at. A failure
# written only to stderr means the user double-clicks JobSeeker and NOTHING happens -- no window, no
# message, nothing to act on. So anything fatal is also shown, in the plainest words available, with
# what to do next. Falls back to stderr if the dialog itself cannot be raised.
function Stop-Visibly([string]$Message) {
  Write-Err $Message
  try {
    $sh = New-Object -ComObject WScript.Shell
    [void]$sh.Popup($Message, 0, "JobSeeker", 0x10)  # 0x10 = the stop icon
  } catch {
    # No shell to raise a dialog with; the stderr line above is all there is.
  }
  exit 1
}

# Join a Windows-style relative path onto a base, splitting on the backslash so the same code also
# runs under pwsh on macOS/Linux, where "\" is not a separator. Same helper, same reason, as
# install.ps1: the tests exercise this script off Windows.
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

function Read-TextOrEmpty([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return "" }
  try { return (Get-Content -LiteralPath $path -Raw) } catch { return "" }
}

function Node-Bin {
  if ($env:NODE_BIN) { return $env:NODE_BIN }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return (Join-Path $env:ProgramFiles "nodejs\node.exe")
}

# ---------------------------------------------------------------- 1. which port
$Config = Sub $Repo "config\job-seeker.config.md"
$Cfg = Read-TextOrEmpty $Config
$Port = "4319"
if ($Cfg -match '(?m)^dashboard_port:[ \t]*(\d+)') { $Port = $Matches[1] }
$Url = "http://127.0.0.1:$Port/"

# ---------------------------------------------------------------- 2. first run?
# The same three tests as installer/JobSeeker.js setupFinished() and the dashboard's needsWelcome(),
# so no two of them can ever disagree about whether this is a first run:
#   * `welcome_done:`  the wizard was finished,
#   * `welcome_left:`  the user walked out of it deliberately,
#   * markets or roles in data\criteria.md -- an install from before the wizard existed, or one set
#     up with /onboard in the terminal. That is the case that matters: an established install has
#     none of the wizard's bookkeeping and must not be dragged back through setup.
function Setup-Finished([string]$cfg) {
  if ($cfg -match '(?m)^welcome_(done|left):[ \t]*\S') { return $true }
  $crit = Read-TextOrEmpty (Sub $Repo "data\criteria.md")
  if ($crit -match '(?m)^markets:[ \t]*\S') { return $true }
  if ($crit -match '(?m)^roles:[ \t]*\S') { return $true }
  return $false
}

if (-not (Setup-Finished $Cfg)) {
  $SetupServer = Sub $Repo "installer\win\setup-server.mjs"
  if (Test-Path -LiteralPath $SetupServer) {
    # It draws and opens its own window, and it is the thing that installs the rest. Nothing below
    # this line applies to a machine that has not been set up yet.
    Start-Process -FilePath (Node-Bin) -ArgumentList "`"$SetupServer`"" -WorkingDirectory $Repo @Hidden
    exit 0
  }
  # No setup server in this build. Fall through: the dashboard serves /welcome itself, which is the
  # same wizard in the same order, just without the installing.
}

# ---------------------------------------------------------------- 3. is ours already up?
# Whether OUR JobSeeker is answering, not merely whether something is. A dashboard left running
# from a different checkout answers identically, and handing the window to it shows the user
# another build entirely -- which reads as "the update did nothing".
function Get-Whoami([string]$port) {   # repo root, "" if it answered but is not a JobSeeker, $null if nothing answered
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/_whoami" -TimeoutSec 2
  } catch {
    return $null
  }
  $txt = "$($r.Content)"
  if ($txt -match '"root"\s*:\s*"((?:[^"\\]|\\.)*)"') {
    # JSON escapes every backslash in a Windows path; put them back before comparing.
    return ($Matches[1] -replace '\\\\', '\' -replace '\\/', '/')
  }
  return ""
}

function Test-AnythingOnPort([string]$port) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Normalize-Path([string]$p) {
  if (-not $p) { return "" }
  try { $p = (Resolve-Path -LiteralPath $p -ErrorAction Stop).ProviderPath } catch { }
  return $p.TrimEnd('\', '/')
}

$Mine = Normalize-Path $Repo
$Who = Get-Whoami $Port

if ($null -ne $Who) {
  if ((Normalize-Path $Who) -ieq $Mine) {
    Write-Host "JobSeeker is already running; opening it."
  } elseif ($Who) {
    Stop-Visibly "JobSeeker is already running from a different folder:`n`n$Who`n`nQuit that one first, then open JobSeeker again."
  } else {
    Stop-Visibly "Another program on this PC is using the connection JobSeeker needs.`n`nClose it and open JobSeeker again. If it keeps happening, open Settings and change the dashboard port."
  }
} else {
  # If the port is taken by something that is not a JobSeeker at all, ours cannot bind and the
  # failure would read as "JobSeeker stopped while starting up". Name the real problem instead.
  if (Test-AnythingOnPort $Port) {
    Stop-Visibly "Another program on this PC is using the connection JobSeeker needs.`n`nClose it and open JobSeeker again. If it keeps happening, open Settings and change the dashboard port."
  }

  $DataDir = Sub $Repo "data"
  $WorkDir = Sub $Repo "data\.setup"
  foreach ($d in @($DataDir, $WorkDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  }
  $OutLog = Sub $Repo "data\.dashboard.log"
  $ErrLog = Sub $Repo "data\.dashboard.err.log"
  $Dashboard = Sub $Repo "server\dashboard.mjs"

  # Separate files for the two streams: Start-Process cannot point both at one file, and Windows
  # PowerShell's own `>>` would write UTF-16, which nothing that reads these logs expects.
  $proc = Start-Process -FilePath (Node-Bin) -ArgumentList "`"$Dashboard`"" -WorkingDirectory $Repo `
    -PassThru -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog @Hidden
  [IO.File]::WriteAllText((Sub $Repo "data\.setup\server.pid"), "$($proc.Id)",
                          (New-Object System.Text.UTF8Encoding($false)))

  # Wait for it to ANSWER, not merely to have been started. A window opened on a connection error
  # is worse than a window opened a second later.
  $deadline = (Get-Date).AddSeconds(20)
  $up = $false
  while ((Get-Date) -lt $deadline) {
    if ($null -ne (Get-Whoami $Port)) { $up = $true; break }
    if ($proc.HasExited) {
      Write-Err "JobSeeker stopped while starting up — see data\.dashboard.err.log"
      exit 1
    }
    Start-Sleep -Milliseconds 400
  }
  if (-not $up) {
    Stop-Visibly "JobSeeker started but did not finish opening.`n`nOpen it again. If it keeps happening, run `"npm run diagnose`" in the JobSeeker folder and send the file it saves to your Downloads."
  }
  Write-Host "JobSeeker is running."
}

# ---------------------------------------------------------------- 4. the window
# --app= gives a chromeless window with no tabs, address bar or bookmarks: as close to a native app
# window as a browser gets, and it is the same trick JobSeeker.app pulls with WKWebView. Edge first
# because it is on every Windows install; Chrome next because JobSeeker needs it anyway for the
# browser agent; a plain Start-Process last, which opens the default browser in an ordinary tab.
#
# The registry lookup mirrors findChromeExe() in scripts\browser\extension.mjs -- App Paths first,
# standard install directories after.
function Find-App([string]$exe, [string[]]$fallbacks) {
  if (Get-Command reg -ErrorAction SilentlyContinue) {
    $key = "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe"
    $r = Invoke-Native "reg" @("query", $key, "/ve")
    # "    (Default)    REG_SZ    C:\Program Files\...\msedge.exe"
    if ($r[0] -eq 0 -and $r[1] -match '(?m)REG_SZ\s+(.+\S)\s*$') {
      $p = $Matches[1].Trim()
      if (Test-Path -LiteralPath $p) { return $p }
    }
  }
  foreach ($p in $fallbacks) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}

if ($NoWindow) {
  Write-Host "not opening a window (JOBSEEKER_NO_WINDOW=1) — JobSeeker is at $Url"
  exit 0
}

$edge = Find-App "msedge.exe" @(
  (Join-Path "${env:ProgramFiles(x86)}" "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path "$env:ProgramFiles" "Microsoft\Edge\Application\msedge.exe"))
$chrome = $null
if (-not $edge) {
  $chrome = Find-App "chrome.exe" @(
    (Join-Path "$env:ProgramFiles" "Google\Chrome\Application\chrome.exe"),
    (Join-Path "${env:ProgramFiles(x86)}" "Google\Chrome\Application\chrome.exe"),
    (Join-Path "$env:LocalAppData" "Google\Chrome\Application\chrome.exe"))
}

if ($edge) {
  Start-Process -FilePath $edge -ArgumentList "--app=$Url" -WorkingDirectory $Repo
} elseif ($chrome) {
  Start-Process -FilePath $chrome -ArgumentList "--app=$Url" -WorkingDirectory $Repo
} else {
  Write-Host "no Edge or Chrome found — opening $Url in your default browser"
  Start-Process $Url
}

# And that is the end of it: closing the window does NOT stop the dashboard.
#
# The Mac app takes its server down with it, because there the app IS the window and quitting it is
# the whole quit story. Windows cannot copy that. The daily run is a Task Scheduler task that fires
# whether or not anyone has a window open, and killing the server when a browser window closes
# would silently break every scheduled run for anybody who tidies up their taskbar. Quitting is
# therefore explicit: the dashboard's own Quit button, or Start Menu > JobSeeker > Quit JobSeeker,
# both of which end up in scripts\win\stop.ps1.
exit 0
