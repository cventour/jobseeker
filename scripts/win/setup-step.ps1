# One step of the graphical setup, run as a detached child of the JobSeeker setup window.
# Twin of scripts/setup-step.sh — change both together.
#
#   powershell -File scripts\win\setup-step.ps1 check-all      report every prerequisite, change nothing
#   powershell -File scripts\win\setup-step.ps1 node           install Node, then verify it
#   powershell -File scripts\win\setup-step.ps1 git            install Git for Windows, then verify it
#   powershell -File scripts\win\setup-step.ps1 claude         install Claude Code, then verify it
#   powershell -File scripts\win\setup-step.ps1 chrome         install Google Chrome, then verify it
#   powershell -File scripts\win\setup-step.ps1 configure      settings file, global agent, data folders
#   powershell -File scripts\win\setup-step.ps1 start          start the dashboard and wait for it to answer
#   powershell -File scripts\win\setup-step.ps1 extension      load the Chrome extension and pair it
#   powershell -File scripts\win\setup-step.ps1 whatsapp <num> install the WhatsApp plugin and pair a phone
#
# This is the GUI half of what scripts\win\setup.ps1 does at a terminal. It differs in one way that
# matters: setup.ps1 only ever CHECKS a runtime and tells you where to download it. This installs it.
#
# That is not a reversal of the position in setup.ps1's header, it is the other half of it. The
# objection there was never to installing Node — it was to installing a language runtime SILENTLY,
# from a double-clicked file, with nobody told what was happening. Here the window has already shown
# the user the file, the source it comes from and the fact that Windows will ask for permission, and
# waited for them to press a button. Asked and answered is a different act from assumed.
#
# So the rules this script holds itself to, unchanged from the bash:
#
#   * Nothing is installed that the window did not name first.
#   * Every download comes from the vendor's own domain over HTTPS, and its Authenticode signature
#     is checked before it is run. An unsigned or wrongly-signed download is a hard failure, never
#     a warning.
#   * Only the one command that genuinely needs administrator rights is elevated, and Windows does
#     the asking — the UAC prompt here is the analogue of the macOS password prompt there. This
#     script never sees a password.
#   * Every step VERIFIES by re-running the same check that said it was missing. A step reports
#     success because the check now passes, never because the installer exited 0 -- those are
#     different claims, and this project exists partly because they get confused.
#
# Four things differ from the Mac, all forced by the platform:
#
#   * There is a `git` step. Claude Code's Bash tool on Windows IS Git Bash, so every agent playbook
#     that runs a shell command needs Git for Windows present. On macOS bash is part of the OS.
#   * winget is tried first for each install, because when it is there it is the shortest, most
#     auditable path. The signed-installer fallback is the same code path the Mac uses.
#   * There is no browser agent. macOS needs a LaunchAgent to hold a stable Automation grant;
#     Windows has no TCC, so Chrome is driven by the JobSeeker Bridge extension instead and is
#     connected later, from the dashboard. `configure` never fails over it.
#   * The dashboard is NOT killed when the setup window closes. See do_start.
#
# Windows PowerShell 5.1 and pwsh 7 both: no `??`, no ternaries, no `&&`/`||` chaining. This file is
# saved WITH a UTF-8 BOM — 5.1 reads a BOM-less file as ANSI and turns every em dash into mojibake.
#
# Output protocol. Lines beginning "::" are for the window; everything else is log text a human can
# read afterwards in data\.setup\setup.log.
#
#   ::step  <id> <running|ok|fail|skip>   state of one checklist row
#   ::detail <id> <text>                  the small grey line under that row
#   ::pct   <0-100>                       progress of the step now running
#   ::say   <text>                        what is happening, right now
#   ::need  <text>                        something only the user can do
#   ::code  <XXXX-XXXX>                   a WhatsApp pairing code, to show large
#   ::done  <ok|fail>                     this step is over

$ErrorActionPreference = "Stop"
Set-StrictMode -Off
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $Repo

# ConvertTo-CmdLine / ConvertTo-CmdArg / Stop-ProcessTree. Every native launch in this file goes
# through Start-Process with a command line those built, never through PowerShell's native argument
# binder: 5.1 silently drops an embedded double quote there, and a Windows path or an installer
# switch string is exactly where one turns up.
. (Join-Path $PSScriptRoot "lib\timeout.ps1")

$NodeMin = 20
$Work = Join-Path $Repo "data\.setup"
$DL = Join-Path $Work "downloads"          # anything we exec that came off the network lands here
$StepLog = Join-Path $Work "step.log"
$FullLog = Join-Path $Work "setup.log"
$ConfigFile = Join-Path $Repo "config\job-seeker.config.md"
$ExampleFile = Join-Path $Repo "config\job-seeker.config.md.example"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$OnWindows = ([System.Environment]::OSVersion.Platform -eq "Win32NT")

New-Item -ItemType Directory -Force -Path $Work | Out-Null
New-Item -ItemType Directory -Force -Path $DL | Out-Null

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { <# .NET Core has no such switch and needs none #> }

# ---------------------------------------------------------------------------- saying things
# stdout is the protocol, exactly as in the bash: the setup window redirects this process's stdout
# into data\.setup\step.log and parses it there. When nobody is capturing us — a human running the
# step by hand — we keep those two logs ourselves instead, so the transcript is never simply lost.
# Only one of the two writes them, never both, so the window's own copy cannot be doubled.
$KeepOwnLog = $false
try { $KeepOwnLog = -not [Console]::IsOutputRedirected } catch { $KeepOwnLog = $false }
if ($KeepOwnLog) { [IO.File]::WriteAllText($StepLog, "", $Utf8NoBom) }

function Emit([string]$Line) {
  [Console]::Out.WriteLine($Line)
  if ($KeepOwnLog) {
    try {
      [IO.File]::AppendAllText($StepLog, $Line + "`n", $Utf8NoBom)
      [IO.File]::AppendAllText($FullLog, $Line + "`n", $Utf8NoBom)
    } catch { <# a log that cannot be written must never fail the step it is describing #> }
  }
}

function Write-Step([string]$Id, [string]$State) { Emit ("::step {0} {1}" -f $Id, $State) }
function Write-Detail([string]$Id, [string]$Text) { Emit ("::detail {0} {1}" -f $Id, $Text) }
function Write-Pct([int]$P) { Emit ("::pct {0}" -f $P) }
function Write-Say([string]$Text) { Emit ("::say " + $Text) }
function Write-Need([string]$Text) { Emit ("::need " + $Text) }
function Write-Log([string]$Text) { Emit ("{0}  {1}" -f (Get-Date -Format "HH:mm:ss"), $Text) }
function Write-Indented([string]$Text) {
  if (-not $Text) { return }
  foreach ($l in ($Text -split "`r?`n")) { if ($l.Length -gt 0) { Emit ("    " + $l) } }
}
function Finish([string]$State) {
  Emit ("::done " + $State)
  if ($State -eq "ok") { exit 0 }
  exit 1
}

# ---------------------------------------------------------------------------- running things
# Same reasoning as scripts\win\lib\claude-run.ps1: under 5.1 with $ErrorActionPreference = "Stop" a
# native program writing one line to stderr becomes a terminating error, so everything external is
# run with both streams redirected to files and read back afterwards.
# Runs a program, captures both streams, and comes back.
#
# Deliberately NOT `Start-Process -Wait`. That flag waits for the process AND every descendant it
# leaves behind, and the Claude Code installer leaves a PowerShell running: the install completed,
# claude.exe was on disk, and setup sat there forever anyway with the window showing nothing. A
# setup step that can never finish is worse than one that fails, because there is nothing to read
# and nothing to retry. So this waits on the child it actually started, and only for as long as it
# said it would.
function Invoke-Captured {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [string]$WorkingDirectory,
    [int]$TimeoutSec = 600
  )
  if (-not $WorkingDirectory) { $WorkingDirectory = $Repo }
  $outFile = [IO.Path]::GetTempFileName()
  $errFile = [IO.Path]::GetTempFileName()
  try {
    $sp = @{
      FilePath               = $FilePath
      WorkingDirectory       = $WorkingDirectory
      RedirectStandardOutput = $outFile
      RedirectStandardError  = $errFile
      NoNewWindow            = $true
      PassThru               = $true
    }
    $cmdline = ConvertTo-CmdLine $ArgumentList
    if ($cmdline) { $sp["ArgumentList"] = $cmdline }
    # Nothing here can answer a question, so make asking one hit end-of-input immediately rather
    # than sit there until the timeout expires. An empty file, not "NUL": PowerShell resolves that
    # name as a relative path and Start-Process fails outright (measured on Windows 11).
    $inFile = [IO.Path]::GetTempFileName()
    $sp["RedirectStandardInput"] = $inFile
    $code = 127
    $out = ""
    $err = ""
    try {
      try {
        $p = Start-Process @sp
      } catch {
        # Some programs refuse a redirected stdin. Losing the redirect is better than losing the step.
        $sp.Remove("RedirectStandardInput") | Out-Null
        $p = Start-Process @sp
      }
      if ($p.WaitForExit($TimeoutSec * 1000)) {
        $code = [int]$p.ExitCode
      } else {
        # Past its budget. Stop this child (not the stragglers it may have left, which are none of
        # our business) and report the timeout so the step can decide what it means.
        Write-Log ("{0} did not finish within {1}s; stopping it" -f $FilePath, $TimeoutSec)
        try { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null } catch { }
        $code = 124
        $err = "timed out after ${TimeoutSec}s"
      }
    } catch {
      $err = $_.Exception.Message
    }
    Remove-Item -LiteralPath $inFile -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $outFile) { $out = [IO.File]::ReadAllText($outFile).TrimEnd("`r", "`n") }
    if (Test-Path -LiteralPath $errFile) { $err = ($err + [IO.File]::ReadAllText($errFile)).TrimEnd("`r", "`n") }
    return @{ ExitCode = $code; Out = $out; Err = $err }
  } finally {
    Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
  }
}

