# Windows scheduler entrypoint for the daily job-search pipeline. Twin of scripts/job-run.sh —
# change both together.
#
# Runs the /job-run slash command headless via the Claude Code CLI, from the repo root, so it has
# access to the local Markdown state, the agents in .claude/, and the connected MCP servers.
# Invoked by Task Scheduler (see scripts/win/set-schedule.ps1 and docs/SCHEDULER.md).
#
# Hardening, because an unattended run that dies is invisible — you only notice the digest never
# arrived, possibly days later:
#   * a hard timeout, so a wedged run cannot hold the data/ lock or burn budget indefinitely,
#   * one retry, since most failures here are transient (network, MCP not yet awake after boot),
#   * a spend cap via --max-budget-usd,
#   * a memory guard (scripts/win/rss-guard.ps1) — on 2026-07-29 a fanned-out run spawned `claude`
#     processes that leaked to 15.9/12.0/6.1 GB and took the whole laptop down. The guard kills a
#     runaway child, or aborts the attempt, long before the kernel has to,
#   * data/.job-run.status.json, which server/audit.mjs reads so the supervisor can say
#     "yesterday's scheduled run never finished",
#   * a desktop toast on final failure.
#
# Windows PowerShell 5.1 and pwsh 7 compatible: no `??`, no ternary, no `&&`/`||` chaining.
$ErrorActionPreference = "Stop"

$REPO = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $REPO

. (Join-Path $PSScriptRoot "lib\timeout.ps1")
. (Join-Path $PSScriptRoot "lib\notify.ps1")
. (Join-Path $PSScriptRoot "lib\keepawake.ps1")

$LOG_DIR = Join-Path $REPO "data"
if (-not (Test-Path $LOG_DIR)) { New-Item -ItemType Directory -Path $LOG_DIR | Out-Null }
$LOG    = Join-Path $LOG_DIR ".job-run.log"
$STATUS = Join-Path $LOG_DIR ".job-run.status.json"
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Env-Or([string]$name, [string]$default) {
  $v = [Environment]::GetEnvironmentVariable($name)
  if ($null -eq $v -or $v -eq "") { return $default }
  return $v
}

# ---- PATH and tool resolution ------------------------------------------------------------------
# Task Scheduler gives a minimal environment: `claude` (an npm shim) and `node` are not guaranteed
# to resolve. Prepend the two places the Claude Code installer and npm put their shims, and resolve
# node once rather than at each call site.
$sep = [System.IO.Path]::PathSeparator
foreach ($pair in @(@("USERPROFILE", ".local\bin"), @("APPDATA", "npm"))) {
  $base = Env-Or $pair[0] ""
  if (-not $base) { continue }
  $dir = Join-Path $base $pair[1]
  if (Test-Path $dir) { $env:Path = $dir + $sep + $env:Path }
}
# Claude Code on Windows needs Git's bash for its shell tool; point at it when installed and unset.
# ([IO.Path]::Combine, not Join-Path: Join-Path validates the drive letter and throws off-Windows.)
$gitBash = [System.IO.Path]::Combine((Env-Or "ProgramFiles" "C:\Program Files"), "Git", "bin", "bash.exe")
if (-not $env:CLAUDE_CODE_GIT_BASH_PATH -and (Test-Path -LiteralPath $gitBash -ErrorAction SilentlyContinue)) { $env:CLAUDE_CODE_GIT_BASH_PATH = $gitBash }

function Resolve-Node {
  if ($env:NODE_BIN) { return $env:NODE_BIN }
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return [System.IO.Path]::Combine((Env-Or "ProgramFiles" "C:\Program Files"), "nodejs", "node.exe")
}
$NODE_BIN = Resolve-Node

# Run a child process with argv passed intact (properly quoted), optional stdin, UTF-8 capture.
# Returns @{ ExitCode; StdOut; StdErr }. Never throws on a non-zero exit — callers decide.
function Invoke-Proc {
  param([string]$FilePath, [string[]]$Arguments = @(), [string]$Stdin = $null, [string]$WorkingDirectory = $REPO)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = (ConvertTo-CmdLine $Arguments)
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = ($null -ne $Stdin)
  $psi.StandardOutputEncoding = $Utf8NoBom
  $psi.StandardErrorEncoding = $Utf8NoBom
  $psi.CreateNoWindow = $true
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
  } catch {
    return [PSCustomObject]@{ ExitCode = 127; StdOut = ""; StdErr = ("cannot start " + $FilePath + ": " + $_.Exception.Message) }
  }
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  if ($null -ne $Stdin) {
    try {
      $bytes = $Utf8NoBom.GetBytes($Stdin)
      $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
      $p.StandardInput.BaseStream.Flush()
    } catch { }
    try { $p.StandardInput.Close() } catch { }
  }
  $p.WaitForExit()
  return [PSCustomObject]@{ ExitCode = $p.ExitCode; StdOut = $outTask.Result; StdErr = $errTask.Result }
}
function Invoke-Node([string[]]$Arguments, [string]$Stdin = $null) { return (Invoke-Proc -FilePath $NODE_BIN -Arguments $Arguments -Stdin $Stdin) }

