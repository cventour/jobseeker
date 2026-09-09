# First-run setup. Gets a fresh Windows PC to a VERIFIED working state, one line per step.
# Twin of scripts/setup.sh — change both together.
#
#   npm run setup                 interactive first run
#   npm run setup -- --dry-run    report only, change nothing
#   npm run setup -- --yes        accept the scheduler prompt (scripted installs)
#   npm run setup -- --verbose    show the underlying commands
#
# Two things it deliberately does NOT do:
#
#   * Install dependencies or runtimes. There are no npm dependencies -- package.json declares none,
#     so `npm install` is a genuine no-op. Runtime prerequisites (Node, Git, Chrome) are CHECKED and
#     reported; installing a runtime or a browser behind a setup script is out of proportion to the
#     problem. The graphical installer does install them, but only after showing the user each one
#     and waiting for a button. (scripts\win\setup-step.ps1 is that half; its header says why the
#     two positions are not in conflict.)
#   * Grant permissions. There is nothing on Windows to grant: no TCC, no Automation consent. Chrome
#     is read through the JobSeeker Bridge extension, which the user loads and pairs themselves --
#     Chrome allows nothing else, and that has been measured rather than assumed. What this script
#     does is everything either side of those two clicks: it stands the bridge up, mints the pairing
#     code, copies the folder path, opens chrome://extensions, and then VERIFIES the result.
#
# The verification is the point. A setup script that accepts "I did it" on trust and prints "Ready"
# reproduces the exact silent-success failure this project exists to prevent.
#
# Windows PowerShell 5.1 and pwsh 7 both: no `??`, no ternaries, no `&&`/`||` chaining. Saved WITH a
# UTF-8 BOM — 5.1 reads a BOM-less file as ANSI and turns every em dash into mojibake.

$ErrorActionPreference = "Stop"
Set-StrictMode -Off
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $Repo

# Invoke-WithTimeout (the probe's watchdog) and ConvertTo-CmdLine (the quoting every native call
# here goes through, because 5.1's own argument binder drops embedded double quotes).
. (Join-Path $PSScriptRoot "lib\timeout.ps1")

$Dry = $false
$AssumeYes = $false
$Verbose = $false
foreach ($a in $args) {
  switch ([string]$a) {
    "--dry-run" { $Dry = $true }
    "--yes" { $AssumeYes = $true }
    "-y" { $AssumeYes = $true }
    "--verbose" { $Verbose = $true }
    "--help" { Get-Content -LiteralPath $PSCommandPath -TotalCount 24 | Select-Object -Skip 1 | ForEach-Object { $_ -replace '^# ?', '' }; exit 0 }
    "-h" { Get-Content -LiteralPath $PSCommandPath -TotalCount 24 | Select-Object -Skip 1 | ForEach-Object { $_ -replace '^# ?', '' }; exit 0 }
  }
}

$OnWindows = ([System.Environment]::OSVersion.Platform -eq "Win32NT")
$ConfigFile = Join-Path $Repo "config\job-seeker.config.md"
$ExampleFile = Join-Path $Repo "config\job-seeker.config.md.example"
$ExtensionDir = Join-Path $Repo "extension"

