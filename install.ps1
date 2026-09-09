# JobSeeker installer for Windows.  irm https://myjobseeker.ai/install.ps1 | iex
#
# Read this before you run it. It is short on purpose, and this is the file you are trusting.
#
# What it does:
#   1. Downloads the JobSeeker source from github.com/cventour/jobseeker into %USERPROFILE%\JobSeeker
#   2. Makes sure Node is there (the setup window is drawn by Node, so it is the one thing that
#      cannot wait), from winget if you have it, else the signed installer from nodejs.org
#   3. Puts a JobSeeker shortcut in your Start Menu and on your Desktop
#   4. Opens JobSeeker, which walks you through the rest in a window
#
# What it does NOT do:
#   * Run as administrator. It refuses to, in fact -- an elevated install lands in the wrong
#     profile. The only time Windows asks for permission is if Node has to be installed from the
#     MSI, and Windows does that asking (the UAC prompt) -- this script never sees a password.
#   * Install Chrome or Claude Code. The window does that, after showing you what and from where.
#   * Touch anything outside %USERPROFILE%\JobSeeker, your Start Menu folder and your Desktop.
#
# Why an install command and not a download:
#   Windows marks files a BROWSER downloaded as "from the internet" and SmartScreen then refuses to
#   run them until you click through a warning. Nothing here is downloaded by a browser, and there
#   is no .exe to run -- the source is unpacked and started with Node -- so there is nothing to
#   warn about. This is not a way around Windows security; it is simply not the path that triggers it.
#
# Re-running this is safe. It updates in place and keeps your data.
#
# Knobs (environment variables, because a script piped into iex has no parameters of its own):
#   JOBSEEKER_URL             where to fetch the source zip; a file:///C:/path/src.zip works too
#   JOBSEEKER_HOME            where to install                (default %USERPROFILE%\JobSeeker)
#   JOBSEEKER_NO_LAUNCH=1     install, but do not open the window afterwards
#   JOBSEEKER_SKIP_PREREQS=1  do not check for or install Node
#   JOBSEEKER_DRY_RUN=1       print what would happen, change nothing
#   JOBSEEKER_ALLOW_ELEVATED=1     let it run from an administrator prompt (you asked for it)
#   JOBSEEKER_ALLOW_NONWINDOWS=1   TEST ONLY: skip the Windows check so the download/unpack/update
#                                  path can be exercised from a Mac or Linux CI box with pwsh

# Everything this script prints also goes to a file. An install that fails in a window the user
# then closes leaves nothing to look at, and "it did not work" is not something anyone can act on.
$JobSeekerInstallLog = Join-Path $env:TEMP "jobseeker-install.log"
try { Start-Transcript -Path $JobSeekerInstallLog -Force | Out-Null } catch { }

$ErrorActionPreference = "Stop"
Set-StrictMode -Off

# ---------------------------------------------------------------- settings
$RepoUrl = "https://codeload.github.com/cventour/jobseeker/zip/refs/heads/main"
if ($env:JOBSEEKER_URL) { $RepoUrl = $env:JOBSEEKER_URL }
$ProfileDir = $env:USERPROFILE
if (-not $ProfileDir) { $ProfileDir = $HOME }
$HomeDir = Join-Path $ProfileDir "JobSeeker"
if ($env:JOBSEEKER_HOME) { $HomeDir = $env:JOBSEEKER_HOME }
$NoLaunch = ($env:JOBSEEKER_NO_LAUNCH -eq "1")
$SkipPrereqs = ($env:JOBSEEKER_SKIP_PREREQS -eq "1")
$DryRun = ($env:JOBSEEKER_DRY_RUN -eq "1")
$AllowElevated = ($env:JOBSEEKER_ALLOW_ELEVATED -eq "1")
$AllowNonWindows = ($env:JOBSEEKER_ALLOW_NONWINDOWS -eq "1")

$IsWin = ([System.Environment]::OSVersion.Platform -eq "Win32NT")