# A JavaScript snippet is nothing but quotes, backslashes and newlines, so it never travels on a
# command line: it goes in an environment variable and `node -e` evals it from there. Same transport
# as scripts\win\schedule-ladder.ps1 and lib\claude-run.ps1. process.argv is numbered exactly as
# under `node -e '<code>'`, so the snippets stay byte-identical to the bash twin's.
function Invoke-NodeSnippet {
  param([string]$Snippet, [string[]]$ArgumentList = @())
  $n = Get-NodeBin
  if (-not $n) { return @{ ExitCode = 127; Out = ""; Err = "no node" } }
  $env:JOBSEEKER_NODE_SNIPPET = $Snippet
  try {
    return Invoke-Captured -FilePath $n -ArgumentList (@("-e", "eval(process.env.JOBSEEKER_NODE_SNIPPET)") + $ArgumentList)
  } finally {
    Remove-Item -Path Env:JOBSEEKER_NODE_SNIPPET -ErrorAction SilentlyContinue
  }
}

# The Path this process started with does not know about something installed a moment ago. Same
# refresh install.ps1 does, and for the same reason.
function Update-PathFromRegistry {
  if (-not $OnWindows) { return }
  try {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
  } catch { <# a locked-down registry is not a reason to fail the verify that follows #> }
}

function Test-HaveWinget {
  $c = Get-Command winget -ErrorAction SilentlyContinue
  if ($c) { return $true }
  return $false
}

# ---------------------------------------------------------------------------- finding things
# A windowed app does not inherit the shell's PATH, so `Get-Command node` inside this script can
# miss a Node the user definitely has. Look where the installers actually put it before giving up.
function Get-FirstExisting([string[]]$Candidates) {
  foreach ($c in $Candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

function Get-NodeBin {
  if ($env:NODE_BIN -and (Test-Path -LiteralPath $env:NODE_BIN)) { return $env:NODE_BIN }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $c = @()
  if ($env:ProgramFiles) { $c += (Join-Path $env:ProgramFiles "nodejs\node.exe") }
  if (${env:ProgramFiles(x86)}) { $c += (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe") }
  if ($env:LOCALAPPDATA) { $c += (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe") }
  if ($env:USERPROFILE) {
    $c += (Join-Path $env:USERPROFILE ".volta\bin\node.exe")
    $c += (Join-Path $env:USERPROFILE "scoop\shims\node.exe")
  }
  return Get-FirstExisting $c
}

function Get-ClaudeBin {
  $cmd = Get-Command claude -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $c = @()
  if ($env:USERPROFILE) { $c += (Join-Path $env:USERPROFILE ".local\bin\claude.exe") }
  if ($env:APPDATA) { $c += (Join-Path $env:APPDATA "npm\claude.cmd") }
  return Get-FirstExisting $c
}

function Get-GitBin {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $c = @()
  if ($env:ProgramFiles) { $c += (Join-Path $env:ProgramFiles "Git\cmd\git.exe") }
  if (${env:ProgramFiles(x86)}) { $c += (Join-Path ${env:ProgramFiles(x86)} "Git\cmd\git.exe") }
  if ($env:LOCALAPPDATA) { $c += (Join-Path $env:LOCALAPPDATA "Programs\Git\cmd\git.exe") }
  return Get-FirstExisting $c
}

function Get-GitBashPath {
  $c = @()
  if ($env:ProgramFiles) { $c += (Join-Path $env:ProgramFiles "Git\bin\bash.exe") }
  if (${env:ProgramFiles(x86)}) { $c += (Join-Path ${env:ProgramFiles(x86)} "Git\bin\bash.exe") }
  if ($env:LOCALAPPDATA) { $c += (Join-Path $env:LOCALAPPDATA "Programs\Git\bin\bash.exe") }
  return Get-FirstExisting $c
}

function Get-BunBin {
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $c = @()
  if ($env:USERPROFILE) { $c += (Join-Path $env:USERPROFILE ".bun\bin\bun.exe") }
  return Get-FirstExisting $c
}

# Where chrome.exe lives, found the way scripts/browser/extension.mjs findChromeExe() finds it: the
# App Paths registry key first, then the three standard install directories. One source of truth
# for "is Chrome there", so the step and the driver can never disagree.
function Get-ChromeExe {
  if ($OnWindows) {
    $r = Invoke-Captured -FilePath "reg.exe" -ArgumentList @(
      "query", "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe", "/ve")
    if ($r.ExitCode -eq 0 -and $r.Out -match 'REG_SZ\s+(.+\S)\s*$') {
      $p = $Matches[1].Trim()
      if (Test-Path -LiteralPath $p) { return $p }
    }
  }
  $dirs = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LocalAppData)
  foreach ($d in $dirs) {
    if (-not $d) { continue }
    $p = Join-Path $d "Google\Chrome\Application\chrome.exe"
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

# ---------------------------------------------------------------------------- the checks
# Each returns @{ Ok = $true/$false; Text = "<human-readable>" }. These are the ONLY source of truth
# for "is this installed" -- both the initial survey and the post-install verification call the same
# function, so a step cannot report success against a weaker test than the one that failed.
function Ck([bool]$Ok, [string]$Text) { return @{ Ok = $Ok; Text = $Text } }

function Check-Node {
  $n = Get-NodeBin
  if (-not $n) { return Ck $false "" }
  $r = Invoke-Captured -FilePath $n -ArgumentList @("-v")
  if ($r.ExitCode -ne 0 -or -not ($r.Out -match '^v(\d+)')) { return Ck $false "" }
  $major = [int]$Matches[1]
  $v = $r.Out.Trim()
  if ($major -lt $NodeMin) { return Ck $false ("{0} (too old)" -f $v) }
  return Ck $true $v
}

# New on Windows, and not optional: Claude Code's Bash tool IS Git Bash, so every playbook that runs
# `node server/record.mjs` runs it through git-bash.exe. No Git, no agents.
function Check-Git {
  $g = Get-GitBin
  if (-not $g) { return Ck $false "" }
  $r = Invoke-Captured -FilePath $g -ArgumentList @("--version")
  if ($r.ExitCode -ne 0) { return Ck $false "" }
  $v = ($r.Out -replace '^git version\s*', '').Trim()
  if (-not $v) { $v = "installed" }
  $bash = Get-GitBashPath
  if ($OnWindows -and -not $bash) {
    # A `git` that is not Git for Windows (a WSL shim, a Cygwin git) has no bash.exe where Claude
    # Code looks for one, so it is not the thing this check is really asking about.
    return Ck $false ("{0} (no Git Bash — Claude Code needs it)" -f $v)
  }
  return Ck $true $v
}

function Check-Claude {
  $c = Get-ClaudeBin
  if (-not $c) { return Ck $false "" }
  $r = Invoke-Captured -FilePath $c -ArgumentList @("--version")
  $v = ""
  if ($r.ExitCode -eq 0 -and $r.Out) { $v = ($r.Out.Trim() -split '\s+')[0] }
  if (-not $v) { $v = "installed" }
  return Ck $true $v
}

function Check-Chrome {
  $exe = Get-ChromeExe
  if (-not $exe) { return Ck $false "" }
  # `chrome.exe --version` on Windows writes nothing a parent can read; the file's own version
  # resource says the same thing and says it without launching a browser.
  $v = ""
  try { $v = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion } catch { $v = "" }
  if (-not $v) { $v = "installed" }
  return Ck $true $v.Trim()
}

# The Mac twin also requires the com.jobseeker.browser LaunchAgent here. There is no such agent on
# Windows — Chrome is driven by the JobSeeker Bridge extension, paired later from the dashboard —
# so what this checks is the other half: the settings file and the global "jobseeker" front door.
function Check-Configure {
  if (-not (Test-Path -LiteralPath $ConfigFile)) { return Ck $false "" }
  $userHome = $env:USERPROFILE
  if (-not $userHome) { $userHome = $HOME }
  $agent = Join-Path $userHome ".claude\agents\jobseeker.md"
  if (-not (Test-Path -LiteralPath $agent)) { return Ck $false "settings file in place, global agent missing" }
  return Ck $true "settings file and global agent in place"
}

function Get-DashboardPort {
  if (Test-Path -LiteralPath $ConfigFile) {
    foreach ($line in [IO.File]::ReadAllLines($ConfigFile)) {
      if ($line -match '^dashboard_port:\s*(\d+)') { return $Matches[1] }
    }
  }
  return "4319"
}

# One GET, short deadline, never throws. Returns the body text or "".
function Get-Url([string]$Url, [int]$TimeoutSec) {
  $prev = $ProgressPreference
  $ProgressPreference = "SilentlyContinue"
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return [string]$r.Content
  } catch {
    return ""
  } finally {
    $ProgressPreference = $prev
  }
}

# Whether OUR JobSeeker is answering -- not merely whether something is. A dashboard left running
# from a different checkout answers a plain request exactly the same way, and handing the window
# over to it shows the user another build entirely, which reads as "the update did nothing".
# 127.0.0.1, never localhost. The dashboard binds the IPv4 loopback only, and on Windows localhost
# resolves to ::1 first: asking for it times out and reports "nothing there" about a dashboard that
# is running perfectly well. That is not hypothetical -- it is what made this step start a second
# dashboard on a port the first one already had, and then report "JobSeeker stopped while starting
# up" about the copy that lost the race. Measured: localhost times out after 2.2s, 127.0.0.1
# answers in 26ms.
function Check-Start {
  $port = Get-DashboardPort
  $who = Get-Url ("http://127.0.0.1:{0}/_whoami" -f $port) 2
  if (-not $who) {
    # Nothing there, or something too old to answer. Either way it is not a JobSeeker we can claim.
    $any = Get-Url ("http://127.0.0.1:{0}" -f $port) 2
    if (-not $any) { return Ck $false "" }
    return Ck $false ("something else is using port {0}" -f $port)
  }
  $root = ""
  try { $root = (ConvertFrom-Json $who).root } catch { $root = "" }
  if ($root -eq $Repo) { return Ck $true ("answering on port {0}" -f $port) }
  return Ck $false ("a different JobSeeker is using port {0}" -f $port)
}

# ---- WhatsApp state (also read by check-all, so it lives up here with the other checks) ----
# Overridable so this step can be exercised against a scratch directory without going near a real,
# working WhatsApp link.
$WaDir = $env:JOBSEEKER_WA_DIR
if (-not $WaDir) {
  $uh = $env:USERPROFILE
  if (-not $uh) { $uh = $HOME }
  $WaDir = Join-Path $uh ".whatsapp-channel"
}
$WaPluginRepo = "Rich627/whatsapp-claude-plugin"
$WaPlugin = "whatsapp-claude-channel@whatsapp-claude-plugin"

function Test-WaPaired {
  $creds = Join-Path $WaDir ".baileys_auth\creds.json"
  if (-not (Test-Path -LiteralPath $creds)) { return $false }
  $snippet = 'try{const c=require(process.argv[1]);process.exit(c.registered?0:1)}catch{process.exit(1)}'
  $r = Invoke-NodeSnippet -Snippet $snippet -ArgumentList @($creds)
  return ($r.ExitCode -eq 0)
}

function Get-WaNumber {
  $envFile = Join-Path $WaDir ".env"
  if (-not (Test-Path -LiteralPath $envFile)) { return "" }
  foreach ($line in [IO.File]::ReadAllLines($envFile)) {
    if ($line -match '^WHATSAPP_PHONE_NUMBER=(.*)$') { return $Matches[1].Trim() }
  }
  return ""
}

function Check-Whatsapp {
  if (-not (Test-WaPaired)) { return Ck $false "" }
  $n = Get-WaNumber
  if ($n) { return Ck $true ("connected as +{0}" -f $n) }
  return Ck $true "connected"
}

# ---- the JobSeeker Bridge extension (also read by check-all, so it lives with the other checks) ----

function Get-DataDir {
  if ($env:JOBSEEKER_DATA_DIR) { return $env:JOBSEEKER_DATA_DIR }
  return (Join-Path $Repo "data")
}

function Get-BridgePort {
  if (Test-Path -LiteralPath $ConfigFile) {
    foreach ($line in [IO.File]::ReadAllLines($ConfigFile)) {
      if ($line -match '^bridge_port:\s*(\d+)') { return $Matches[1] }
    }
  }
  return "4320"
}

# Ask every port the extension itself would ask. extension\background.js probes 4319 then 4320, the
# dashboard serves /bridge/* on dashboard_port, and `node server\bridge.mjs --serve` serves the same
# routes on bridge_port. "connected" is held in the memory of whichever of those the extension is
# actually polling, never on disk, so both are asked and either one saying yes is the answer.
# 127.0.0.1 and not localhost: the bridge binds the IPv4 loopback only, and on a machine where
# localhost resolves to ::1 first the probe would report "nothing there" about a running bridge.
function Get-BridgeState {
  $ports = @([string](Get-DashboardPort))
  $bp = [string](Get-BridgePort)
  if ($ports -notcontains $bp) { $ports += $bp }
  $answered = $false
  $paired = $false
  $answeredPort = ""
  foreach ($p in $ports) {
    $body = Get-Url ("http://127.0.0.1:{0}/bridge/status" -f $p) 2
    if (-not $body) { continue }
    $j = $null
    try { $j = ConvertFrom-Json $body } catch { $j = $null }
    if (-not $j) { continue }
    if (-not $answered) { $answeredPort = $p }
    $answered = $true
    if ($j.paired) { $paired = $true }
    if ($j.connected) { return @{ Answered = $true; Paired = $true; Connected = $true; Port = $p } }
  }
  return @{ Answered = $answered; Paired = $paired; Connected = $false; Port = $answeredPort }
}

# Pairing, not liveness, is what "set up" means here -- the same shape as Check-Whatsapp. The token
# the extension traded its code for is on disk in data\.bridge.ext.json and outlives Chrome being
# closed, so a machine that connected the extension last month is not dragged back through this step
# merely because Chrome is not open at this second.
function Check-Extension {
  if (-not (Test-Path -LiteralPath (Join-Path $Repo "extension\manifest.json"))) {
    return Ck $false "the extension folder is missing from this checkout"
  }
  if (Test-Path -LiteralPath (Join-Path (Get-DataDir) ".bridge.ext.json")) {
    $st = Get-BridgeState
    if ($st.Connected) { return Ck $true "connected" }
    return Ck $true "loaded and paired"
  }
  if (-not (Get-ChromeExe)) { return Ck $false "Chrome is not installed" }
  return Ck $false ""
}

function Get-Check([string]$Id) {
  switch ($Id) {
    "node" { return Check-Node }
    "git" { return Check-Git }
    "claude" { return Check-Claude }
    "chrome" { return Check-Chrome }
    "configure" { return Check-Configure }
    "start" { return Check-Start }
    "extension" { return Check-Extension }
    "whatsapp" { return Check-Whatsapp }
  }
  return Ck $false ""
}

# ---------------------------------------------------------------------------- elevation
# Only ever called with an installer this script downloaded into data\.setup and verified the
# signature of. Windows draws the UAC dialog; nothing here ever sees or stores a password.
# Returns $true when the elevated program exited 0.
function Invoke-Elevated([string]$FilePath, [string[]]$Arguments, [string]$What, [int]$TimeoutSec = 900) {
  $cmdline = ConvertTo-CmdLine $Arguments
  Write-Log ("elevating: {0} {1}" -f $FilePath, $cmdline)
  try {
    # No -Wait, for the same reason Invoke-Captured drops it: that flag waits for the process and
    # every descendant, and installers routinely leave one running. Node, Git and Chrome all come
    # through here, so a single lingering helper would hang setup on exactly the machine that needed
    # it most -- one where none of them were installed yet.
    $sp = @{ FilePath = $FilePath; Verb = "RunAs"; PassThru = $true }
    if ($cmdline) { $sp["ArgumentList"] = $cmdline }
    $p = Start-Process @sp
    if (-not $p) {
      Write-Log ("{0} installer did not report a process; letting the step verify instead" -f $What)
      return $true
    }
    # Poll rather than WaitForExit: a process started through ShellExecute does not always hand back
    # a waitable handle, and Get-Process answers regardless of who owns it.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $exited = $false
    while ((Get-Date) -lt $deadline) {
      if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { $exited = $true; break }
      Start-Sleep -Milliseconds 500
    }
    if (-not $exited) {
      # Deliberately NOT killed. Half-written registry and files are how an installer leaves a
      # machine in a state neither installed nor absent, and this script cannot tell a slow install
      # from a stuck one. Stop waiting, say so, and let the step's own check decide what is true.
      Write-Log ("{0} installer is still running after {1}s; not waiting any longer, and not killing it" -f $What, $TimeoutSec)
      Write-Log ("if it finishes later, run this step again and it will find it")
      return $false
    }
    # An elevated child is launched through ShellExecute, and its exit code is not always readable
    # afterwards. Unreadable is not "failed": the step's own verify is the judge either way, and
    # refusing to run it because a number was missing would report a successful install as a failure.
    $code = $null
    try { $code = [int]$p.ExitCode } catch { $code = $null }
    if ($null -eq $code) {
      Write-Log ("{0} installer finished (no exit code reported)" -f $What)
      return $true
    }
    Write-Log ("{0} installer exited {1}" -f $What, $code)
    return ($code -eq 0)
  } catch {
    # The one failure worth naming: UAC cancelled. Everything else is logged as it came.
    $m = $_.Exception.Message
    Write-Log ("could not run the {0} installer: {1}" -f $What, $m)
    if ($m -match "canceled|cancelled") { Write-Log "you cancelled the Windows permission prompt" }
    return $false
  }
}

# ---------------------------------------------------------------------------- downloading
# A real progress bar: ask how big it is, then watch the bytes arrive. Invoke-WebRequest reports
# nothing a parent can turn into a percentage, so the stream is copied by hand.
function Get-RemoteFile([string]$Url, [string]$Dest, [int]$Lo, [int]$Hi) {
  Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
  $resp = $null
  $in = $null
  $out = $null
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.UserAgent = "JobSeeker-Setup"
    $req.Timeout = 30000
    $req.ReadWriteTimeout = 900000
    $resp = $req.GetResponse()
    $total = [long]$resp.ContentLength
    $in = $resp.GetResponseStream()
    $out = [IO.File]::Create($Dest)
    $buf = New-Object byte[] 262144
    $got = [long]0
    $lastPct = -1
    while ($true) {
      $n = $in.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      $out.Write($buf, 0, $n)
      $got += $n
      if ($total -gt 0) {
        $p = [int]($Lo + ($Hi - $Lo) * $got / $total)
        if ($p -ne $lastPct) { Write-Pct $p; $lastPct = $p }
      }
    }
    return $true
  } catch {
    Write-Log ("download failed: " + $_.Exception.Message)
    return $false
  } finally {
    if ($out) { $out.Dispose() }
    if ($in) { $in.Dispose() }
    if ($resp) { $resp.Dispose() }
  }
}

function Format-Bytes([long]$B) {
  if ($B -gt 1048576) { return ("{0} MB" -f [int]($B / 1048576)) }
  return ("{0} KB" -f [int]($B / 1024))
}

function Get-FileSize([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return [long]0 }
  return [long](Get-Item -LiteralPath $Path).Length
}

# Signature before execution, always. This is the moment where a wrong answer means running someone
# else's code as administrator, so a failure here stops the step dead rather than warning.
# Returns @{ Ok; Who; Why }.
function Test-Signature([string]$Path, [string[]]$ExpectSubject) {
  try {
    $sig = Get-AuthenticodeSignature -LiteralPath $Path
  } catch {
    return @{ Ok = $false; Who = ""; Why = "the signature could not be read: " + $_.Exception.Message }
  }
  if ("$($sig.Status)" -ne "Valid") {
    return @{ Ok = $false; Who = ""; Why = "the signature is not valid ($($sig.Status))" }
  }
  $subject = ""
  if ($sig.SignerCertificate) { $subject = [string]$sig.SignerCertificate.Subject }
  foreach ($want in $ExpectSubject) {
    if ($subject -like ("*" + $want + "*")) {
      $who = $subject
      if ($subject -match 'CN=([^,]+)') { $who = $Matches[1] }
      return @{ Ok = $true; Who = $who; Why = "" }
    }
  }
  return @{ Ok = $false; Who = $subject; Why = "it is signed by someone else ($subject)" }
}

# ============================================================================ steps

function Do-CheckAll {
  # Same ids, same order and the same two lines per id as the bash, plus `git` — which is a real
  # prerequisite here and does not exist as one on macOS.
  foreach ($id in @("node", "git", "claude", "chrome", "configure", "start", "extension", "whatsapp")) {
    $c = Get-Check $id
    if ($c.Ok) { Write-Step $id "ok" } else { Write-Step $id "fail" }
    if ($c.Text) { Write-Detail $id $c.Text }
  }
  Finish "ok"
}

# ---------------------------------------------------------------------------- node
function Do-Node {
  $c = Check-Node
  if ($c.Ok) {
    Write-Step "node" "ok"; Write-Detail "node" ("{0} (already installed)" -f $c.Text)
    Write-Log ("node already present: " + $c.Text); Finish "ok"
  }

  Write-Step "node" "running"; Write-Pct 2

  # winget first when it is here: one command, from Microsoft's own package source, and no
  # download this script has to vouch for.
  if (Test-HaveWinget) {
    Write-Say "Installing Node LTS with winget"
    Write-Detail "node" "Installing with winget"
    Write-Log "winget install --id OpenJS.NodeJS.LTS"
    $r = Invoke-Captured -TimeoutSec 600 -FilePath "winget" -ArgumentList @(
      "install", "--id", "OpenJS.NodeJS.LTS", "--silent",
      "--accept-package-agreements", "--accept-source-agreements")
    Write-Indented $r.Out
    Update-PathFromRegistry
    Write-Pct 45
    $c = Check-Node
    if ($c.Ok) {
      Write-Log ("verified: node {0} at {1}" -f $c.Text, (Get-NodeBin))
      Write-Detail "node" $c.Text; Write-Step "node" "ok"; Write-Pct 100; Finish "ok"
    }
    Write-Log ("winget did not get us a usable Node (exit {0}); falling back to nodejs.org" -f $r.ExitCode)
  } else {
    Write-Log "winget is not available here; fetching the installer from nodejs.org"
  }

  Write-Say "Finding the current Node LTS release"
  $arch = "x64"
  if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $arch = "arm64" }
  # The directory listing names the exact file, so there is no JSON to parse -- which matters,
  # because the tool you would parse it with is the thing being installed.
  $listingUrl = "https://nodejs.org/dist/latest-v22.x/"
  $listing = Get-Url $listingUrl 30
  $pattern = "node-v22\.\d+\.\d+-$arch\.msi"
  if (-not ($listing -match $pattern)) {
    Write-Log "could not reach nodejs.org to find the installer"
    Write-Detail "node" "Could not reach nodejs.org — check your connection and try again"
    Write-Step "node" "fail"; Finish "fail"
  }
  $file = $Matches[0]
  $msi = Join-Path $DL "node.msi"

  Write-Say ("Downloading {0} from nodejs.org" -f $file)
  Write-Detail "node" ("Downloading {0}" -f $file)
  Write-Log ("GET " + $listingUrl + $file)
  if (-not (Get-RemoteFile ($listingUrl + $file) $msi 48 70)) {
    Write-Detail "node" "The download did not finish"; Write-Step "node" "fail"; Finish "fail"
  }
  Write-Log ("downloaded " + (Format-Bytes (Get-FileSize $msi)))

  Write-Pct 72
  Write-Say "Checking who signed it"
  $sig = Test-Signature $msi @("OpenJS Foundation")
  if (-not $sig.Ok) {
    Write-Log ("REFUSED: " + $sig.Why)
    Write-Detail "node" "The download was not signed by the OpenJS Foundation — nothing was installed"
    Write-Step "node" "fail"; Finish "fail"
  }
  Write-Log ("signed by " + $sig.Who)
  Write-Detail "node" ("Signed by " + $sig.Who)

  Write-Pct 78
  # The analogue of the Mac's "macOS will ask for your password": on Windows the same consent is a
  # UAC dialog, and saying so before it appears is the difference between an expected prompt and an
  # alarming one.
  Write-Say "Installing Node — Windows will ask for permission first (that is the UAC prompt)"
  Write-Need "Windows will ask for permission to install Node. Click Yes."
  if (-not (Invoke-Elevated "msiexec.exe" @("/i", $msi, "/qn", "/norestart") "Node")) {
    Write-Detail "node" "Not installed — the permission prompt was cancelled or the installer failed"
    Write-Step "node" "fail"; Finish "fail"
  }

  Write-Pct 92
  Write-Say "Checking Node actually runs"
  Update-PathFromRegistry
  $c = Check-Node
  if ($c.Ok) {
    Write-Log ("verified: node {0} at {1}" -f $c.Text, (Get-NodeBin))
    Write-Detail "node" $c.Text; Write-Step "node" "ok"; Write-Pct 100
    Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    Finish "ok"
  }
  Write-Log "installer finished but node still does not run"
  Write-Detail "node" "The installer finished, but Node still does not run"
  Write-Step "node" "fail"; Finish "fail"
}

# ---------------------------------------------------------------------------- git
# No Mac equivalent. Claude Code runs its Bash tool through Git Bash on Windows, so Git for Windows
# is a prerequisite for the agents in exactly the way Node is for the dashboard.
function Do-Git {
  $c = Check-Git
  if ($c.Ok) {
    Write-Step "git" "ok"; Write-Detail "git" ("{0} (already installed)" -f $c.Text)
    Write-Log ("git already present: " + $c.Text); Finish "ok"
  }

  Write-Step "git" "running"; Write-Pct 2

  if (Test-HaveWinget) {
    Write-Say "Installing Git for Windows with winget"
    Write-Detail "git" "Installing with winget"
    Write-Log "winget install --id Git.Git"
    $r = Invoke-Captured -TimeoutSec 600 -FilePath "winget" -ArgumentList @(
      "install", "--id", "Git.Git", "--silent",
      "--accept-package-agreements", "--accept-source-agreements")
    Write-Indented $r.Out
    Update-PathFromRegistry
    Write-Pct 45
    $c = Check-Git
    if ($c.Ok) {
      Write-Log ("verified: git {0} at {1}" -f $c.Text, (Get-GitBin))
      Write-Detail "git" $c.Text; Write-Step "git" "ok"; Write-Pct 100; Finish "ok"
    }
    Write-Log ("winget did not get us a usable Git (exit {0}); falling back to the release download" -f $r.ExitCode)
  } else {
    Write-Log "winget is not available here; fetching the Git for Windows release"
  }

  Write-Say "Finding the current Git for Windows release"
  $api = "https://api.github.com/repos/git-for-windows/git/releases/latest"
  Write-Log ("GET " + $api)
  $url = ""
  $file = ""
  $body = Get-Url $api 30
  if ($body) {
    try {
      foreach ($a in (ConvertFrom-Json $body).assets) {
        if ($a.name -like "Git-*-64-bit.exe") { $url = [string]$a.browser_download_url; $file = [string]$a.name; break }
      }
    } catch {
      Write-Log ("could not read the release list: " + $_.Exception.Message)
    }
  }
  if (-not $url) {
    Write-Log "could not find a Git for Windows installer to download"
    Write-Detail "git" "Could not reach the Git for Windows release page — check your connection and try again"
    Write-Step "git" "fail"; Finish "fail"
  }

  $exe = Join-Path $DL "git-setup.exe"
  Write-Say ("Downloading {0}" -f $file)
  Write-Detail "git" ("Downloading {0}" -f $file)
  Write-Log ("GET " + $url)
  if (-not (Get-RemoteFile $url $exe 10 70)) {
    Write-Detail "git" "The download did not finish"; Write-Step "git" "fail"; Finish "fail"
  }
  Write-Log ("downloaded " + (Format-Bytes (Get-FileSize $exe)))

  Write-Pct 72
  Write-Say "Checking who signed it"
  $sig = Test-Signature $exe @("Johannes Schindelin", "Git for Windows")
  if (-not $sig.Ok) {
    Write-Log ("REFUSED: " + $sig.Why)
    Write-Detail "git" "The download was not signed by the Git for Windows maintainer — nothing was installed"
    Write-Step "git" "fail"; Finish "fail"
  }
  Write-Log ("signed by " + $sig.Who)
  Write-Detail "git" ("Signed by " + $sig.Who)

  Write-Pct 78
  Write-Say "Installing Git — Windows will ask for permission first (that is the UAC prompt)"
  Write-Need "Windows will ask for permission to install Git. Click Yes."
  if (-not (Invoke-Elevated $exe @("/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-") "Git")) {
    Write-Detail "git" "Not installed — the permission prompt was cancelled or the installer failed"
    Write-Step "git" "fail"; Finish "fail"
  }

  Write-Pct 92
  Write-Say "Checking Git actually runs"
  Update-PathFromRegistry
  $c = Check-Git
  if ($c.Ok) {
    Write-Log ("verified: git {0} at {1}" -f $c.Text, (Get-GitBin))
    Write-Detail "git" $c.Text; Write-Step "git" "ok"; Write-Pct 100
    Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    Finish "ok"
  }
  Write-Log "installer finished but git still does not run"
  Write-Detail "git" "The installer finished, but Git still does not run"
  Write-Step "git" "fail"; Finish "fail"
}

# ---------------------------------------------------------------------------- claude code
function Do-Claude {
  $c = Check-Claude
  if ($c.Ok) {
    Write-Step "claude" "ok"; Write-Detail "claude" ("{0} (already installed)" -f $c.Text); Finish "ok"
  }
  Write-Step "claude" "running"; Write-Pct 5
  Write-Say "Installing Claude Code from claude.ai"
  Write-Detail "claude" "Running the official installer"
  Write-Log "irm https://claude.ai/install.ps1 | iex"

  # The vendor's own installer, into the user's profile. No elevation, so nothing here can affect
  # anything outside this account. It runs in a CHILD PowerShell rather than in this one: the
  # installer is written to be piped into iex at a fresh prompt, and this process has already set
  # $ErrorActionPreference = "Stop" and a strict-mode preference it never asked for.
  $ps = "powershell.exe"
  if (-not $OnWindows) { $ps = "pwsh" }
  $r = Invoke-Captured -TimeoutSec 300 -FilePath $ps -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex")
  if ($r.ExitCode -eq 124) { Write-Log "the installer did not return; checking whether it landed anyway" }
  Write-Indented $r.Out
  Write-Indented $r.Err
  Write-Pct 85

  # A fresh install lands in %USERPROFILE%\.local\bin, which this process's PATH predates.
  Update-PathFromRegistry
  if ($env:USERPROFILE) { $env:Path = (Join-Path $env:USERPROFILE ".local\bin") + ";" + $env:Path }
  $c = Check-Claude
  if ($c.Ok) {
    Write-Log ("verified: claude {0} at {1}" -f $c.Text, (Get-ClaudeBin))
    Write-Detail "claude" $c.Text; Write-Step "claude" "ok"; Write-Pct 100; Finish "ok"
  }
  Write-Log "installer ran but claude is not on PATH"
  Write-Detail "claude" "Installed, but not found on PATH — the agents will not run yet"
  Write-Step "claude" "fail"; Finish "fail"
}

# ---------------------------------------------------------------------------- chrome
function Do-Chrome {
  $c = Check-Chrome
  if ($c.Ok) {
    Write-Step "chrome" "ok"; Write-Detail "chrome" ("{0} (already installed)" -f $c.Text); Finish "ok"
  }
  Write-Step "chrome" "running"; Write-Pct 3

  if (Test-HaveWinget) {
    Write-Say "Installing Google Chrome with winget"
    Write-Detail "chrome" "Installing with winget"
    Write-Log "winget install --id Google.Chrome"
    $r = Invoke-Captured -TimeoutSec 600 -FilePath "winget" -ArgumentList @(
      "install", "--id", "Google.Chrome", "--silent",
      "--accept-package-agreements", "--accept-source-agreements")
    Write-Indented $r.Out
    Update-PathFromRegistry
    Write-Pct 45
    $c = Check-Chrome
    if ($c.Ok) {
      Write-Log ("verified: Chrome " + $c.Text)
      Write-Detail "chrome" $c.Text; Write-Step "chrome" "ok"; Write-Pct 100; Finish "ok"
    }
    Write-Log ("winget did not get us Chrome (exit {0}); falling back to google.com" -f $r.ExitCode)
  } else {
    Write-Log "winget is not available here; fetching the Chrome installer from google.com"
  }

  $exe = Join-Path $DL "chrome_installer.exe"
  Write-Say "Downloading Google Chrome"
  Write-Detail "chrome" "Downloading from google.com"
  $url = "https://dl.google.com/chrome/install/latest/chrome_installer.exe"
  Write-Log ("GET " + $url)
  if (-not (Get-RemoteFile $url $exe 10 60)) {
    Write-Detail "chrome" "The download did not finish"; Write-Step "chrome" "fail"; Finish "fail"
  }
  Write-Log ("downloaded " + (Format-Bytes (Get-FileSize $exe)))

  Write-Pct 68
  Write-Say "Checking who signed it"
  # A Chrome that is not signed by Google is not Chrome.
  $sig = Test-Signature $exe @("Google LLC")
  if (-not $sig.Ok) {
    Write-Log ("REFUSED: " + $sig.Why)
    Write-Detail "chrome" "That download was not signed by Google — nothing was installed"
    Write-Step "chrome" "fail"; Finish "fail"
  }
  Write-Log ("signed by " + $sig.Who)
  Write-Detail "chrome" ("Signed by " + $sig.Who)

  Write-Pct 75
  Write-Say "Installing Chrome — Windows will ask for permission first (that is the UAC prompt)"
  Write-Need "Windows will ask for permission to install Chrome. Click Yes."
  if (-not (Invoke-Elevated $exe @("/silent", "/install") "Google Chrome")) {
    Write-Detail "chrome" "Not installed — the permission prompt was cancelled or the installer failed"
    Write-Step "chrome" "fail"; Finish "fail"
  }

  Write-Pct 92
  Write-Say "Checking Chrome is there"
  $c = Check-Chrome
  if ($c.Ok) {
    Write-Log ("verified: Chrome " + $c.Text)
    Write-Detail "chrome" $c.Text; Write-Step "chrome" "ok"; Write-Pct 100
    Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    Finish "ok"
  }
  Write-Log "installer finished but chrome.exe is nowhere it should be"
  Write-Detail "chrome" "Installed, but Chrome was not found afterwards"
  Write-Step "chrome" "fail"; Finish "fail"
}

# ---------------------------------------------------------------------------- configure
function Do-Configure {
  Write-Step "configure" "running"; Write-Pct 10

  Write-Say "Creating your settings file"
  if ((-not (Test-Path -LiteralPath $ConfigFile)) -and (Test-Path -LiteralPath $ExampleFile)) {
    Copy-Item -LiteralPath $ExampleFile -Destination $ConfigFile -Force
    Write-Log "created config\job-seeker.config.md from the example"
  } else {
    Write-Log "config\job-seeker.config.md already exists — left untouched"
  }

  Write-Pct 35
  Write-Say "Making `"jobseeker`" work in Claude Code from any folder"
  $installer = Join-Path $PSScriptRoot "install-global-agent.ps1"
  $ps = "powershell.exe"
  if (-not $OnWindows) { $ps = "pwsh" }
  $r = Invoke-Captured -FilePath $ps -ArgumentList @(
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $installer)
  # As the bash does with >>"$WORK/setup.log": the sub-installer's own chatter belongs in the full
  # log, not in the step transcript the window renders.
  try {
    [IO.File]::AppendAllText($FullLog, ($r.Out + "`n" + $r.Err + "`n"), $Utf8NoBom)
  } catch { }
  if ($r.ExitCode -eq 0) {
    Write-Log "installed the global jobseeker agent into ~\.claude\agents"
  } else {
    Write-Log "global agent not installed - a file we did not write is already at ~\.claude\agents\jobseeker.md"
  }

  Write-Pct 60
  Write-Say "Creating your data folder"
  New-Item -ItemType Directory -Force -Path (Join-Path $Repo "data") | Out-Null
  New-Item -ItemType Directory -Force -Path $Work | Out-Null
  Write-Log "data\ and data\.setup\ are in place"
  # data\.bridge.token is deliberately NOT created here. server/bridge.mjs mints it on first need
  # and writes it atomically with the right permissions; a placeholder written now would either be
  # ignored or, worse, be a secret this script chose.

  # The Mac twin installs a LaunchAgent here and HARD-FAILS if it cannot, because on macOS the
  # browser grant is keyed to the process that asks and an ad-hoc-signed app changes identity on
  # every update. Windows has no TCC and no such agent: Chrome is driven by the JobSeeker Bridge
  # extension over a localhost bridge, which the user loads and pairs from the dashboard whenever
  # they want it. So that branch does not exist here — and this step must never fail over Chrome.
  Write-Detail "configure" "Chrome is connected later, from Settings ▸ Browser — nothing to do now"

  Write-Pct 90
  $c = Check-Configure
  if ($c.Ok) {
    Write-Detail "configure" $c.Text; Write-Step "configure" "ok"; Write-Pct 100; Finish "ok"
  }
  Write-Detail "configure" "Something did not stick — see the log"
  Write-Step "configure" "fail"; Finish "fail"
}

# ---------------------------------------------------------------------------- start
function Do-Start {
  Write-Step "start" "running"; Write-Pct 10
  $port = Get-DashboardPort
  $node = Get-NodeBin
  if (-not $node) {
    Write-Detail "start" "Node is not installed"; Write-Step "start" "fail"; Finish "fail"
  }

  $c = Check-Start
  if ($c.Ok) {
    Write-Log ("already answering on port " + $port)
    Write-Detail "start" ("Already running on port {0}" -f $port)
    Write-Step "start" "ok"; Write-Pct 100; Finish "ok"
  }

  # If the port is taken by another JobSeeker, ours cannot bind and the failure would read as
  # "JobSeeker stopped while starting up". Name the real problem instead.
  $any = Get-Url ("http://127.0.0.1:{0}" -f $port) 2
  if ($any) {
    $who = Get-Url ("http://127.0.0.1:{0}/_whoami" -f $port) 2
    $other = ""
    if ($who) { try { $other = (ConvertFrom-Json $who).root } catch { $other = "" } }
    $whoText = "an unknown server"
    if ($other) { $whoText = $other }
    Write-Log ("port {0} is already in use by {1}" -f $port, $whoText)
    if ($other) {
      Write-Detail "start" ("Another JobSeeker is running from {0} — quit it first." -f $other)
    } else {
      Write-Detail "start" ("Something else is already using port {0}." -f $port)
    }
    Write-Step "start" "fail"; Finish "fail"
  }

  Write-Say "Starting JobSeeker"
  $dash = Join-Path $Repo "server\dashboard.mjs"
  Write-Log ("{0} server\dashboard.mjs (port {1})" -f $node, $port)
  $serverLog = Join-Path $Work "server.log"
  $serverErr = Join-Path $Work "server.err.log"
  $sp = @{
    FilePath               = $node
    ArgumentList           = (ConvertTo-CmdLine @($dash))
    WorkingDirectory       = $Repo
    RedirectStandardOutput = $serverLog
    RedirectStandardError  = $serverErr
    PassThru               = $true
  }
  # -WindowStyle Hidden is what keeps a console from flashing up; pwsh on macOS rejects it outright,
  # and the smoke test for this step runs there, so it is added only where it means something.
  if ($OnWindows) { $sp["WindowStyle"] = "Hidden" } else { $sp["NoNewWindow"] = $true }
  $proc = $null
  try {
    $proc = Start-Process @sp
  } catch {
    Write-Log ("could not start the server: " + $_.Exception.Message)
    Write-Detail "start" "JobSeeker would not start"; Write-Step "start" "fail"; Finish "fail"
  }
  [IO.File]::WriteAllText((Join-Path $Work "server.pid"), [string]$proc.Id, $Utf8NoBom)
  Write-Log ("server pid " + $proc.Id)

  # The Mac twin also spawns a watchdog that kills the server when the app's pid dies, so quitting
  # the window is the whole quit story there. That is NOT ported, on purpose: on Windows the setup
  # window is a step in an install, not the application, and the dashboard is a browser page the
  # user is about to be sent to. Killing the server as the installer's last act would close the very
  # thing that was just started. The extra argument the Mac passes here (the app's pid) is accepted
  # and ignored, so the two callers can stay identical.

  # Wait for it to ANSWER, not merely to have been started. A window opened on a connection error
  # is worse than a window opened a second later.
  for ($i = 1; $i -le 60; $i++) {
    $c = Check-Start
    if ($c.Ok) {
      Write-Log ("answering on http://127.0.0.1:{0}" -f $port)
      Write-Detail "start" ("Running on port {0}" -f $port)
      Write-Step "start" "ok"; Write-Pct 100; Finish "ok"
    }
    if ($proc.HasExited) {
      # Node writes the reason to stderr, so read THAT file. Pointing at server.log was wrong: it is
      # where stdout goes, and a server that dies before it can announce itself never writes a line
      # there. "JobSeeker stopped while starting up" beside an empty file explains nothing.
      $why = ""
      if (Test-Path -LiteralPath $serverErr) {
        $why = (Get-Content -LiteralPath $serverErr -Tail 25 -ErrorAction SilentlyContinue) -join " "
      }
      Write-Indented $why
      if ($why -match "EADDRINUSE") {
        # Someone already has the port. If that someone is this very install, the work is done and
        # starting a second copy was the mistake -- not something to report as a failure.
        $again = Check-Start
        if ($again.Ok) {
          Write-Log ("port {0} was already serving this install; using the one that is running" -f $port)
          Write-Detail "start" ("Already running on port {0}" -f $port)
          Write-Step "start" "ok"; Write-Pct 100; Finish "ok"
        }
        Write-Log ("port {0} is in use by something else" -f $port)
        Write-Detail "start" ("Port {0} is already taken by another program. Close it, or set dashboard_port in config\job-seeker.config.md." -f $port)
        Write-Step "start" "fail"; Finish "fail"
      }
      Write-Log "the server exited while starting - see data\.setup\server.err.log"
      Write-Detail "start" ("JobSeeker stopped while starting up" + $(if ($why) { " - " + ($why -replace "\s+", " ").Substring(0, [Math]::Min(120, $why.Length)) } else { "" }))
      Write-Step "start" "fail"; Finish "fail"
    }
    Write-Pct (10 + $i)
    Start-Sleep -Milliseconds 300
  }
  Write-Log "timed out waiting for the server to answer"
  Write-Detail "start" ("Started, but never answered on port {0}" -f $port)
  Write-Step "start" "fail"; Finish "fail"
}

# ---------------------------------------------------------------------------- extension
# Connecting the JobSeeker Bridge extension: everything around the two clicks Chrome insists a
# person makes, and then a proof that it worked.
#
# CHROME NO LONGER LETS A PROGRAM ADD AN UNPACKED EXTENSION. That is not a guess or a policy
# preference, it is what four routes measured on Chrome 152.0.7977.83 (Windows 11 ARM) did:
#
#   * chrome.exe --load-extension=<dir>
#       Installs nothing. Google removed the switch, and
#       --disable-features=DisableLoadExtensionCommandLineSwitch does not bring it back: after the
#       run the profile's extension list was empty.
#   * HKCU\Software\Google\Chrome\Extensions\<id>, `path` to a packed .crx plus `version`
#       The external-extension registry route. Does not install it.
#   * Enterprise policy force-install with a local update manifest
#       ExtensionInstallForcelist + ExtensionInstallAllowlist + ExtensionAllowedTypes and a
#       file:/// update.xml pointing at a locally packed .crx, tried at BOTH
#       HKCU\Software\Policies\Google\Chrome and HKLM\SOFTWARE\Policies\Google\Chrome.
#       Does not install it.
#   * chrome.exe --pack-extension=<dir>
#       This one works and produces a .crx and a .pem -- but nothing above will install that .crx
#       automatically, so packing buys nothing on its own.
#
# So on Chrome 152 the only way in is a human at chrome://extensions with Developer mode on and
# Load unpacked. A Chrome Web Store listing is the one thing that would remove that step, and it is
# a later phase, not this one.
#
# What this step does is everything else -- make sure a bridge is listening, mint the pairing code,
# put the folder path on the clipboard, open chrome://extensions, say plainly what to click -- and
# then watch /bridge/status until it says connected. It reports success only when it did.
#
# A timeout is not a failure. Chrome is optional on Windows and the same thing can be finished at
# any time from Settings > Browser > Connect, so the step finishes as skipped and setup carries on.
function Do-Extension {
  Write-Step "extension" "running"; Write-Pct 3

  $extDir = Join-Path $Repo "extension"
  if (-not (Test-Path -LiteralPath (Join-Path $extDir "manifest.json"))) {
    Write-Log ("no extension\manifest.json under " + $Repo)
    Write-Detail "extension" "The extension folder is missing from this checkout"
    Write-Step "extension" "fail"; Finish "fail"
  }

  # Chrome is optional here, so from this point on nothing may stop the install. Every way out
  # below is a skip, and every one of them names where the user can finish the job later.
  $chromeExe = Get-ChromeExe
  if (-not $chromeExe) {
    Write-Log "Chrome is not installed; there is nothing to load the extension into"
    Write-Detail "extension" "Chrome is not installed — you can connect this later from Settings ▸ Browser"
    Write-Step "extension" "skip"; Write-Pct 100; Finish "ok"
  }
  $node = Get-NodeBin
  if (-not $node) {
    Write-Log "no node, so no bridge and no pairing code"
    Write-Detail "extension" "Node is not installed — you can connect this later from Settings ▸ Browser"
    Write-Step "extension" "skip"; Write-Pct 100; Finish "ok"
  }

  $st = Get-BridgeState
  if ($st.Connected) {
    Write-Log ("already connected, on port " + $st.Port)
    Write-Detail "extension" "Already connected"
    Write-Step "extension" "ok"; Write-Pct 100; Finish "ok"
  }

  # ---- make sure a bridge is listening ----
  # Normally the dashboard is already up and answering /bridge/status on dashboard_port, because
  # `start` ran before this step. The standalone bridge is the fallback for the run where it did not.
  Write-Pct 12
  if (-not $st.Answered) {
    Write-Say "Starting the browser bridge"
    $bridgeJs = Join-Path $Repo "server\bridge.mjs"
    $sp = @{
      FilePath               = $node
      ArgumentList           = (ConvertTo-CmdLine @($bridgeJs, "--serve"))
      WorkingDirectory       = $Repo
      RedirectStandardOutput = (Join-Path $Work "bridge.log")
      RedirectStandardError  = (Join-Path $Work "bridge.err.log")
      PassThru               = $true
    }
    # Same hidden start as do_start: -WindowStyle Hidden is what stops a console flashing up, and
    # pwsh on macOS (where the smoke test runs) rejects it outright.
    if ($OnWindows) { $sp["WindowStyle"] = "Hidden" } else { $sp["NoNewWindow"] = $true }
    $proc = $null
    try { $proc = Start-Process @sp } catch { $proc = $null }
    if ($proc) { Write-Log ("bridge pid " + $proc.Id) }
    # It is deliberately NOT stopped at the end of this step: killing it would disconnect the very
    # extension the step just connected. With nothing polling it, it exits on its own after 15 min.
    for ($i = 1; $i -le 40; $i++) {
      $st = Get-BridgeState
      if ($st.Answered) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not $st.Answered) {
      Write-Log "nothing answered /bridge/status - see data\.setup\bridge.err.log"
      Write-Detail "extension" "The browser bridge did not start — you can connect this later from Settings ▸ Browser"
      Write-Step "extension" "skip"; Write-Pct 100; Finish "ok"
    }
  }
  Write-Log ("bridge answering on port " + $st.Port)

  # ---- mint a pairing code ----
  # mintPairingCode() writes data\.bridge.pair.json, which is the same file the running bridge reads
  # when the extension posts a code, so minting out of process is exactly as good as asking the
  # bridge to do it. The snippet travels in an environment variable because 5.1's argument binder
  # mangles the quotes in it on a command line.
  Write-Pct 25
  Write-Say "Making a pairing code"
  # The module path is derived from the working directory rather than passed as an argument, and
  # that is not a style choice: under `node -e` process.argv[1] is the first USER argument, and
  # bridge.mjs treats "argv[1] resolves to me" as "I was run directly" and exits with a usage line.
  # Handing it its own path would make it refuse to be imported.
  $snippet = 'const p=require("path"),{pathToFileURL}=require("url");import(pathToFileURL(p.join(process.cwd(),"server","bridge.mjs")).href).then(m=>m.mintPairingCode(process.argv[1])).then(x=>console.log(x.code)).catch(e=>{console.error(e&&e.message?e.message:String(e));process.exit(1)})'
  $r = Invoke-NodeSnippet -Snippet $snippet -ArgumentList @((Get-DataDir))
  $code = ""
  if ($r.ExitCode -eq 0 -and $r.Out -match '(\d{6})') { $code = $Matches[1] }
  if (-not $code) {
    Write-Log ("could not mint a pairing code: " + $r.Err)
    Write-Detail "extension" "Could not make a pairing code — you can connect this later from Settings ▸ Browser"
    Write-Step "extension" "skip"; Write-Pct 100; Finish "ok"
  }
  Write-Log "pairing code issued"

  # ---- hand the two clicks to the user, with as little typing as possible ----
  Write-Pct 35
  $copied = $true
  try { Set-Clipboard -Value $extDir } catch { $copied = $false }
  if ($copied) { Write-Log ("copied to the clipboard: " + $extDir) }
  else { Write-Log ("could not reach the clipboard; the folder is " + $extDir) }

  Write-Say "Opening chrome://extensions"
  try {
    Start-Process -FilePath $chromeExe -ArgumentList (ConvertTo-CmdLine @("chrome://extensions")) | Out-Null
  } catch {
    Write-Log ("could not open Chrome: " + $_.Exception.Message)
  }

  # The extension looks for the bridge on 4319 then 4320 by itself. Any other port has to be typed
  # into its "Dashboard port" field, so say so rather than leaving a silent dead end.
  $portNote = ""
  if ($st.Port -ne "4319" -and $st.Port -ne "4320") {
    $portNote = " Set Dashboard port to " + $st.Port + " in the options first."
  }
  $where = "paste the folder path (already copied)"
  if (-not $copied) { $where = "choose " + $extDir }

  Emit ("::code " + $code)
  Write-Need ("In Chrome: turn on Developer mode (top right), click Load unpacked and " + $where +
    ". Then open JobSeeker Bridge ▸ Details ▸ Extension options, type this code and click Connect." + $portNote)
  Write-Detail "extension" "Waiting for you to load it in Chrome"

  # ---- wait for it to actually connect ----
  # The only thing that ends this loop with a success is /bridge/status saying connected. There is
  # no "it probably worked" branch: the whole point of the step is that it does not have to guess.
  Write-Pct 45
  Write-Say "Waiting for the extension to connect"
  $deadline = (Get-Date).AddMinutes(5)
  $i = 0
  while ((Get-Date) -lt $deadline) {
    $i = $i + 1
    $st = Get-BridgeState
    if ($st.Connected) {
      Write-Log ("connected on port " + $st.Port)
      Write-Detail "extension" "Connected to Chrome"
      Write-Step "extension" "ok"; Write-Pct 100; Finish "ok"
    }
    Write-Pct ([Math]::Min(95, 45 + [int]($i / 3)))
    Start-Sleep -Seconds 2
  }
  Write-Log "gave up waiting; nothing ever reported connected"
  Write-Detail "extension" "Not connected yet — finish this any time from Settings ▸ Browser ▸ Connect"
  Write-Step "extension" "skip"; Write-Pct 100; Finish "ok"
}

# ---------------------------------------------------------------------------- whatsapp
# Everything here is OPTIONAL and only runs if the user asks for it on the WhatsApp screen.
#
# The plugin is a third party's (Rich627/whatsapp-claude-plugin) and JobSeeker neither ships nor
# maintains it, so this installs it by name, from its own marketplace, and the window links to the
# author's page. It also needs bun -- the plugin's MCP server is launched with `bun run`, not node
# -- which is why bun is installed here rather than as a JobSeeker prerequisite: nobody who skips
# WhatsApp should be made to install a second runtime.
function Do-Whatsapp([string]$Phone) {
  Write-Step "whatsapp" "running"
  Write-Pct 5

  # Already linked? Do not touch it. Re-pairing a working channel to show a nicer screen would be
  # the worst possible trade.
  if (Test-WaPaired) {
    $n = Get-WaNumber
    Write-Log "already paired - leaving the existing link alone"
    if ($n) { Write-Detail "whatsapp" ("connected as +{0}" -f $n) } else { Write-Detail "whatsapp" "connected" }
    Write-Step "whatsapp" "ok"; Write-Pct 100; Finish "ok"
  }

  if (-not ($Phone -match '^\d+$')) {
    Write-Log ("refusing: '{0}' is not digits only" -f $Phone)
    Write-Detail "whatsapp" "Enter your number in digits only, with the country code and no plus sign."
    Write-Step "whatsapp" "fail"; Finish "fail"
  }

  # ---- bun ----
  Write-Pct 12
  $bun = Get-BunBin
  if ($bun) {
    $bv = Invoke-Captured -FilePath $bun -ArgumentList @("--version")
    Write-Log ("bun {0} already installed" -f $bv.Out.Trim())
  } else {
    Write-Say "Installing bun, which the WhatsApp plugin runs on"
    Write-Log "irm bun.sh/install.ps1 | iex"
    $ps = "powershell.exe"
    if (-not $OnWindows) { $ps = "pwsh" }
    $r = Invoke-Captured -FilePath $ps -ArgumentList @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm bun.sh/install.ps1 | iex")
    Write-Indented $r.Out
    Write-Indented $r.Err
    Update-PathFromRegistry
    if ($env:USERPROFILE) { $env:Path = (Join-Path $env:USERPROFILE ".bun\bin") + ";" + $env:Path }
    $bun = Get-BunBin
    if (-not $bun) {
      Write-Detail "whatsapp" "bun did not install — the WhatsApp plugin cannot run without it"
      Write-Step "whatsapp" "fail"; Finish "fail"
    }
    $bv = Invoke-Captured -FilePath $bun -ArgumentList @("--version")
    Write-Log ("installed bun " + $bv.Out.Trim())
  }

  # ---- the plugin ----
  Write-Pct 30
  $claude = Get-ClaudeBin
  if (-not $claude) {
    Write-Detail "whatsapp" "Claude Code is not installed, and the plugin lives inside it"
    Write-Step "whatsapp" "fail"; Finish "fail"
  }
  Write-Say "Adding the plugin marketplace"
  Write-Log ("claude plugin marketplace add " + $WaPluginRepo)
  $r = Invoke-Captured -FilePath $claude -ArgumentList @("plugin", "marketplace", "add", $WaPluginRepo)
  Write-Indented $r.Out
  Write-Indented $r.Err
  Write-Pct 45
  Write-Say "Installing the WhatsApp plugin"
  Write-Log ("claude plugin install " + $WaPlugin)
  $r = Invoke-Captured -FilePath $claude -ArgumentList @("plugin", "install", $WaPlugin)
  Write-Indented $r.Out
  Write-Indented $r.Err
  $list = Invoke-Captured -FilePath $claude -ArgumentList @("plugin", "list")
  if (-not ($list.Out -match "whatsapp-claude-channel")) {
    Write-Detail "whatsapp" "The plugin did not install — see the log"
    Write-Step "whatsapp" "fail"; Finish "fail"
  }
  Write-Log "plugin installed"

  # ---- the number ----
  # This is all that /whatsapp-claude-channel:configure <number> does: one line in one file. No
  # Claude session is needed for it, so the window writes it directly.
  Write-Pct 55
  New-Item -ItemType Directory -Force -Path $WaDir | Out-Null
  # The Mac's chmod 700 has no direct equivalent; the closest true statement on NTFS is "break
  # inheritance, and grant this user alone". Best-effort, exactly as the chmod was: a folder whose
  # ACL could not be tightened is logged, never fatal — the alternative is refusing to set up
  # WhatsApp on a machine whose drive is FAT32 or whose policy owns the ACLs.
  if ($OnWindows -and $env:USERNAME) {
    $acl = Invoke-Captured -FilePath "icacls.exe" -ArgumentList @(
      $WaDir, "/inheritance:r", "/grant:r", ("{0}:(OI)(CI)F" -f $env:USERNAME))
    if ($acl.ExitCode -ne 0) { Write-Log ("could not tighten permissions on " + $WaDir) }
  }
  $envFile = Join-Path $WaDir ".env"
  $lines = @()
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in [IO.File]::ReadAllLines($envFile)) {
      if (-not ($line -match '^WHATSAPP_PHONE_NUMBER=')) { $lines += $line }
    }
  }
  $lines += ("WHATSAPP_PHONE_NUMBER=" + $Phone)
  [IO.File]::WriteAllText($envFile, (($lines -join "`n") + "`n"), $Utf8NoBom)
  Write-Log "wrote the number to ~\.whatsapp-channel\.env"

  # ---- ask WhatsApp for a pairing code ----
  # Starting the plugin's server is what makes WhatsApp issue one; the server appends it to
  # pairing.log. Only lines written AFTER this moment count -- the file keeps old codes, and
  # showing a dead one would send someone to their phone to type a code that cannot work.
  Write-Pct 65
  $userHome = $env:USERPROFILE
  if (-not $userHome) { $userHome = $HOME }
  $marketplaces = Join-Path $userHome ".claude\plugins\marketplaces"
  $pluginDir = ""
  if (Test-Path -LiteralPath $marketplaces) {
    $hit = Get-ChildItem -LiteralPath $marketplaces -Directory -Recurse -Depth 1 -Filter "whatsapp-claude-plugin" -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit) { $pluginDir = $hit.FullName }
  }
  if (-not $pluginDir) {
    Write-Detail "whatsapp" "Cannot find the installed plugin"
    Write-Step "whatsapp" "fail"; Finish "fail"
  }

  # Another channel server -- usually a Claude Code session with the plugin loaded -- holds this
  # lock and the same auth files. Two of them racing to register a device is how you end up with a
  # half-written credential and no working link, so stop instead.
  $lockFile = Join-Path $WaDir ".server.lock"
  if (Test-Path -LiteralPath $lockFile) {
    $lockPid = ""
    try { $lockPid = ([string](Get-Content -LiteralPath $lockFile -TotalCount 1)).Trim() } catch { $lockPid = "" }
    $alive = $null
    $n = 0
    if ($lockPid -and [int]::TryParse($lockPid, [ref]$n)) { $alive = Get-Process -Id $n -ErrorAction SilentlyContinue }
    if ($alive) {
      Write-Log ("another WhatsApp channel server is running (pid {0})" -f $lockPid)
      Write-Detail "whatsapp" "Quit Claude Code first — it is already running the WhatsApp channel."
      Write-Step "whatsapp" "fail"; Finish "fail"
    }
    $lockWho = "unknown"
    if ($lockPid) { $lockWho = $lockPid }
    Write-Log ("clearing a stale lock (pid {0} is gone)" -f $lockWho)
    Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
  }

  $pairingLog = Join-Path $WaDir "pairing.log"
  $before = 0
  if (Test-Path -LiteralPath $pairingLog) {
    try { $before = @([IO.File]::ReadAllLines($pairingLog)).Count } catch { $before = 0 }
  }
  Write-Say "Asking WhatsApp for a pairing code"
  # Same command the bash runs. Its `nohup ... >>` appends; Start-Process can only truncate, so the
  # server's log is per-attempt here rather than cumulative — the pairing.log this reads for the
  # code is the plugin's own file either way, and that one still appends.
  $waLog = Join-Path $Work "whatsapp-server.log"
  $waErr = Join-Path $Work "whatsapp-server.err.log"
  $sp = @{
    FilePath               = $bun
    ArgumentList           = (ConvertTo-CmdLine @("run", "--cwd", $pluginDir, "--shell=bun", "--silent", "start"))
    WorkingDirectory       = $pluginDir
    RedirectStandardOutput = $waLog
    RedirectStandardError  = $waErr
    PassThru               = $true
  }
  if ($OnWindows) { $sp["WindowStyle"] = "Hidden" } else { $sp["NoNewWindow"] = $true }
  $server = $null
  try {
    $server = Start-Process @sp
  } catch {
    Write-Log ("could not start the channel server: " + $_.Exception.Message)
    Write-Detail "whatsapp" "The WhatsApp channel server would not start"
    Write-Step "whatsapp" "fail"; Finish "fail"
  }
  Write-Log ("channel server pid " + $server.Id)

  $code = ""
  for ($i = 1; $i -le 60; $i++) {
    if (Test-Path -LiteralPath $pairingLog) {
      try {
        $all = @([IO.File]::ReadAllLines($pairingLog))
        for ($j = $all.Count - 1; $j -ge $before; $j--) {
          if ($all[$j] -match 'PAIRING CODE: ([A-Z0-9-]+)') { $code = $Matches[1]; break }
        }
      } catch { }
      if ($code) { break }
    }
    if ($server.HasExited) { Write-Log "the channel server exited early"; break }
    Write-Pct (65 + [int]($i / 4))
    Start-Sleep -Seconds 1
  }

  if (-not $code) {
    Stop-ProcessTree $server
    Write-Log "no pairing code appeared within 60s"
    Write-Detail "whatsapp" "WhatsApp did not send a code. Check the number and try again."
    Write-Step "whatsapp" "fail"; Finish "fail"
  }
  Write-Log "pairing code issued"
  Emit ("::code " + $code)
  Write-Need "Open WhatsApp on your phone and enter this code. It expires in a couple of minutes."
  Write-Pct 85

  # ---- wait for the phone ----
  Write-Say "Waiting for your phone"
  for ($i = 1; $i -le 150; $i++) {
    if (Test-WaPaired) {
      Stop-ProcessTree $server
      Write-Log "paired"
      Write-Detail "whatsapp" "Connected"
      Write-Step "whatsapp" "ok"; Write-Pct 100; Finish "ok"
    }
    Start-Sleep -Seconds 2
  }
  Stop-ProcessTree $server
  Write-Log "gave up waiting for the phone"
  Write-Detail "whatsapp" "The code was not entered in time. You can try again."
  Write-Step "whatsapp" "fail"; Finish "fail"
}

# ============================================================================ dispatch
$cmd = ""
if ($args.Count -ge 1) { $cmd = [string]$args[0] }
$arg1 = ""
if ($args.Count -ge 2) { $arg1 = [string]$args[1] }

switch ($cmd) {
  "check-all" { Do-CheckAll }
  "node" { Do-Node }
  "git" { Do-Git }
  "claude" { Do-Claude }
  "chrome" { Do-Chrome }
  "configure" { Do-Configure }
  "start" { Do-Start }          # the Mac passes its app pid as $arg1; there is no watchdog here
  "extension" { Do-Extension }
  "whatsapp" { Do-Whatsapp $arg1 }
  default {
    [Console]::Error.WriteLine("usage: setup-step.ps1 <check-all|node|git|claude|chrome|configure|start|extension|whatsapp <number>>")
    exit 64
  }
}