# Tunables (override via the environment, e.g. in the scheduled task's action).
$TIMEOUT_SECS = [int](Env-Or "JOBRUN_TIMEOUT_SECS" "2700")   # 45 min
# Per-run cap. Config is the source of truth so the dashboard can change it; the env var stays as
# an override for one-off manual runs.
$MAX_BUDGET_USD = Env-Or "JOBRUN_MAX_BUDGET_USD" ""
$ATTEMPTS    = [int](Env-Or "JOBRUN_ATTEMPTS" "2")           # initial try + 1 retry
$RETRY_SLEEP = [int](Env-Or "JOBRUN_RETRY_SLEEP" "60")
# How many browser-only careers boards to read per run. Chrome is serial, so this is a budget, not a
# limit on ambition: 15 x ~10s drains the queue over a few days without starving the chat sweep.
$BOARD_SWEEP_MAX     = Env-Or "JOBRUN_BOARD_SWEEP_MAX" "15"
$BOARD_SWEEP_TIMEOUT = [int](Env-Or "JOBRUN_BOARD_SWEEP_TIMEOUT" "900")   # 15 min ceiling on the whole sweep
# Memory guard. Defaults leave plenty of room for a healthy run (the session itself sits around
# 0.5 GB) while catching a leaker within minutes. Set JOBRUN_GUARD=0 to disable.
$GUARD_ENABLED = Env-Or "JOBRUN_GUARD" "1"
$env:GUARD_MAX_RSS_MB   = Env-Or "JOBRUN_GUARD_MAX_RSS_MB" "4096"
$env:GUARD_TOTAL_RSS_MB = Env-Or "JOBRUN_GUARD_TOTAL_RSS_MB" "12288"
# Honour a source the caller already set. The dashboard's "Everything" button invokes this with
# JOBRUN_SOURCE=manual, and an unconditional assignment here overwrote it — so a hand-started run
# was recorded, and gated, as a scheduled one.
$env:JOBRUN_SOURCE = Env-Or "JOBRUN_SOURCE" "scheduled"