# ---------------------------------------------------------------- output
# Write-Host throughout: this runs inside iex, and anything sent down the pipeline would be
# "output" of the install command, not a message to the person reading it.
function Step([string]$msg) { Write-Host "  -> " -ForegroundColor DarkGray -NoNewline; Write-Host $msg }
function Ok([string]$msg)   { Write-Host "  ok " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Note([string]$msg) { Write-Host "     $msg" -ForegroundColor DarkGray }
function Plan([string]$msg) { Write-Host "  would " -ForegroundColor Cyan -NoNewline; Write-Host $msg }
# `exit` inside iex would close the user's PowerShell window with the error still unread, so a
# failure is a throw that Main's caller turns into a red line and, when run as a file, an exit code.
function Die([string]$msg)  { throw "JOBSEEKER_DIE: $msg" }

# Join a Windows-style relative path onto a base. Split on the backslash so the same code also
# runs under pwsh on macOS/Linux, where "\" is not a separator (that is what the dry run and the
# CI update test use).
# Two paths naming the same folder, comparably: Windows is case-insensitive and does not care about
# a trailing separator, but string equality does.
function Normalize-Path([string]$p) {
  if (-not $p) { return "" }
  try { $p = [IO.Path]::GetFullPath($p) } catch { }
  return $p.TrimEnd('\', '/')
}

# Is a JobSeeker from THIS folder answering? If so, offer to close it before its code is replaced.
# Answering on 127.0.0.1 and not localhost: the dashboard binds the IPv4 loopback only, and on
# Windows localhost resolves to ::1 first, which would time out and report nothing was running.
function Stop-RunningJobSeeker([string]$Target) {
  $port = 4319
  $cfg = Join-Path $Target "config\job-seeker.config.md"
  if (Test-Path -LiteralPath $cfg) {
    $m = [regex]::Match((Get-Content -LiteralPath $cfg -Raw), '(?m)^dashboard_port:\s*(\d+)')
    if ($m.Success) { $port = [int]$m.Groups[1].Value }
  }
  $who = ""
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/_whoami" -f $port) -TimeoutSec 3
    $who = ($r.Content | ConvertFrom-Json).root
  } catch { return }
  if (-not $who) { return }
  if ((Normalize-Path $who) -ine (Normalize-Path $Target)) {
    Write-Host ""
    Write-Host "  Another JobSeeker is running from $who." -ForegroundColor Yellow
    Write-Host "  Leaving it alone; this install will not touch it."
    return
  }

  Write-Host ""
  Write-Host "  JobSeeker is running." -ForegroundColor Yellow
  Write-Host "  It is running the version about to be replaced, so it needs to close for the update"
  Write-Host "  to take effect. Nothing you have saved is affected."
  $answer = "y"
  if (-not [Console]::IsInputRedirected -and $env:JOBSEEKER_YES -ne "1") {
    $answer = Read-Host "  Close JobSeeker now? [Y/n]"
    if (-not $answer) { $answer = "y" }
  }
  if ($answer -notmatch '^(y|yes)$') {
    Write-Host "  Leaving it running. Quit it yourself and run this again to finish the update." -ForegroundColor Yellow
    Die "update stopped so JobSeeker could stay running."
  }
  # Identified by the port it is actually serving, not by its command line: it is usually started
  # from inside its own folder, so the path never appears in the arguments and matching on one finds
  # nothing. We have already asked that port who it is and been told it is this install, so whatever
  # holds it is the right process.
  $stopped = 0
  try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    foreach ($c in $conns) {
      try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop; $stopped++ } catch { }
    }
  } catch {
    # No Get-NetTCPConnection on very old builds; fall back to the command line, which is right
    # whenever the dashboard was started with a full path.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*dashboard.mjs*" } |
      ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $stopped++ } catch { }
      }
  }
  Start-Sleep -Milliseconds 700
  if ($stopped -gt 0) { Ok "closed JobSeeker" } else { Write-Host "  Could not find its process; carrying on." }
}

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

function NodeMajor {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return 0 }
  $r = Invoke-Native $cmd.Source @("--version")
  if ($r[0] -eq 0 -and $r[1] -match '^v(\d+)') { return [int]$Matches[1] }
  return 0
}