# ---------------------------------------------------------------- output
function Say([string]$msg) { Write-Host $msg }
function Ok([string]$msg) { Write-Host "  [ok]   " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Done_([string]$msg) { Write-Host "  [done] " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Warn([string]$msg) { Write-Host "  [warn] " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Fail([string]$msg) { Write-Host "  [FAIL] " -ForegroundColor Red -NoNewline; Write-Host $msg }
function Skip([string]$msg) { Write-Host "  [skip] " -ForegroundColor DarkGray -NoNewline; Write-Host $msg }
function Trace([string]$msg) { if ($Verbose) { Write-Host ("  $ " + $msg) -ForegroundColor DarkGray } }

# Native command, stderr swallowed, stdout returned. Wrapped because Windows PowerShell 5.1 turns
# redirected stderr into a terminating error under $ErrorActionPreference = "Stop", and because
# Start-Process with a pre-quoted command line is the only way an argument with a double quote in it
# reaches the child intact on 5.1.
function Invoke-Captured {
  param([string]$FilePath, [string[]]$ArgumentList = @())
  Trace ($FilePath + " " + ($ArgumentList -join " "))
  $outFile = [IO.Path]::GetTempFileName()
  $errFile = [IO.Path]::GetTempFileName()
  try {
    $sp = @{
      FilePath = $FilePath; WorkingDirectory = $Repo
      RedirectStandardOutput = $outFile; RedirectStandardError = $errFile
      NoNewWindow = $true; Wait = $true; PassThru = $true
    }
    $cmdline = ConvertTo-CmdLine $ArgumentList
    if ($cmdline) { $sp["ArgumentList"] = $cmdline }
    $code = 127
    $out = ""
    try {
      $p = Start-Process @sp
      # Touching .Handle while the child is alive is what makes .ExitCode readable afterwards on
      # PowerShell 5.1; without it the property is $null and [int]$null is 0, so every check built
      # on this would report success whatever the child did.
      try { $null = $p.Handle } catch { }
      if ($null -eq $p.ExitCode) { $code = 127 } else { $code = [int]$p.ExitCode }
    } catch { }
    if (Test-Path -LiteralPath $outFile) { $out = [IO.File]::ReadAllText($outFile).TrimEnd("`r", "`n") }
    return @{ ExitCode = $code; Out = $out }
  } finally {
    Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
  }
}

# Is there a human at the keyboard? `npm run setup` reaches this through
# `powershell -NoProfile -NonInteractive -File`, where Read-Host does not prompt — it throws. A
# non-interactive run must take the safe default rather than die on the first question.
function Ask([string]$Prompt, [string]$Default) {
  if ($AssumeYes) { return $true }
  $reply = $null
  try {
    if ([Console]::IsInputRedirected) { throw "no console" }
    $reply = Read-Host ("  " + $Prompt)
  } catch {
    Write-Host ("  {0} " -f $Prompt) -NoNewline
    Write-Host ("(no terminal — assuming {0})" -f $Default) -ForegroundColor DarkGray
    return ($Default -eq "y")
  }
  if (-not $reply) { $reply = $Default }
  return ($reply -match '^[yY]')
}

$Gaps = New-Object System.Collections.ArrayList
$HardFail = $false
$BrowserOk = $false

Say ""
Write-Host "JobSeeker setup" -ForegroundColor White -NoNewline
Say " — checking this machine"
Say ""
if ($Dry) { Write-Host "  (dry run: nothing will be changed)" -ForegroundColor DarkGray; Say "" }

# ---------------------------------------------------------------- 1. prerequisites (check only)
# CHECK ONLY, and deliberately so. Each of these is one download from a vendor the user already
# trusts; naming it and the page it comes from is more useful than installing it silently.

if (-not $OnWindows) {
  Fail ("this script is the Windows half of setup (this is " + [System.Environment]::OSVersion.Platform + "). On a Mac: npm run setup")
  # Not fatal: the parse/lint smoke tests run it under pwsh on macOS, and everything below is
  # either a check or gated on $Dry.
} else {
  Ok ("Windows " + [System.Environment]::OSVersion.Version)
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $r = Invoke-Captured $nodeCmd.Source @("--version")
  if ($r.Out -match '^v(\d+)') {
    $major = [int]$Matches[1]
    if ($major -ge 20) { Ok ("Node {0}            (need >= 20)" -f $r.Out.Trim()) }
    else { Fail ("Node {0} is too old — need 20 or newer. Install from https://nodejs.org" -f $r.Out.Trim()); $HardFail = $true }
  } else {
    Fail "Node did not report a version — reinstall from https://nodejs.org"; $HardFail = $true
  }
} else {
  Fail "Node not found — install from https://nodejs.org"; $HardFail = $true
}

# Git is a hard prerequisite HERE and not on the Mac: Claude Code's Bash tool on Windows is Git
# Bash, so every agent playbook that shells out needs Git for Windows installed.
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
$gitBash = $null
$gitBashDirs = @()
if ($env:ProgramFiles) { $gitBashDirs += (Join-Path $env:ProgramFiles "Git\bin\bash.exe") }
if (${env:ProgramFiles(x86)}) { $gitBashDirs += (Join-Path ${env:ProgramFiles(x86)} "Git\bin\bash.exe") }
if ($env:LOCALAPPDATA) { $gitBashDirs += (Join-Path $env:LOCALAPPDATA "Programs\Git\bin\bash.exe") }
foreach ($p in $gitBashDirs) {
  if (Test-Path -LiteralPath $p) { $gitBash = $p; break }
}
if ($gitCmd) {
  $r = Invoke-Captured $gitCmd.Source @("--version")
  $gv = ($r.Out -replace '^git version\s*', '').Trim()
  if ($OnWindows -and -not $gitBash) {
    Fail "Git is on PATH but Git Bash is not — install Git for Windows from https://git-scm.com/download/win (Claude Code runs its shell through it)"
    $HardFail = $true
  } else {
    Ok ("Git {0}          (Claude Code's shell)" -f $gv)
  }
} else {
  Fail "Git not found — install Git for Windows from https://git-scm.com/download/win (Claude Code runs its shell through it)"
  $HardFail = $true
}

# Chrome is checked the way scripts/browser/extension.mjs finds it, so this and the driver can never
# disagree about whether it is installed.
function Find-ChromeExe {
  if ($OnWindows) {
    $r = Invoke-Captured "reg.exe" @("query", "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe", "/ve")
    if ($r.ExitCode -eq 0 -and $r.Out -match 'REG_SZ\s+(.+\S)\s*$') {
      $p = $Matches[1].Trim()
      if (Test-Path -LiteralPath $p) { return $p }
    }
  }
  foreach ($d in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LocalAppData)) {
    if (-not $d) { continue }
    $p = Join-Path $d "Google\Chrome\Application\chrome.exe"
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}
$chromeExe = Find-ChromeExe
if ($chromeExe) {
  $cv = ""
  try { $cv = (Get-Item -LiteralPath $chromeExe).VersionInfo.ProductVersion } catch { $cv = "" }
  Ok ("Google Chrome " + $cv)
} else {
  # Optional here, unlike the Mac twin, and for a real reason: without Chrome the dashboard, the
  # tracker and every non-browser agent still work. Only WhatsApp Web and LinkedIn reading stop.
  Warn "Google Chrome not found — install from https://google.com/chrome (only WhatsApp Web and LinkedIn reading need it)"
  [void]$Gaps.Add("Chrome not installed — WhatsApp Web and LinkedIn cannot be read")
}

$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claudeCmd -and $env:USERPROFILE) {
  $p = Join-Path $env:USERPROFILE ".local\bin\claude.exe"
  if (Test-Path -LiteralPath $p) { $claudeCmd = @{ Source = $p } }
}
if ($claudeCmd) { Ok ("claude CLI              " + $claudeCmd.Source) }
else { Warn "claude CLI not found    — dashboard works; the agents need it (https://claude.com/claude-code)" }

if ($OnWindows -and -not (Get-Command schtasks -ErrorAction SilentlyContinue)) {
  Fail "schtasks missing — this should not happen on Windows"; $HardFail = $true
}

if ($HardFail) {
  Say ""
  Write-Host "Cannot continue until the items above are installed." -ForegroundColor Red
  Say ""
  exit 1
}

# ---------------------------------------------------------------- 2. changes we may legitimately make

if (Test-Path -LiteralPath $ConfigFile) {
  Ok "config\job-seeker.config.md already exists (left untouched)"
} elseif ($Dry) {
  # Say what WOULD happen. Reporting "created" while creating nothing is the same class of lie as a
  # run that reports ok having read nothing.
  Skip "config\job-seeker.config.md would be created from the example"
} else {
  Copy-Item -LiteralPath $ExampleFile -Destination $ConfigFile -Force
  Done_ "config\job-seeker.config.md created from the example"
}

# Global front door: "jobseeker, ..." from any directory in Claude Code. Safe to re-run; refuses to
# touch a ~\.claude\agents\jobseeker.md it did not write itself.
$psExe = "powershell.exe"
if (-not $OnWindows) { $psExe = "pwsh" }
if ($Dry) {
  Skip "would install the global jobseeker agent into ~\.claude\agents"
} else {
  $r = Invoke-Captured $psExe @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $PSScriptRoot "install-global-agent.ps1"))
  if ($r.ExitCode -eq 0) {
    Done_ "global jobseeker agent -> ~\.claude\agents (works from any directory)"
  } else {
    Warn "global jobseeker agent not installed — a foreign file is already at ~\.claude\agents\jobseeker.md"
  }
}