# ---- cadence gate -----------------------------------------------------------------------------
# "Every other day" cannot be a Task Scheduler trigger that stays aligned: a daily trigger fires on
# WEEKDAYS the wizard picks, and a 48-hour cycle drifts across the week. So that cadence installs the
# daily task and is enforced here instead — `min_hours_between_runs` in the config, compared against
# the last run's finish.
#
# This sits ABOVE the keep-awake call on purpose. Everything below holds the display on and starts
# spending; a skipped day has to cost nothing and be invisible, or the user watches their PC wake
# each morning for a run that was never going to happen.
#
# Manual runs are never gated. Pressing Run now means run now.
if ($env:JOBRUN_SOURCE -eq "scheduled") {
  $MIN_HOURS = (Invoke-Node @("-e", @'

    const fs=require("fs");
    try{
      const t=fs.readFileSync("config/job-seeker.config.md","utf8");
      const m=/^min_hours_between_runs:[^\S\n]*(.*)$/m.exec(t);
      process.stdout.write(m && m[1] ? m[1].trim() : "");
    }catch{ process.stdout.write(""); }
'@)).StdOut
  if ($MIN_HOURS -match '^[0-9]+$' -and [int]$MIN_HOURS -gt 0) {
    $SINCE = (Invoke-Node @("-e", @'

      const fs=require("fs");
      try{
        const j=JSON.parse(fs.readFileSync("data/.job-run.status.json","utf8"));
        const t=Date.parse(j.finished || j.started || "");
        process.stdout.write(Number.isFinite(t) ? String(Math.floor((Date.now()-t)/3600000)) : "");
      }catch{ process.stdout.write(""); }
'@)).StdOut
    if ($SINCE -match '^[0-9]+$' -and [int]$SINCE -lt [int]$MIN_HOURS) {
      Write-Output ("skipped: last run was " + $SINCE + "h ago and this schedule asks for " + $MIN_HOURS + "h between runs")
      exit 0
    }
  }
}

# Hold the machine awake before touching Chrome. Task Scheduler's WakeToRun (set by set-schedule.ps1)
# brings the PC out of sleep for the trigger, but nothing stops it dozing off again — or the display
# powering down — mid-run while Chrome is being driven. lib/keepawake.ps1 places a SetThreadExecutionState
# request (system + display) that lasts until Stop-KeepAwake in the finally block, or process exit,
# so a crashed run can never pin the machine awake.
$KEEP_AWAKE = Start-KeepAwake

function Get-IsoNow { return [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ") }

function Write-Utf8([string]$path, [string]$text) { [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom) }
function Log([string]$msg) { [System.IO.File]::AppendAllText($LOG, $msg + "`n", $Utf8NoBom) }
function LogBlock([string]$text) { if ($null -ne $text -and $text.Length -gt 0) { Log ($text.TrimEnd("`r", "`n")) } }

# Coverage, not just exit status. A run that read no messages and skipped 33 boards used to write
# state:"ok" and look identical to a complete one — the drought was invisible for 9 runs. These
# fields come from measurement (scripts/browser-probe.mjs, the board registry), never from the
# model's own account of what it did.
function Get-CoverageJson {
  $r = Invoke-Node @("-e", @'

    const fs = require("fs");
    const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
    const b = rd("data/.browser-status.json");
    let queued = null;
    try {
      queued = fs.readFileSync("data/boards.md", "utf8")
        .split("\n")
        .filter((l) => /^\|/.test(l))
        .filter((l) => /\|\s*(browser|blocked)\s*\|/.test(l)).length;
    } catch {}
    process.stdout.write(JSON.stringify({
      browser_mode: b ? (b.capabilities?.read_mechanism ?? "none") : "unknown",
      can_read_pages: b ? Boolean(b.capabilities?.read_page_content) : null,
      chrome_running: b ? b.chrome_running : null,
      chrome_launched_by_us: b ? Boolean(b.chrome_launched_by_us) : null,
      whatsapp_unread: b?.whatsapp?.unread ?? null,
      blockers: b?.blockers ?? [],
      boards_browser_pending: queued,
    }));
  
'@)
  if ($r.ExitCode -eq 0 -and $r.StdOut.Trim().StartsWith("{")) { return $r.StdOut.Trim() }
  return '{"browser_mode":"unknown"}'
}

# What this run could NOT do, as machine-readable slugs. Derived in server/audit.mjs so the shell,
# the dashboard and the digest cannot drift on what "worked" means -- three implementations of that
# question is how a run came to report `ok` while its own coverage said it read nothing.
function Get-GapsJson {
  $a = Invoke-Node @((Join-Path $REPO "server\audit.mjs"), "--gaps")
  # An empty gaps list and a gaps list nobody managed to fetch look identical, and the difference
  # decides the verdict: no gaps means the run is reported ok. So every way of failing to ask says
  # so in the log instead of quietly returning nothing.
  if ($a.ExitCode -ne 0) {
    Write-RunLog ("gaps: audit.mjs exited " + $a.ExitCode + " -- " + ($a.StdErr -replace "\s+", " ").Trim())
    return "[]"
  }
  $raw = $a.StdOut.Trim()
  if (-not $raw) {
    Write-RunLog "gaps: audit.mjs exited 0 but printed nothing"
    return "[]"
  }
  # The bash twin pipes this JSON through a second node to pull out `.gaps`. Here it is parsed in
  # process instead. Feeding one child's output to another child's standard input proved unreliable
  # -- on a Windows CI runner the second process saw nothing, its own try/catch turned that into an
  # empty list, and the run reported ok while its coverage said it had read no pages at all. There
  # is no logic in that hop to keep faithful: it is an extraction, and doing it here cannot silently
  # lose the input.
  try {
    $parsed = $raw | ConvertFrom-Json
  } catch {
    Write-RunLog ("gaps: could not parse the audit's answer -- " + $_.Exception.Message)
    return "[]"
  }
  if ($null -eq $parsed.gaps) { return "[]" }
  return (ConvertTo-Json -InputObject @($parsed.gaps) -Compress)
}

function ConvertTo-JsonString([string]$s) {
  if ($null -eq $s) { return "" }
  return $s.Replace("\", "\\").Replace('"', '\"').Replace("`r", "\r").Replace("`n", "\n").Replace("`t", "\t")
}

function Write-Status { # state, attempts_used, detail, gaps_json
  param([string]$State, [int]$AttemptsUsed, [string]$Detail, [string]$GapsJson = "[]")
  if (-not $GapsJson) { $GapsJson = "[]" }
  $body = "{`n" +
    '  "state": "' + $State + "`",`n" +
    '  "started": "' + $script:STARTED + "`",`n" +
    '  "finished": "' + (Get-IsoNow) + "`",`n" +
    '  "attempts": ' + $AttemptsUsed + ",`n" +
    '  "timeout_secs": ' + $TIMEOUT_SECS + ",`n" +
    '  "detail": "' + (ConvertTo-JsonString $Detail) + "`",`n" +
    '  "gaps": ' + $GapsJson + ",`n" +
    '  "coverage": ' + (Get-CoverageJson) + "`n" +
    "}`n"
  # Atomic. A reader that catches this file half-written sees invalid JSON and reports nothing at
  # all, which looks identical to a run that never happened.
  $tmp = $STATUS + ".tmp"
  Write-Utf8 $tmp $body
  # [NullString]::Value, not $null: PowerShell turns $null into "" for a string parameter.
  if (Test-Path $STATUS) { [System.IO.File]::Replace($tmp, $STATUS, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $STATUS) }
}

function Notify([string]$title, [string]$message) { Show-Toast -Title $title -Body $message }   # best-effort; never fatal

# The WhatsApp MCP server is a STDIO server, so every claude session spawns its own instance — and
# two instances cannot share one WhatsApp device link. Any pre-existing instance therefore blocks
# this run from connecting, and the digest silently fails to send (observed 30 Jul, 31 Jul, 1 Aug:
# three runs in a row printed the digest into a log instead of delivering it).
#
# The blocker is usually NOT a reparented orphan — it is a stale-but-alive interactive session from
# days ago still holding the link. So this reaps every instance found before launching, not just
# ones with a dead parent. That does mean an interactive session open at 08:00 loses WhatsApp for
# the rest of its life; the scheduled digest is the higher priority, and the session gets it back on
# restart. Set JOBRUN_REAP_WHATSAPP=0 to disable.
function Format-Elapsed([TimeSpan]$ts) {
  if ($ts.TotalDays -ge 1) { return ("{0}-{1:00}:{2:00}:{3:00}" -f [int]$ts.Days, $ts.Hours, $ts.Minutes, $ts.Seconds) }
  if ($ts.TotalHours -ge 1) { return ("{0:00}:{1:00}:{2:00}" -f $ts.Hours, $ts.Minutes, $ts.Seconds) }
  return ("{0:00}:{1:00}" -f $ts.Minutes, $ts.Seconds)
}
function Reap-WhatsAppMcp {
  if ((Env-Or "JOBRUN_REAP_WHATSAPP" "1") -ne "1") { Log "whatsapp reaping disabled"; return }
  $found = @()
  try {
    $found = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
      Where-Object { $_.CommandLine -like '*whatsapp-claude-channel*' -and $_.ProcessId -ne $PID })
  } catch {
    Log ("whatsapp MCP: could not enumerate processes (" + $_.Exception.Message + ") — continuing")
    return
  }
  if ($found.Count -eq 0) {
    Log "whatsapp MCP: no pre-existing instance — this run will spawn a clean one"
    return
  }
  foreach ($p in $found) {
    $pp = $p.ParentProcessId
    $owner = "DEAD"
    try { $owner = (Get-Process -Id $pp -ErrorAction Stop).ProcessName } catch { $owner = "DEAD" }
    $age = "?"
    try { if ($p.CreationDate) { $age = Format-Elapsed ((Get-Date) - $p.CreationDate) } } catch { }
    Log ("whatsapp MCP: killing pid " + $p.ProcessId + " (up " + $age + ", parent " + $pp + " [" + $owner + "]) — it holds the device link")
    try { Stop-Process -Id $p.ProcessId -ErrorAction Stop } catch { }
  }
  Start-Sleep -Seconds 2
  foreach ($p in $found) {
    $alive = $false
    try { $null = Get-Process -Id $p.ProcessId -ErrorAction Stop; $alive = $true } catch { }
    if ($alive) { Log ("whatsapp MCP: pid " + $p.ProcessId + " ignored the stop request, forcing"); try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { } }
  }
  Log "whatsapp MCP: link released; claude will spawn a fresh instance on start"
}

$COST_FILE = Join-Path ([System.IO.Path]::GetTempPath()) ("jobrun-cost-" + [guid]::NewGuid().ToString("N"))
$rc = 1
$attempt = 0

try {
  # ---- spend caps -------------------------------------------------------------------------------
  # Read from config/job-seeker.config.md so the dashboard owns them. Falls back to a sane per-run cap
  # and NO monthly ceiling, because a ceiling nobody set must never block a run.
  function Read-ConfigKey([string]$key) {
    $r = Invoke-Node @("-e", @'

    const fs=require("fs");
    try{
      const t=fs.readFileSync("config/job-seeker.config.md","utf8");
      const m=new RegExp("^"+process.argv[1]+":[ \\t]*(.*)$","m").exec(t);
      process.stdout.write(m && m[1] ? m[1].trim() : "");
    }catch{ process.stdout.write(""); }
  
'@, $key)
    if ($r.ExitCode -ne 0) { return "" }
    return $r.StdOut
  }
  if (-not $MAX_BUDGET_USD) { $MAX_BUDGET_USD = Read-ConfigKey "max_spend_per_run_usd" }
  if (-not $MAX_BUDGET_USD) { $MAX_BUDGET_USD = "5" }
  $MONTH_CAP = Read-ConfigKey "max_spend_per_month_usd"

  # Stamped before the ceiling gate, because a refused run still writes a status file and that file
  # needs a start time like any other.
  $script:STARTED = Get-IsoNow

  # ---- monthly ceiling -------------------------------------------------------------------------
  # Checked BEFORE any work starts, because the point is to not spend the money. A blocked run is
  # the one thing here that must never be quiet: it writes its own state, notifies, and says exactly
  # how to lift it. A silent skip would look identical to a run that simply found nothing.
  if ($MONTH_CAP) {
    $ls = Invoke-Node @((Join-Path $REPO "server\record.mjs"), "list-spend")
    $SPENT = (Invoke-Node -Arguments @("-e", @'
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{process.stdout.write(String(JSON.parse(s).month_total_usd||0))}catch{process.stdout.write("0")}})
'@) -Stdin $ls.StdOut).StdOut
    if (-not $SPENT) { $SPENT = "0" }
    $OVER = (Invoke-Node @("-e", 'process.stdout.write(Number(process.argv[1])>=Number(process.argv[2])?"1":"0")', $SPENT, $MONTH_CAP)).StdOut
    if ($OVER -eq "1") {
      Write-Output ("MONTHLY SPEND CEILING REACHED: `$" + $SPENT + " of `$" + $MONTH_CAP + " this month — not starting.")
      Write-Output "Raise max_spend_per_month_usd in the dashboard (Settings) or in config/job-seeker.config.md."
      Write-Status "skipped-budget" 0 ("month-to-date `$" + $SPENT + " reached the `$" + $MONTH_CAP + " ceiling; run not started")
      Notify "JobSeeker did not run" ("Monthly spend ceiling reached (`$" + $SPENT + " of `$" + $MONTH_CAP + "). Raise it in Settings.")
      $null = Invoke-Node @((Join-Path $REPO "server\record.mjs"), "log", "run-skipped", ("monthly spend ceiling reached: `$" + $SPENT + " of `$" + $MONTH_CAP))
      exit 0
    }
    Write-Output ("spend this month: `$" + $SPENT + " of `$" + $MONTH_CAP + " ceiling")
  }

  # Keep the PREVIOUS run's verdict before overwriting it. Without this, anything asking "did the
  # last run work?" during a run reads a file describing the run doing the asking, and gets
  # "running" -- which is exactly how a digest reported its own status file as stuck.
  if (Test-Path $STATUS) { try { Copy-Item $STATUS (Join-Path $LOG_DIR ".job-run.last.json") -Force } catch { } }

  Write-Status "running" 0 "in progress"

  # ---- everything from here lands in data/.job-run.log ------------------------------------------
  Log ("==================== job-run " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " ====================")
  $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claudeCmd) {
    Log "ERROR: 'claude' CLI not found on PATH. Install Claude Code, or add its directory to the scheduled task's PATH."
    Write-Status "failed" 0 "claude CLI not found on PATH"
    Notify "JobSeeker run failed" "claude CLI not found on PATH"
    exit 127
  }
  $CLAUDE_BIN = $claudeCmd.Source
  if (-not $CLAUDE_BIN) { $CLAUDE_BIN = "claude" }
  # npm installs three shims (claude, claude.cmd, claude.ps1); Get-Command may hand back the .ps1,
  # which a plain process launch cannot run. Prefer the .cmd/.exe next to it.
  if ($CLAUDE_BIN -like "*.ps1") {
    foreach ($ext in @(".cmd", ".exe")) {
      $alt = [System.IO.Path]::ChangeExtension($CLAUDE_BIN, $ext)
      if (Test-Path $alt) { $CLAUDE_BIN = $alt; break }
    }
  }

  Reap-WhatsAppMcp

  # Measure browser capability once, up front. Runs before `claude` so the verdict is a fact the
  # run reads rather than a story it invents; exports the summary so the digest cannot contradict
  # it. Never fatal — "no browser" is a reportable outcome, not a failed run.
  $probe = Invoke-Node @((Join-Path $REPO "scripts\browser-probe.mjs"))
  LogBlock ($probe.StdOut + $probe.StdErr)
  if ($probe.ExitCode -ne 0) { Log "browser-probe failed (continuing)" }
  function Get-ReadMech {
    $r = Invoke-Node @("-e", 'try{const b=require("./data/.browser-status.json");process.stdout.write(b.capabilities?.read_mechanism??"none")}catch{process.stdout.write("unknown")}')
    if ($r.ExitCode -ne 0 -or -not $r.StdOut) { return "unknown" }
    return $r.StdOut.Trim()
  }

  # One retry when the first probe finds nothing. The observed failure was a COLD Chrome at 08:00:
  # it had been launched but was still settling, the probe called it a day, and the entire morning
  # ran browser-less -- no WhatsApp, no LinkedIn, boards skipped. Waiting 45s once is far cheaper
  # than losing the day's sweep, and it costs nothing on the normal path where Chrome is already up.
  if ((Get-ReadMech) -eq "none") {
    Log "browser: no read mechanism on first probe — waiting 45s for Chrome to settle, then retrying once"
    Start-Sleep -Seconds 45
    $probe = Invoke-Node @((Join-Path $REPO "scripts\browser-probe.mjs"))
    LogBlock ($probe.StdOut + $probe.StdErr)
  }
  $JOBRUN_BROWSER = Get-ReadMech
  $env:JOBRUN_BROWSER = $JOBRUN_BROWSER
  Log ("browser capability: read-pages via " + $JOBRUN_BROWSER)

  # Drain some of the browser board queue BEFORE claude runs, so the scout reads cached page text
  # instead of being told to "open Chrome" with tools it does not have in a headless run. This is
  # the mechanical half; scoring the listings against the CV stays with role-scout.
  # Skipped entirely when the probe says pages are unreadable — there is nothing it could do.
  if ($JOBRUN_BROWSER -ne "none" -and $JOBRUN_BROWSER -ne "unknown") {
    Log ("---- board sweep (max " + $BOARD_SWEEP_MAX + " boards, oldest first, " + $BOARD_SWEEP_TIMEOUT + "s cap) ----")
    # Hard-capped. Every step inside is bounded, but this runs BEFORE the claude attempt and outside
    # its watchdog — one wedged page must not be able to eat the morning.
    $swOut = $COST_FILE + ".sweep.out"; $swErr = $COST_FILE + ".sweep.err"
    $swRc = 1
    try {
      $swRc = Invoke-WithTimeout -Seconds $BOARD_SWEEP_TIMEOUT -FilePath $NODE_BIN `
        -ArgumentList @((Join-Path $REPO "scripts\board-sweep.mjs"), "--max", "$BOARD_SWEEP_MAX") `
        -StdoutPath $swOut -StderrPath $swErr -WorkingDirectory $REPO
    } catch { Log ("board-sweep could not start: " + $_.Exception.Message); $swRc = 1 }
    foreach ($f in @($swOut, $swErr)) { if (Test-Path $f) { LogBlock ([System.IO.File]::ReadAllText($f)); Remove-Item $f -Force -ErrorAction SilentlyContinue } }
    if ($swRc -ne 0) { Log "board-sweep did not finish cleanly (continuing; the queue is picked up next run)" }
  } else {
    Log ("board sweep skipped: no way to read pages (" + $JOBRUN_BROWSER + ")")
  }

  # Memory guard runs for the life of the attempt, watching everything under the claude process. Its
  # output goes to its own file and is appended to the log afterwards — never into the JSON capture
  # (the bash learned this the hard way: the guard's banner landed ahead of the JSON and silently
  # cost the spend ledger every run).
  $script:guardProc = $null
  $script:guardOut = $COST_FILE + ".guard.out"
  function Start-Guard([int]$childPid) {
    if ($GUARD_ENABLED -ne "1") { return }
    $guardScript = Join-Path $PSScriptRoot "rss-guard.ps1"
    if (-not (Test-Path $guardScript)) { return }
    try {
      $hostExe = (Get-Process -Id $PID).Path
      $script:guardProc = Start-Process -FilePath $hostExe -PassThru -NoNewWindow `
        -ArgumentList (ConvertTo-CmdLine @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $guardScript, "$childPid")) `
        -RedirectStandardOutput $script:guardOut -WorkingDirectory $REPO
    } catch { Log ("rss-guard could not start: " + $_.Exception.Message); $script:guardProc = $null }
  }
  function Stop-Guard {
    if ($script:guardProc) {
      try { if (-not $script:guardProc.HasExited) { Stop-Process -Id $script:guardProc.Id -Force -ErrorAction Stop } } catch { }
      try { $null = $script:guardProc.WaitForExit(5000) } catch { }
      $script:guardProc = $null
    }
    if (Test-Path $script:guardOut) { LogBlock ([System.IO.File]::ReadAllText($script:guardOut)); Remove-Item $script:guardOut -Force -ErrorAction SilentlyContinue }
  }

  for ($attempt = 1; $attempt -le $ATTEMPTS; $attempt++) {
    Log ("---- attempt " + $attempt + "/" + $ATTEMPTS + " (timeout " + $TIMEOUT_SECS + "s, budget `$" + $MAX_BUDGET_USD + ") ----")
    # -p runs a single prompt headlessly and exits. The pipeline queues approvals; it never
    # applies or sends on its own.
    # Tells /job-run this is the scheduled run rather than a manual one, so the run-start row in
    # the activity log says which.
    # --output-format json so the run's ACTUAL cost can be recorded. Previously the log printed
    # the budget LIMIT and never the spend, so "what is this costing me" had no answer and a
    # ceiling across runs was impossible. The JSON carries `result` (the narrative) alongside
    # `total_cost_usd`, so the readable log survives -- extracted back out below.
    $RESP = $COST_FILE + ".resp." + $attempt
    $RESP_ERR = $RESP + ".err"
    # stdout ONLY into $RESP. Mixing stderr in was silently breaking the whole spend ledger: any
    # stderr line the CLI emits (a warning, a notice) landed in the same file as the JSON, so
    # JSON.parse threw, the catch below printed the raw blob, and total_cost_usd was never
    # extracted. Four consecutive runs logged "spend NOT recorded" while their own output carried
    # total_cost_usd 3.8 / 4.9 — which meant data/spend.md stayed empty, Settings reported
    # "$0.00 across 0 runs", and the monthly ceiling could never fire no matter what was spent.
    # stderr goes to the run log, where it is readable but cannot corrupt the payload.
    $savedSource = $env:JOBRUN_SOURCE
    $env:JOBRUN_SOURCE = "scheduled"
    try {
      $rc = Invoke-WithTimeout -Seconds $TIMEOUT_SECS -FilePath $CLAUDE_BIN `
        -ArgumentList @("-p", "/job-run", "--max-budget-usd", "$MAX_BUDGET_USD", "--output-format", "json") `
        -StdoutPath $RESP -StderrPath $RESP_ERR -WorkingDirectory $REPO `
        -OnStarted { param($proc) Start-Guard $proc.Id }
    } catch {
      Log ("claude could not start: " + $_.Exception.Message)
      $rc = 127
    } finally {
      $env:JOBRUN_SOURCE = $savedSource
      Stop-Guard
    }
    if (Test-Path $RESP_ERR) { LogBlock ([System.IO.File]::ReadAllText($RESP_ERR)); Remove-Item $RESP_ERR -Force -ErrorAction SilentlyContinue }
    if (-not (Test-Path $RESP)) { Write-Utf8 $RESP "" }

    # Put the narrative back in the log, so this costs nothing in readability. If the response is
    # not JSON (a crash, a watchdog kill) print it raw rather than losing it.
    $parsed = Invoke-Node @("-e", @'

        const fs = require("fs");
        const raw = fs.readFileSync(process.argv[1], "utf8");
        // Belt and braces. The whole file SHOULD be one JSON object, and two separate bugs have
        // already broken that assumption by leaking another process`s output into it (stderr via
        // 2>&1, then rss-guard`s banner via the shared stdout redirect). Each time, the cost was
        // silently dropped and the monthly ceiling quietly stopped meaning anything. So: try the
        // whole file first, and if that fails, take the last line that parses as an object with a
        // cost. A stray line should cost a tidy log, not the ledger.
        const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
        let d = parse(raw);
        let noisy = false;
        if (!d) {
          const lines = raw.split("\n").filter((l) => l.trim().startsWith("{"));
          for (let i = lines.length - 1; i >= 0 && !d; i--) d = parse(lines[i]);
          noisy = Boolean(d);
        }
        if (!d) { process.stdout.write(raw); process.exit(0); }
        if (noisy) process.stdout.write("(note: response had extra output around the JSON)\n");
        if (d.result) process.stdout.write(d.result + "\n");
        if (typeof d.total_cost_usd === "number") {
          fs.writeFileSync(process.argv[2], String(d.total_cost_usd));
          process.stdout.write("\n---- cost $" + d.total_cost_usd.toFixed(4) +
            "  " + (d.num_turns ?? "?") + " turns ----\n");
        }
      
'@, $RESP, $COST_FILE)
    if ($parsed.ExitCode -eq 0) { LogBlock $parsed.StdOut } else { LogBlock ([System.IO.File]::ReadAllText($RESP)) }
    Remove-Item $RESP -Force -ErrorAction SilentlyContinue

    if ($rc -eq 0) {
      Log ("---- attempt " + $attempt + " succeeded ----")
      break
    }
    # 124 = Invoke-WithTimeout's deadline fired (the bash sees 143 = SIGTERM from its watchdog).
    if ($rc -eq 124) {
      Log ("---- attempt " + $attempt + " TIMED OUT after " + $TIMEOUT_SECS + "s ----")
    } else {
      Log ("---- attempt " + $attempt + " failed (exit " + $rc + ") ----")
    }
    if ($attempt -lt $ATTEMPTS) { Log ("retrying in " + $RETRY_SLEEP + "s..."); Start-Sleep -Seconds $RETRY_SLEEP }
  }
  # The for loop leaves $attempt one past the last iteration when it ran out; the bash `for ... in
  # $(seq)` leaves it AT the last value. Clamp so "attempts" reports the attempt actually used.
  if ($attempt -gt $ATTEMPTS) { $attempt = $ATTEMPTS }

  # Record what it cost, whatever the outcome. A failed or timed-out run still spends money, and
  # a ledger that only counts successes would understate the month and let the ceiling be
  # overshot silently.
  if ((Test-Path $COST_FILE) -and ((Get-Item $COST_FILE).Length -gt 0)) {
    $COST = ([System.IO.File]::ReadAllText($COST_FILE)).Trim()
    $outcome = "failed"; if ($rc -eq 0) { $outcome = "ok" }
    $spendJson = '{"started":"' + $script:STARTED + '","cost_usd":' + $COST + ',"outcome":"' + $outcome + '","detail":"attempt ' + $attempt + ' of ' + $ATTEMPTS + '"}'
    $add = Invoke-Node @((Join-Path $REPO "server\record.mjs"), "add-spend", $spendJson)
    if ($add.ExitCode -eq 0) { Log ("spend recorded: `$" + $COST) }
  } else {
    Log "spend NOT recorded — no cost returned (crash, timeout, or non-JSON response)"
  }

  # A run that dies mid-write leaves the advisory lock behind; it self-heals after 60s (see
  # server/lock.mjs) but clearing it here means the dashboard is responsive immediately.
  $lockPath = Join-Path $REPO "data\.lock"
  if ($rc -ne 0 -and (Test-Path $lockPath)) {
    Log "clearing stale data/.lock left by the failed run"
    Remove-Item $lockPath -Recurse -Force -ErrorAction SilentlyContinue
  }

  # Report the attempt actually USED ($attempt, which survives the loop), not the configured
  # maximum. Passing $ATTEMPTS made a first-try success read as "attempts: 2" — indistinguishable
  # from a run that needed its retry, which is exactly the signal this file exists to carry.
  # The digest is the whole point of an unattended run, and its delivery has failed silently before
  # (the WhatsApp MCP server is stdio — every session spawns its own, and a second instance cannot
  # claim a device link an orphaned one still holds). /job-run always writes the digest to
  # data/.last-digest.md with a `delivered:` line, so a push failure degrades to a desktop
  # notification rather than to nothing at all.
  $DIGEST = Join-Path $LOG_DIR ".last-digest.md"
  $DIGEST_MISSING = 0
  if (Test-Path $DIGEST) {
    $dlines = [System.IO.File]::ReadAllLines($DIGEST)
    $delivery = ""
    $headline = ""
    foreach ($l in $dlines) { if ($l -match '^(delivered|not-delivered):') { $delivery = $l; break } }
    foreach ($l in $dlines) { if ($l -match '^- ') { $headline = $l.Substring(2); if ($headline.Length -gt 110) { $headline = $headline.Substring(0, 110) }; break } }
    if ($delivery -like "not-delivered:*") {
      Log ("DIGEST NOT DELIVERED — " + $delivery.Substring("not-delivered:".Length).TrimStart())
      $h = $headline; if (-not $h) { $h = "See data/.last-digest.md" }
      Notify "JobSeeker digest not delivered" ($h + " — WhatsApp failed, digest saved locally")
    } elseif ($delivery -like "delivered:*") {
      Log ("digest delivered via " + $delivery.Substring("delivered:".Length).TrimStart())
    } else {
      Log "digest file present but carries no delivery line"
    }
  } else {
    Log "WARNING: no data/.last-digest.md written — the run produced no digest"
    $DIGEST_MISSING = 1
    if ($rc -eq 0) { Notify "JobSeeker run finished with no digest" "Run reported success but wrote no digest file" }
  }

  # ---- what state did this run actually earn? --------------------------------------------------
  # Failure dominates coverage: a run that did not finish cannot be "partial", and a run that
  # produced no digest did not deliver the one thing an unattended run exists to produce -- that
  # used to be recorded as `ok` while the log line right above said the opposite.
  $GAPS = Get-GapsJson
  if ($rc -ne 0) {
    Write-Status "failed" $attempt ("exit code " + $rc + " after " + $attempt + " attempt(s) of " + $ATTEMPTS) $GAPS
    Notify "JobSeeker daily run failed" ("Exit " + $rc + " after " + $attempt + " attempt(s). See data\.job-run.log")
  } elseif ($DIGEST_MISSING -eq 1) {
    Write-Status "failed" $attempt "completed but produced no digest — the run's only deliverable is missing" $GAPS
  } elseif ($GAPS -ne "[]") {
    Write-Status "partial" $attempt ("completed, but part of the pipeline could not run: " + $GAPS) $GAPS
    Notify "JobSeeker ran, but not fully" (($GAPS -replace '[\[\]"]', '') + " — see the dashboard")
  } else {
    Write-Status "ok" $attempt ("completed on attempt " + $attempt + " of " + $ATTEMPTS) "[]"
  }

  # ---- the schedule ladder ----------------------------------------------------------------------
  # Evaluated here because the run is the only thing guaranteed to execute on the current schedule;
  # the dashboard is not always open. Arming on first sight starts the clock TODAY, so an install
  # upgrading into this feature is never stepped down for inactivity it was never warned about.
  $ladder = Join-Path $PSScriptRoot "schedule-ladder.ps1"
  $ladderOk = $false
  if (Test-Path $ladder) {
    try {
      $lOut = & $ladder 2>&1 | Out-String
      LogBlock $lOut
      $ladderOk = ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE)
    } catch { LogBlock ($_ | Out-String); $ladderOk = $false }
  }
  if (-not $ladderOk) { Log "schedule ladder: skipped (non-fatal)" }

  Log ("==================== done " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " (exit " + $rc + ") ====================")
  exit $rc
} finally {
  # Both cleanups in one place — the bash has a single EXIT trap for the same reason (a second
  # `trap ... EXIT` silently REPLACES the first, which is how a wake-lock release could go missing).
  foreach ($f in @($COST_FILE, ($COST_FILE + ".guard.out"))) { if ($f -and (Test-Path $f)) { Remove-Item $f -Force -ErrorAction SilentlyContinue } }
  Stop-KeepAwake
}