function IsElevated {
  if (-not $IsWin) { return $false }
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

# The Path this session started with does not know about a Node that was installed a moment ago.
function Refresh-Path {
  if (-not $IsWin) { return }
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Download([string]$url, [string]$dest) {
  $uri = [Uri]$url
  if ($uri.Scheme -eq "file") {
    Copy-Item -LiteralPath $uri.LocalPath -Destination $dest -Force
    return
  }
  $prevProgress = $ProgressPreference
  $ProgressPreference = "SilentlyContinue"   # 5.1 redraws a progress bar per chunk; it is very slow
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dest -TimeoutSec 300
  } finally {
    $ProgressPreference = $prevProgress
  }
}

function PackageVersion([string]$root) {
  $pkg = Sub $root "package.json"
  if (-not (Test-Path -LiteralPath $pkg)) { return "unknown" }
  $txt = Get-Content -LiteralPath $pkg -Raw
  if ($txt -match '"version"\s*:\s*"([^"]+)"') { return $Matches[1] }
  return "unknown"
}

# ---------------------------------------------------------------- Node (step 4)
# Only Node is installed here. Chrome, Claude Code and the rest are the setup window's job, where
# each one is shown to the user first -- the same split as on the Mac. Node cannot wait for that
# window because Node is what draws it.
function Ensure-Node([string]$tmp) {
  $have = NodeMajor
  if ($have -ge 20) { Ok "Node $have is already installed"; return }
  if ($have -gt 0) { Step "Node $have is too old (JobSeeker needs 20 or newer)" }

  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Step "Installing Node LTS with winget"
    $r = Invoke-Native "winget" @("install", "--id", "OpenJS.NodeJS.LTS", "--silent",
                                  "--accept-package-agreements", "--accept-source-agreements")
    Refresh-Path
    if ((NodeMajor) -ge 20) { Ok "Node $(NodeMajor) installed"; return }
    Note "winget did not get us a usable Node (exit $($r[0])); trying the installer from nodejs.org"
  } else {
    Step "winget is not available here; fetching the Node installer from nodejs.org"
  }

  $arch = "x64"
  if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $arch = "arm64" }
  $listingUrl = "https://nodejs.org/dist/latest-v22.x/"
  $listing = Invoke-WebRequest -UseBasicParsing -Uri $listingUrl -TimeoutSec 60
  $pattern = "node-v22\.\d+\.\d+-$arch\.msi"
  if ($listing.Content -notmatch $pattern) { Die "could not find a Node 22 installer for $arch at $listingUrl" }
  $msiName = $Matches[0]
  $msi = Join-Path $tmp $msiName

  Step "Downloading $msiName"
  Download ($listingUrl + $msiName) $msi
  $sig = Get-AuthenticodeSignature -LiteralPath $msi
  if ($sig.Status -ne "Valid") { Die "the Node installer's signature is not valid ($($sig.Status)). Not running it." }
  if ($sig.SignerCertificate.Subject -notmatch "OpenJS Foundation") {
    Die "the Node installer is signed by someone other than the OpenJS Foundation ($($sig.SignerCertificate.Subject)). Not running it."
  }
  Ok "signature checked: $($sig.SignerCertificate.Subject -replace '^CN=([^,]+).*', '$1')"

  Step "Installing Node -- Windows will ask for permission first (that is the UAC prompt)"
  Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$msi`" /qn /norestart" -Verb RunAs -Wait
  Refresh-Path
  $now = NodeMajor
  if ($now -lt 20) { Die "Node was installed but this window cannot see it yet. Close PowerShell, open a new one, and run the install command again." }
  Ok "Node $now installed"
}

# ---------------------------------------------------------------- the plan (dry run)
function Show-Plan {
  Write-Host "  Dry run: nothing below will actually happen." -ForegroundColor Cyan
  Write-Host ""
  Plan "check: not elevated, PowerShell >= 5.1, TLS 1.2 on  (this host: PowerShell $($PSVersionTable.PSVersion), Windows: $IsWin, elevated: $(IsElevated))"
  Plan "download $RepoUrl"
  Plan "unpack it and check server\dashboard.mjs is inside"
  if (Test-Path -LiteralPath $HomeDir) {
    Plan "update the copy already in $HomeDir  (data\, config\ and templates\ left alone; everything else replaced)"
  } else {
    Plan "install to $HomeDir"
  }
  if ($SkipPrereqs) {
    Plan "skip the Node check (JOBSEEKER_SKIP_PREREQS=1)"
  } else {
    $have = NodeMajor
    if ($have -ge 20) { Plan "leave Node alone (Node $have is installed)" }
    else {
      $via = "the signed MSI from https://nodejs.org/dist/latest-v22.x/ (UAC prompt)"
      if (Get-Command winget -ErrorAction SilentlyContinue) { $via = "winget install OpenJS.NodeJS.LTS, falling back to $via" }
      Plan "install Node via $via"
    }
  }
  Plan "create Start Menu and Desktop shortcuts  (scripts\win\make-shortcuts.ps1)"
  if ($NoLaunch) { Plan "not open JobSeeker (JOBSEEKER_NO_LAUNCH=1)" }
  else { Plan "open JobSeeker  (wscript.exe $HomeDir\installer\win\JobSeeker.vbs)" }
  Write-Host ""
}

# ---------------------------------------------------------------- main
function Main {
  Write-Host ""
  Write-Host "  JobSeeker" -ForegroundColor White
  Write-Host ""

  if ($DryRun) { Show-Plan; return }

  # -------------------------------------------------------------- 1. can this PC run it?
  if (-not $IsWin -and -not $AllowNonWindows) {
    Die "this installer is for Windows (this is $([System.Environment]::OSVersion.Platform)). On a Mac: curl -fsSL https://myjobseeker.ai/install.sh | bash"
  }
  $psv = $PSVersionTable.PSVersion
  if ($psv.Major -lt 5 -or ($psv.Major -eq 5 -and $psv.Minor -lt 1)) {
    Die "JobSeeker needs PowerShell 5.1 or newer (this is $psv). Windows 10 and 11 ship with 5.1."
  }
  if ((IsElevated) -and -not $AllowElevated) {
    Die "this PowerShell is running as administrator. Close it and run the install command from an ordinary PowerShell window -- an elevated install puts JobSeeker in the wrong user profile."
  }
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { <# .NET Core has no such switch and needs none #> }

  # -------------------------------------------------------------- 2. fetch the source
  $tmpRoot = $env:TEMP
  if (-not $tmpRoot) { $tmpRoot = [IO.Path]::GetTempPath() }
  $script:Tmp = Join-Path $tmpRoot ("jobseeker-" + ([IO.Path]::GetRandomFileName() -replace '\.', ''))
  New-Item -ItemType Directory -Path $script:Tmp -Force | Out-Null
  $zip = Join-Path $script:Tmp "src.zip"

  Step "Downloading JobSeeker"
  try { Download $RepoUrl $zip }
  catch { Die "could not download JobSeeker. Check your internet connection and try again. ($($_.Exception.Message))" }
  $size = (Get-Item -LiteralPath $zip).Length
  if ($size -le 10000) { Die "the download looks wrong ($size bytes)." }
  Ok "downloaded $([int]($size / 1024)) KB"

  Step "Unpacking"
  $unz = Join-Path $script:Tmp "unz"
  try { Expand-Archive -LiteralPath $zip -DestinationPath $unz -Force }
  catch { Die "could not unpack the download. ($($_.Exception.Message))" }
  # GitHub's zip has one folder at the top (jobseeker-main); a hand-made one may not.
  $src = $unz
  $top = @(Get-ChildItem -LiteralPath $unz -Force)
  if ($top.Count -eq 1 -and $top[0].PSIsContainer) { $src = $top[0].FullName }
  if (-not (Test-Path -LiteralPath (Sub $src "server\dashboard.mjs"))) { Die "the download is missing files it should have." }

  # -------------------------------------------------------------- 3. install the source
  # data\ and config\ are the user's, not ours. An update replaces code and leaves those alone --
  # this is a job search someone may have been running for months.
  $keep = @("data", "config", "templates")
  if (Test-Path -LiteralPath $HomeDir) {
    # A JobSeeker that is already running is running the code we are about to replace. Left alone it
    # keeps serving the old version, so the update appears to have done nothing -- and on Windows it
    # can also hold files open while they are being overwritten. Ask before closing it: it is the
    # user's app and it may be mid-something.
    Stop-RunningJobSeeker $HomeDir
    Step "Updating the copy already in $HomeDir"
    foreach ($k in $keep) {
      if ((Test-Path -LiteralPath (Sub $HomeDir $k)) -and (Test-Path -LiteralPath (Sub $src $k))) {
        Remove-Item -LiteralPath (Sub $src $k) -Recurse -Force
      }
    }
    # Anything not preserved above is replaced wholesale, so a deleted file upstream really goes.
    Get-ChildItem -LiteralPath $HomeDir -Force | Where-Object { $keep -notcontains $_.Name } |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
    Get-ChildItem -LiteralPath $src -Force |
      ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $HomeDir -Recurse -Force }
    Ok "updated (your data and settings were left alone)"
  } else {
    Step "Installing to $HomeDir"
    $parent = Split-Path -Parent $HomeDir
    if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    try { Copy-Item -LiteralPath $src -Destination $HomeDir -Recurse -Force }
    catch { Die "could not write to $HomeDir ($($_.Exception.Message))" }
    Ok "installed to $HomeDir"
  }

  # -------------------------------------------------------------- 4. Node, and only Node
  if ($SkipPrereqs) { Note "skipping the Node check (JOBSEEKER_SKIP_PREREQS=1)" }
  else { Ensure-Node $script:Tmp }

  # -------------------------------------------------------------- 5. shortcuts
  # Via powershell.exe -ExecutionPolicy Bypass: a default Windows 10 blocks running .ps1 files
  # (that is why this installer is piped into iex in the first place), and it must not stop here.
  $mk = Sub $HomeDir "scripts\win\make-shortcuts.ps1"
  if ($IsWin) {
    Step "Adding JobSeeker to the Start Menu and Desktop"
    $r = Invoke-Native "powershell.exe" @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $mk)
    if ($r[0] -ne 0) { Die "could not create the shortcuts. $($r[1])" }
    if ($r[1]) { $r[1] -split "`n" | ForEach-Object { Note $_ } }
    Ok "shortcuts in place"
  } else {
    Note "shortcuts skipped (they need Windows)"
  }

  # -------------------------------------------------------------- 6. hand over
  $vbs = Sub $HomeDir "installer\win\JobSeeker.vbs"
  if ($NoLaunch) {
    Note "not opening JobSeeker (JOBSEEKER_NO_LAUNCH=1)"
  } elseif ($IsWin) {
    Step "Opening JobSeeker"
    try { Start-Process -FilePath "wscript.exe" -ArgumentList "`"$vbs`"" -WorkingDirectory $HomeDir }
    catch { Die "could not open $vbs ($($_.Exception.Message))" }
    Write-Host ""
    Write-Host "  Setup has taken over in its own window." -ForegroundColor White
    Write-Host "  You can close this window -- JobSeeker does not need it." -ForegroundColor DarkGray
  } else {
    Note "not opening JobSeeker (needs Windows)"
  }

  # -------------------------------------------------------------- 7. where things are
  Write-Host ""
  Write-Host "  JobSeeker:   v$(PackageVersion $HomeDir)" -ForegroundColor DarkGray
  Write-Host "  Your files:  $HomeDir" -ForegroundColor DarkGray
  Write-Host "  Start it:    Start Menu > JobSeeker   (or the Desktop shortcut)" -ForegroundColor DarkGray
  Write-Host ""
}

$script:Tmp = $null
$failed = $false
try {
  Main
} catch {
  $msg = "$($_.Exception.Message)"
  if ($msg.StartsWith("JOBSEEKER_DIE: ")) { $msg = $msg.Substring(15) }
  else { $msg = "something unexpected went wrong: $msg" }
  Write-Host ""
  Write-Host "  x  " -ForegroundColor Red -NoNewline
  Write-Host $msg
  Write-Host ""
  $failed = $true
} finally {
  if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
    Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
# Close the transcript and, when something went wrong, say where to find it. A user who has to be
# asked "what did it print?" has usually already closed the window.
try { Stop-Transcript | Out-Null } catch { }
if ($failed) {
  Write-Host ""
  Write-Host "  The full log of this attempt is at:" -ForegroundColor DarkGray
  Write-Host "  $JobSeekerInstallLog"
  # $PSCommandPath is set when run as a file (CI, `pwsh -File install.ps1`) and empty under iex,
  # where `exit` would take the user's whole PowerShell window with it.
  if ($PSCommandPath) { exit 1 }
}