# ---- how do you want to run it? ---------------------------------------------------------------
# Asked FIRST, because the answer decides how much of the rest is needed at all. Less of this setup
# hangs on the answer than on the Mac — there is no launchd, no second agent and no consent dialog
# to clear — but the choice itself is the same one, and defaulting to the simple path keeps
# scheduling one command away for someone who has not decided to trust it yet.
$TaskName = "JobSeeker\JobRun"
if ($env:JOBSEEKER_TASK_NAME) { $TaskName = $env:JOBSEEKER_TASK_NAME.Trim("\") }
$SchedInstalled = $false
$setSchedule = Join-Path $PSScriptRoot "set-schedule.ps1"

$showed = Invoke-Captured $psExe @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  "-File", $setSchedule, "--show")
if ($showed.ExitCode -eq 0 -and $showed.Out -and $showed.Out.Trim() -ne "not scheduled") {
  Ok ("daily run already scheduled at {0} ({1})" -f $showed.Out.Trim(), $TaskName)
  $SchedInstalled = $true
} elseif ($Dry) {
  Skip "would ask whether to run manually or on a schedule"
} else {
  Say ""
  Write-Host "  How do you want to run it?" -ForegroundColor White
  Say ""
  Say "    Manually  — you run /job-run in Claude Code when you want it. Nothing runs on its own."
  Say "                Needs no scheduled task."
  Say "    Scheduled — it runs itself at 08:00 and sends you a summary. Adds one Task Scheduler"
  Say "                task so it can work while you are away."
  Say ""
  Say "  It never applies to anything and never sends a message without your approval, either way."
  $wantSched = Ask "Schedule it to run daily at 08:00? [y/N]" "n"
  Say ""
  if ($wantSched) {
    # Delegate: scripts\win\set-schedule.ps1 owns the task definition and schtasks, so setup and the
    # dashboard cannot drift into two different behaviours.
    $r = Invoke-Captured $psExe @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", $setSchedule, "08:00")
    if ($r.ExitCode -eq 0) {
      Done_ ("08:00 daily run scheduled ({0})" -f $TaskName)
      $SchedInstalled = $true
    } else {
      Fail "could not schedule the daily run — see docs/SCHEDULER.md"
      [void]$Gaps.Add("daily run not scheduled — run: npm run schedule -- 08:00")
    }
  } else {
    Skip "running manually — add the 08:00 run later with: npm run schedule -- 08:00"
  }
}

# The Mac twin installs a browser LaunchAgent for the scheduled path here, and walks the user
# through Chrome ▸ View ▸ Developer ▸ Allow JavaScript from Apple Events. NEITHER EXISTS ON WINDOWS.
# There is no TCC to grant and no Apple Events to allow: Chrome is read through the JobSeeker Bridge
# extension over a localhost bridge, loaded once by hand. So the permissions dance is replaced by
# the pairing below -- done here rather than described, and then proved by the same probe.

# ---------------------------------------------------------------- 3. the browser extension: explain + verify

# Reads the probe's own verdict rather than inventing a second source of truth.
function Browser-CanRead {
  $snippet = 'try{const b=require("./data/.browser-status.json");process.exit(b.capabilities?.read_page_content?0:1)}catch{process.exit(1)}'
  $env:JOBSEEKER_NODE_SNIPPET = $snippet
  try {
    $r = Invoke-Captured $nodeCmd.Source @("-e", "eval(process.env.JOBSEEKER_NODE_SNIPPET)")
    return ($r.ExitCode -eq 0)
  } finally {
    Remove-Item -Path Env:JOBSEEKER_NODE_SNIPPET -ErrorAction SilentlyContinue
  }
}
function Browser-Blockers {
  $snippet = 'try{const b=require("./data/.browser-status.json");(b.blockers||[]).forEach(x=>console.log(x))}catch{}'
  $env:JOBSEEKER_NODE_SNIPPET = $snippet
  try {
    $r = Invoke-Captured $nodeCmd.Source @("-e", "eval(process.env.JOBSEEKER_NODE_SNIPPET)")
    return $r.Out
  } finally {
    Remove-Item -Path Env:JOBSEEKER_NODE_SNIPPET -ErrorAction SilentlyContinue
  }
}

# ---- connecting the extension, rather than describing it -------------------------------------
# Chrome 152 will not let a program add an unpacked extension: --load-extension is gone, the
# external-extension registry key does not install it, and enterprise force-install with a local
# update manifest does not either. All three were measured, not assumed; scripts\win\setup-step.ps1's
# extension step carries the full list. So the two clicks stay with the user -- but everything
# around them, and the proof that they worked, does not have to.

function Get-ConfigNum([string]$Key, [string]$Default) {
  if (Test-Path -LiteralPath $ConfigFile) {
    foreach ($line in [IO.File]::ReadAllLines($ConfigFile)) {
      if ($line -match ("^" + $Key + ':\s*(\d+)')) { return $Matches[1] }
    }
  }
  return $Default
}

# One GET, short deadline, never throws. 127.0.0.1 and not localhost: the bridge binds the IPv4
# loopback only, and where localhost resolves to ::1 first this would report nothing about a
# perfectly healthy bridge.
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

# The extension probes 4319 then 4320 (extension\background.js) and pairs with whichever answers.
# "connected" is held in the memory of that one process, so both ports are asked and either saying
# yes is the answer.
function Get-BridgeState {
  $ports = @([string](Get-ConfigNum "dashboard_port" "4319"))
  $bp = [string](Get-ConfigNum "bridge_port" "4320")
  if ($ports -notcontains $bp) { $ports += $bp }
  $answered = $false
  $answeredPort = ""
  foreach ($p in $ports) {
    $body = Get-Url ("http://127.0.0.1:{0}/bridge/status" -f $p) 2
    if (-not $body) { continue }
    $j = $null
    try { $j = ConvertFrom-Json $body } catch { $j = $null }
    if (-not $j) { continue }
    if (-not $answered) { $answeredPort = $p }
    $answered = $true
    if ($j.connected) { return @{ Answered = $true; Connected = $true; Port = $p } }
  }
  return @{ Answered = $answered; Connected = $false; Port = $answeredPort }
}

# Returns $true only when /bridge/status actually said connected. Never throws, never blocks setup.
function Connect-Extension {
  if (-not (Test-Path -LiteralPath (Join-Path $ExtensionDir "manifest.json"))) {
    Warn ("no manifest.json under " + $ExtensionDir + " — nothing to load")
    return $false
  }

  $st = Get-BridgeState
  if ($st.Connected) { return $true }

  if (-not $st.Answered) {
    Say "  Starting the browser bridge…"
    $bridgeJs = Join-Path $Repo "server\bridge.mjs"
    $sp = @{
      FilePath               = $nodeCmd.Source
      ArgumentList           = (ConvertTo-CmdLine @($bridgeJs, "--serve"))
      WorkingDirectory       = $Repo
      RedirectStandardOutput = (Join-Path $Repo "data\.setup\bridge.log")
      RedirectStandardError  = (Join-Path $Repo "data\.setup\bridge.err.log")
      PassThru               = $true
    }
    if ($OnWindows) { $sp["WindowStyle"] = "Hidden" } else { $sp["NoNewWindow"] = $true }
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $Repo "data\.setup") | Out-Null
      $null = Start-Process @sp
    } catch {
      Warn ("could not start the browser bridge: " + $_.Exception.Message)
      return $false
    }
    # It is left running on purpose: stopping it here would disconnect whatever just connected. With
    # nothing polling it, it exits by itself after 15 minutes.
    for ($i = 1; $i -le 40; $i++) {
      $st = Get-BridgeState
      if ($st.Answered) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not $st.Answered) {
      Warn "the browser bridge did not start — see data\.setup\bridge.err.log"
      return $false
    }
  }

  # mintPairingCode() writes data\.bridge.pair.json, which is the file the running bridge reads when
  # the extension posts a code back, so minting it from here is as good as asking the bridge to.
  # The module path is derived from the working directory rather than passed as an argument, and
  # that is not a style choice: under `node -e` process.argv[1] is the first USER argument, and
  # bridge.mjs treats "argv[1] resolves to me" as "I was run directly" and exits with a usage line.
  # Handing it its own path would make it refuse to be imported.
  $snippet = 'const p=require("path"),{pathToFileURL}=require("url");import(pathToFileURL(p.join(process.cwd(),"server","bridge.mjs")).href).then(m=>m.mintPairingCode(process.argv[1])).then(x=>console.log(x.code)).catch(e=>{console.error(e&&e.message?e.message:String(e));process.exit(1)})'
  $dataDir = $env:JOBSEEKER_DATA_DIR
  if (-not $dataDir) { $dataDir = Join-Path $Repo "data" }
  $env:JOBSEEKER_NODE_SNIPPET = $snippet
  $code = ""
  try {
    $r = Invoke-Captured $nodeCmd.Source @("-e", "eval(process.env.JOBSEEKER_NODE_SNIPPET)", $dataDir)
    if ($r.ExitCode -eq 0 -and $r.Out -match '(\d{6})') { $code = $Matches[1] }
  } finally {
    Remove-Item -Path Env:JOBSEEKER_NODE_SNIPPET -ErrorAction SilentlyContinue
  }
  if (-not $code) {
    Warn "could not make a pairing code"
    return $false
  }

  $copied = $true
  try { Set-Clipboard -Value $ExtensionDir } catch { $copied = $false }

  try {
    $null = Start-Process -FilePath $chromeExe -ArgumentList (ConvertTo-CmdLine @("chrome://extensions")) -PassThru
  } catch {
    Warn ("could not open Chrome: " + $_.Exception.Message)
  }

  Say ""
  Write-Host "  One step needs you:" -ForegroundColor White
  Say ""
  Say ("    1. In the chrome://extensions tab that just opened, turn on Developer mode (top right)")
  if ($copied) {
    Say ("    2. Click Load unpacked and paste the folder path — it is already on your clipboard:")
    Say ("       " + $ExtensionDir)
  } else {
    Say ("    2. Click Load unpacked and choose: " + $ExtensionDir)
  }
  Say ("    3. Open JobSeeker Bridge ▸ Details ▸ Extension options, and enter this code:")
  Say ""
  Write-Host ("       " + $code) -ForegroundColor White
  if ($st.Port -ne "4319" -and $st.Port -ne "4320") {
    Say ""
    Say ("       (set Dashboard port to " + $st.Port + " in the same options page first)")
  }
  Say ""
  Say "  Loading an unpacked extension and pairing it is a thing only you can do — Chrome"
  Say "  deliberately gives no other program a way to do it for you."
  Say ""

  # A scripted run has nobody at the keyboard to do any of that, so it must not sit here for five
  # minutes pretending otherwise. The instructions above are still printed; only the wait is skipped.
  $noHuman = $false
  try { $noHuman = [Console]::IsInputRedirected } catch { $noHuman = $false }
  if ($noHuman) {
    Skip "not waiting for the extension — no terminal attached"
    return $false
  }

  Say "  Waiting for the extension to connect (up to 5 minutes, Ctrl-C to stop waiting)…"
  $deadline = (Get-Date).AddMinutes(5)
  while ((Get-Date) -lt $deadline) {
    $st = Get-BridgeState
    if ($st.Connected) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

if ($Dry) {
  Skip "would connect the Chrome extension (code, clipboard, chrome://extensions) and verify browser access"
} elseif (-not $chromeExe) {
  Skip "browser check — Chrome is not installed"
} else {
  Say ""
  Say "  Checking browser access…"
  # A probe with no extension paired waits on the bridge; a setup script must never be able to block
  # for minutes on a health check, so it runs under the same 90-second bound the bash gives it.
  $probe = Join-Path $Repo "scripts\browser-do.mjs"
  $null = Invoke-WithTimeout -Seconds 90 -FilePath $nodeCmd.Source -ArgumentList @($probe, "probe") -WorkingDirectory $Repo
  if (Browser-CanRead) {
    $BrowserOk = $true
    Ok "browser verified — read-pages via the JobSeeker Bridge extension"
  } else {
    Fail "browser cannot read page content yet"
    if (Browser-Blockers) { foreach ($b in ((Browser-Blockers) -split "`r?`n")) { if ($b) { Say ("          " + $b) } } }
    # Do the work rather than describe it: bridge up, code minted, path on the clipboard, the page
    # open — and then WAIT for /bridge/status to say connected. Nothing below claims success on
    # anything weaker than that.
    if (Connect-Extension) {
      Done_ "extension connected"
      # Connected is not the same claim as "can read a page", so the probe decides that, again.
      $null = Invoke-WithTimeout -Seconds 90 -FilePath $nodeCmd.Source -ArgumentList @($probe, "probe") -WorkingDirectory $Repo
      if (Browser-CanRead) {
        $BrowserOk = $true
        Ok "browser verified — read-pages via the JobSeeker Bridge extension"
      } else {
        Fail "extension connected, but the browser still cannot read page content"
        if (Browser-Blockers) { foreach ($b in ((Browser-Blockers) -split "`r?`n")) { if ($b) { Say ("          " + $b) } } }
        [void]$Gaps.Add("Chrome extension connected but not reading pages — run: npm run browser:probe")
      }
    } else {
      [void]$Gaps.Add("Chrome extension not connected — load " + $ExtensionDir + ", then Settings ▸ Browser ▸ Connect")
    }
  }
}

# ---------------------------------------------------------------- 4. summary
# A gaps list, never a bare "Ready": the whole point of the verification above is that it can come
# back negative, and a summary that hides that would undo it.

Say ""
if ($Dry) {
  Write-Host "Dry run complete." -ForegroundColor White -NoNewline
  Say " Nothing was changed. Run without --dry-run to apply."
} elseif ($Gaps.Count -eq 0 -and $BrowserOk) {
  Write-Host "Ready." -ForegroundColor Green -NoNewline
  Say " Next: run claude, then /onboard to set your targets and CV."
} else {
  Write-Host "Set up, with gaps:" -ForegroundColor Yellow
  foreach ($g in $Gaps) { if ($g) { Say ("  - " + $g) } }
  Say ""
  Say "  Everything else works. Re-run npm run setup once fixed, or check with:"
  Say "    npm run browser:probe"
}
Say ""
exit 0
