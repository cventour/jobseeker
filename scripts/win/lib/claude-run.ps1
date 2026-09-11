# Shared plumbing for every path that spends money by calling `claude -p` outside the scheduler:
# the dashboard's Run now buttons, market research, and the approval sender.
#
# Twin of scripts/lib/claude-run.sh — change both together.
#
# It exists because that plumbing is not optional and had already been duplicated once. A caller
# that forgets any of it fails in a way nobody notices for days:
#   * the monthly ceiling must be checked BEFORE the spend, or it is a ceiling with a hole in it,
#   * the actual cost must be parsed out of the JSON and written to the ledger, or Settings reports
#     "$0.00 across 0 runs" while real money is going out (this happened for five runs),
#   * stdout must carry ONLY the JSON — a stray stderr line breaks the parse and loses the cost,
#   * and two runs must never overlap, because Chrome is a serial resource (AGENT-RULES §13).
#
# Dot-source it, do not execute it:  . "$PSScriptRoot\lib\claude-run.ps1"
# It expects $Repo to be set to the repo root and the cwd to be there.
#
# Two things differ from the bash on purpose, both forced by the shell:
#   * bash releases the run lock with `trap ... EXIT`. PowerShell has no exit trap, so every caller
#     wraps its body in try/finally { Release-RunLock } — see Take-RunLock.
#   * bash appends the whole run to its log with `>> "$LOG" 2>&1`. Windows PowerShell's `>>` writes
#     UTF-16, which nothing that reads these logs expects, so callers set $script:LogFile and
#     everything here reports through Write-RunLog, which appends UTF-8 (no BOM) itself.
#
# Windows PowerShell 5.1 and pwsh 7: no `??`, no ternaries, no `&&` chaining.

$Utf8NoBom = [Text.UTF8Encoding]::new($false)

# What a run may do, whether the CLI can be told, and how a failure reaches the activity log.
# Shared with job-run.ps1, which is standalone and would otherwise keep its own copy of the list.
. (Join-Path $PSScriptRoot "claude-tools.ps1")

# Which tools the last Invoke-ClaudeRun was refused, if any.
$script:RunClaudeDenied = ""

# ---- node ----------------------------------------------------------------------------------------
if ($env:NODE_BIN) {
  $NodeBin = $env:NODE_BIN
} else {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $NodeBin = $nodeCmd.Source
  } else {
    $NodeBin = Join-Path $env:ProgramFiles "nodejs\node.exe"
  }
}

# ---- logging -------------------------------------------------------------------------------------
# The caller's log file (data/.run-now.log, data/.approvals.log, ...). Unset means "write to stdout",
# which is what happens when a script is run by hand rather than from the dashboard.
$script:LogFile = $null

function Write-RunLog {
  param([Parameter(ValueFromPipeline = $true)][AllowEmptyString()][AllowNull()][string]$Text)
  process {
    if ($null -eq $Text) { return }
    if ($script:LogFile) {
      $dir = Split-Path -Parent $script:LogFile
      if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      [IO.File]::AppendAllText($script:LogFile, $Text + "`n", $Utf8NoBom)
    } else {
      [Console]::Out.WriteLine($Text)
    }
  }
}

function Write-Utf8File { # path, text — atomic enough for a small status file; never a BOM
  param([string]$Path, [string]$Text)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

function Get-UtcStamp { (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
function Get-LocalStamp { Get-Date -Format "yyyy-MM-dd HH:mm:ss" }

function ConvertTo-JsonString { # the bash does sed 's/"/\\"/g' — same, and nothing more
  param([AllowEmptyString()][AllowNull()][string]$Text)
  if ($null -eq $Text) { return "" }
  return $Text.Replace('"', '\"')
}

# ---- running native programs ---------------------------------------------------------------------
# Everything external goes through Start-Process with stdout and stderr redirected to files. Not
# stylistic: under Windows PowerShell 5.1 with $ErrorActionPreference = "Stop", a native program that
# writes one line to stderr while `2>&1` is in effect becomes a terminating error, and the run dies
# in the middle of recording its spend. Files sidestep that, and give the "stdout only" capture the
# JSON parse depends on.
#
# Quoting. Start-Process hands -ArgumentList to CreateProcess as one string and adds no quotes of
# its own, on 5.1 and on 7 alike, so PowerShell's native-argument binder — the thing that, outside
# pwsh 7.3+'s Standard mode, passes an embedded `"` through raw and splits the argument — is never
# involved here. ConvertTo-CommandLine below does the quoting instead, the way the C runtime
# un-quotes it, and does it identically on every host. That is why this file does NOT also escape
# `"` as \" the way schedule-ladder.ps1's Invoke-Native must for its `& $exe @argv` calls: applied
# on top of ConvertTo-CommandLine it would double-escape, and a prompt containing a quote would
# reach claude with a stray backslash in it.
#
# JavaScript snippets are the exception that gets no quoting at all: see Invoke-Node -Snippet.

function ConvertTo-CommandLine { # quote one argument the way CreateProcess/MSVCRT expect
  param([string[]]$Arguments)
  $parts = @()
  foreach ($a in $Arguments) {
    if ($null -eq $a) { $a = "" }
    if ($a.Length -gt 0 -and $a -notmatch '[\s"]') {
      $parts += $a
      continue
    }
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('"')
    $i = 0
    while ($i -lt $a.Length) {
      $bs = 0
      while ($i -lt $a.Length -and $a[$i] -eq '\') { $bs++; $i++ }
      if ($i -eq $a.Length) {
        [void]$sb.Append('\', $bs * 2)
      } elseif ($a[$i] -eq '"') {
        [void]$sb.Append('\', $bs * 2 + 1)
        [void]$sb.Append('"')
        $i++
      } else {
        [void]$sb.Append('\', $bs)
        [void]$sb.Append($a[$i])
        $i++
      }
    }
    [void]$sb.Append('"')
    $parts += $sb.ToString()
  }
  return ($parts -join ' ')
}

function Invoke-Native {
  # Runs a program to completion. Returns @{ ExitCode; Out; Err }. Pass -StdinFile to feed stdin
  # (the bash pipes list-spend into a node snippet), -OutFile to keep stdout in a file of your
  # choosing (the claude response) instead of a temp one.
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [string]$StdinFile,
    [string]$OutFile,
    [string]$WorkingDirectory
  )
  if (-not $WorkingDirectory) { $WorkingDirectory = (Get-Location).Path }
  $ownOut = -not $OutFile
  if ($ownOut) { $OutFile = [IO.Path]::GetTempFileName() }
  $errFile = [IO.Path]::GetTempFileName()
  try {
    $sp = @{
      FilePath               = $FilePath
      WorkingDirectory       = $WorkingDirectory
      RedirectStandardOutput = $OutFile
      RedirectStandardError  = $errFile
      NoNewWindow            = $true
      Wait                   = $true
      PassThru               = $true
    }
    $cmdline = ConvertTo-CommandLine $ArgumentList
    if ($cmdline) { $sp.ArgumentList = $cmdline }
    if ($StdinFile) { $sp.RedirectStandardInput = $StdinFile }
    $code = 1
    $out = ""
    $err = ""
    try {
      $p = Start-Process @sp
      $code = $p.ExitCode
    } catch {
      $err = $_.Exception.Message
      $code = 127
    }
    # Trailing newlines go, as bash's $(...) drops them: Start-Process writes the redirected stream
    # line by line, so even a bare process.stdout.write("5") comes back as "5<newline>".
    if (Test-Path -LiteralPath $OutFile) { $out = [IO.File]::ReadAllText($OutFile, $Utf8NoBom).TrimEnd("`r", "`n") }
    if (Test-Path -LiteralPath $errFile) { $err = ($err + [IO.File]::ReadAllText($errFile, $Utf8NoBom)).TrimEnd("`r", "`n") }
    return @{ ExitCode = $code; Out = $out; Err = $err }
  } finally {
    if ($ownOut) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Node { # node <args>, cwd = repo. Same return shape as Invoke-Native.
  # -Snippet runs one of the bash twin's `node -e` snippets, verbatim. The code travels in an
  # environment variable rather than on the command line: a JS snippet is nothing but double quotes,
  # backslashes and newlines, and `eval(process.env...)` has none of them, so no host's command-line
  # quoting can touch it (Windows PowerShell 5.1 in particular mangles embedded quotes in native
  # arguments). process.argv is numbered exactly as under `node -e '<code>'`, so the snippets need no
  # edits and stay byte-identical to the bash. The variable is cleared afterwards so a later plain
  # node call cannot pick up a stale snippet. Same transport as schedule-ladder.ps1's Invoke-Node.
  param([string[]]$ArgumentList = @(), [string]$StdinFile, [string]$OutFile, [string]$Snippet)
  if ($PSBoundParameters.ContainsKey("Snippet")) {
    $env:JOBSEEKER_NODE_SNIPPET = $Snippet
    try {
      return Invoke-Native -FilePath $NodeBin -ArgumentList (@("-e", "eval(process.env.JOBSEEKER_NODE_SNIPPET)") + $ArgumentList) -StdinFile $StdinFile -OutFile $OutFile -WorkingDirectory $Repo
    } finally {
      Remove-Item -Path Env:JOBSEEKER_NODE_SNIPPET -ErrorAction SilentlyContinue
    }
  }
  return Invoke-Native -FilePath $NodeBin -ArgumentList $ArgumentList -StdinFile $StdinFile -OutFile $OutFile -WorkingDirectory $Repo
}

# Paths that reach node are built with Combine so the separator is the OS's own, not a literal.
$RecordMjs = [IO.Path]::Combine($Repo, "server", "record.mjs")

function Invoke-Record { # node server/record.mjs <subcommand> <args...>; output discarded, as the bash does with >/dev/null 2>&1
  param([string[]]$ArgumentList)
  $r = Invoke-Node -ArgumentList (@($RecordMjs) + $ArgumentList)
  return ($r.ExitCode -eq 0)
}

# Read one key out of the user's config. Config is the source of truth for the caps so the
# dashboard can change them without editing scripts.
function Read-Cfg {
  param([string]$Key)
  $snippet = @'

    const fs=require("fs");
    try{
      const t=fs.readFileSync("config/job-seeker.config.md","utf8");
      const m=new RegExp("^"+process.argv[1]+":[ \t]*(.*)$","m").exec(t);
      process.stdout.write(m && m[1] ? m[1].trim() : "");
    }catch{ process.stdout.write(""); }
  
'@
  $r = Invoke-Node -Snippet $snippet -ArgumentList @($Key)
  if ($r.ExitCode -ne 0) { return "" }
  return $r.Out
}

# ---- the run lock -----------------------------------------------------------------------------
# One claude-driven run at a time, whatever started it. Not an optimisation: two runs read Chrome
# at once, and the second one's reads land in the first one's tabs.
#
# The lock records the PID so a crashed run cannot wedge the button forever — a lock whose process
# is gone is stale and taken over, rather than needing the user to delete a file they were never
# told about.
if ($env:RUN_LOCK) { $RunLock = $env:RUN_LOCK } else { $RunLock = [IO.Path]::Combine($Repo, "data", ".run-now.lock") }
$script:RunLockHeld = $false

function Get-RunLockHolder { # returns "<pid> <slug> <started>" if a LIVE run holds the lock, else ""
  if (-not (Test-Path -LiteralPath $RunLock)) { return "" }
  $line = ""
  try { $line = [string](Get-Content -LiteralPath $RunLock -TotalCount 1 -ErrorAction Stop) } catch { return "" }
  if (-not $line) { return "" }
  $parts = $line.Trim() -split '\s+', 3
  $holderPid = $parts[0]
  if (-not $holderPid) { return "" }
  $slug = ""; $started = ""
  if ($parts.Count -gt 1) { $slug = $parts[1] }
  if ($parts.Count -gt 2) { $started = $parts[2] }
  $alive = $null
  $n = 0
  if ([int]::TryParse($holderPid, [ref]$n)) { $alive = Get-Process -Id $n -ErrorAction SilentlyContinue }
  if ($alive) {
    return "$holderPid $slug $started"
  } else {
    Remove-Item -LiteralPath $RunLock -Force -ErrorAction SilentlyContinue
    return ""
  }
}

function Take-RunLock { # slug — returns $false if another live run holds it
  param([string]$Slug)
  $held = Get-RunLockHolder
  if ($held) {
    Write-RunLog "ANOTHER RUN IS IN PROGRESS ($held) — not starting '$Slug'. Chrome can only be driven by one run at a time."
    return $false
  }
  $dir = Split-Path -Parent $RunLock
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Write-Utf8File $RunLock ("{0} {1} {2}`n" -f $PID, $Slug, (Get-UtcStamp))
  # Released on ANY exit, including a kill, in the bash via `trap EXIT`. Here the caller's
  # try/finally { Release-RunLock } is that trap: no caller may take the lock outside one.
  $script:RunLockHeld = $true
  return $true
}

function Release-RunLock {
  if ($script:RunLockHeld) {
    Remove-Item -LiteralPath $RunLock -Force -ErrorAction SilentlyContinue
    $script:RunLockHeld = $false
  }
}

# ---- spend ------------------------------------------------------------------------------------
# Refuse before spending. A blocked run says so loudly and says how to lift it; a silent skip is
# indistinguishable from a run that found nothing.
function Get-MonthSpent { # what list-spend says this month came to, "0" when it cannot say
  $spendFile = [IO.Path]::GetTempFileName()
  try {
    [void](Invoke-Node -ArgumentList @($RecordMjs, "list-spend") -OutFile $spendFile)
    $snippet = @'
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{process.stdout.write(String(JSON.parse(s).month_total_usd||0))}catch{process.stdout.write("0")}})
'@
    $r = Invoke-Node -Snippet $snippet -StdinFile $spendFile
    return $r.Out
  } finally {
    Remove-Item -LiteralPath $spendFile -Force -ErrorAction SilentlyContinue
  }
}

function Test-SpendOver { # spent, cap — "1" when spent >= cap, as the bash snippet decides it
  param([string]$Spent, [string]$Cap)
  $snippet = @'
process.stdout.write(Number(process.argv[1])>=Number(process.argv[2])?"1":"0")
'@
  $r = Invoke-Node -Snippet $snippet -ArgumentList @($Spent, $Cap)
  return $r.Out
}

function Test-MonthCeiling { # logs the reason and returns $true (blocked) / $false (clear)
  $cap = Read-Cfg max_spend_per_month_usd
  if (-not $cap) { return $false }
  $spent = Get-MonthSpent
  $over = Test-SpendOver $spent $cap
  if ($over -eq "1") {
    Write-RunLog "MONTHLY SPEND CEILING REACHED: `$$spent of `$$cap this month — not starting."
    Write-RunLog "Raise max_spend_per_month_usd in the dashboard (Settings ▸ Spending) to lift it."
    return $true
  }
  Write-RunLog "spend this month: `$$spent of `$$cap ceiling"
  return $false
}

function Get-RunBudget { # per-run cap, config first, then the passed default
  param([string]$Default = "5")
  $b = Read-Cfg max_spend_per_run_usd
  if ($b) { return $b }
  if ($Default) { return $Default }
  return "5"
}

# ---- claude -----------------------------------------------------------------------------------
$script:ClaudeBin = $null

# PATH first, then where the installers put it; $null if nowhere.
#
# A process started from a shortcut or a scheduled task does not get the PATH the user sees in a
# terminal, so "it works when I type claude" never settles whether this will find it. Mirrors
# claude_search_dirs() in scripts/lib/claude-run.sh — keep the two lists in step.
function Get-ClaudeCandidates {
  $c = @()
  if ($env:USERPROFILE) {
    $c += (Join-Path $env:USERPROFILE ".local\bin\claude.exe")
    $c += (Join-Path $env:USERPROFILE ".local\bin\claude.cmd")
    $c += (Join-Path $env:USERPROFILE ".claude\local\claude.exe")
    $c += (Join-Path $env:USERPROFILE ".claude\local\claude.cmd")
    $c += (Join-Path $env:USERPROFILE ".bun\bin\claude.exe")
  }
  if ($env:APPDATA)       { $c += (Join-Path $env:APPDATA "npm\claude.cmd") }
  if ($env:LOCALAPPDATA)  { $c += (Join-Path $env:LOCALAPPDATA "Volta\bin\claude.exe") }
  if ($env:ProgramFiles)  { $c += (Join-Path $env:ProgramFiles "nodejs\claude.cmd") }
  return $c
}

function Resolve-ClaudeBin {
  $c = Get-Command claude -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in Get-ClaudeCandidates) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

function Require-Claude {
  $script:ClaudeBin = Resolve-ClaudeBin
  if ($script:ClaudeBin) {
    # Anything claude itself shells out to needs to find its neighbours, so the directory it came
    # from joins PATH rather than only being used for this one call.
    $dir = Split-Path -Parent $script:ClaudeBin
    if ($dir -and ($env:PATH -split ';') -notcontains $dir) { $env:PATH = "$dir;$env:PATH" }
    return $true
  }
  Write-RunLog "ERROR: 'claude' CLI not found. Looked on PATH and in:"
  foreach ($p in Get-ClaudeCandidates) { Write-RunLog "  $p" }
  return $false
}

# Run `claude -p` headlessly with stdout captured on its own — see the note at the top of this
# file — and return @{ ExitCode; ResponseFile; StderrText }. The caller owns the response file.
#   Invoke-Claude "<prompt>" "<budget>"
function Invoke-Claude {
  param([string]$Prompt, [string]$Budget)
  if (-not $script:ClaudeBin) { $script:ClaudeBin = Resolve-ClaudeBin }
  if (-not $script:ClaudeBin) { $script:ClaudeBin = "claude" }
  # -p mode gives up on outstanding background subagents after ~10 minutes and ends the turn anyway,
  # whatever --max-budget-usd says. A /jobseeker markets pass fans out up to three prioritization-agents doing
  # live web research, and /jobseeker curate and /jobseeker track fan out too — none of which reliably finish inside ten
  # minutes. When the ceiling fires the work is abandoned, the files are never written, and the run
  # exits 0: the same silent nothing this whole file exists to stop.
  #
  # Bounded rather than 0 here. job-run.ps1 can afford to wait forever because Invoke-WithTimeout is
  # already its real ceiling; these callers have no outer wrapper, so 0 would trade a silent
  # truncation for a run lock held forever by a wedged pass. Twin of scripts/lib/claude-run.sh.
  # Set only when the caller has not, so a caller can still override.
  if (-not $env:CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS) { $env:CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = "1800000" }
  $resp = [IO.Path]::GetTempFileName()
  # --permission-mode / --allowedTools: without them every tool the agents need is refused, one at
  # a time, and the run narrates its way to a clean exit 0 having done nothing. See
  # lib/claude-tools.ps1 for the list and why it is not a settings file.
  if (Test-ClaudePermsSupported $script:ClaudeBin) {
    $argv = @("-p", $Prompt, "--permission-mode", "acceptEdits", "--allowedTools", $ClaudeAllowedTools,
              "--max-budget-usd", $Budget, "--output-format", "json")
  } else {
    Write-RunLog "WARNING: this Claude CLI is too old to be told what it may do (no --permission-mode)."
    Write-RunLog "         The run will be refused its own tools and produce nothing. Update the CLI."
    $argv = @("-p", $Prompt, "--max-budget-usd", $Budget, "--output-format", "json")
  }
  $r = Invoke-Native -FilePath $script:ClaudeBin -ArgumentList $argv -OutFile $resp -WorkingDirectory $Repo
  return @{ ExitCode = $r.ExitCode; ResponseFile = $resp; StderrText = $r.Err }
}

# Pull the narrative and the cost out of a claude JSON response. Logs the narrative (or the raw
# text when it is not JSON) and writes the cost to "<response>.cost" when there is one.
function Read-ClaudeResponse {
  param([string]$ResponseFile)
  $snippet = @'

    const fs=require("fs");
    const raw=fs.readFileSync(process.argv[1],"utf8");
    const parse=(s)=>{ try { return JSON.parse(s); } catch { return null; } };
    let d=parse(raw);
    if(!d){ const lines=raw.split("\n").filter(l=>l.trim().startsWith("{"));
            for(let i=lines.length-1;i>=0&&!d;i--) d=parse(lines[i]); }
    if(!d){ process.stdout.write(raw); process.exit(0); }
    if(d.result) process.stdout.write(d.result+"\n");
    if(typeof d.total_cost_usd==="number") fs.writeFileSync(process.argv[2], String(d.total_cost_usd));
  
'@
  $r = Invoke-Node -Snippet $snippet -ArgumentList @($ResponseFile, "$ResponseFile.cost")
  if ($r.ExitCode -eq 0) {
    if ($r.Out) { Write-RunLog $r.Out.TrimEnd("`n", "`r") }
  } else {
    if (Test-Path -LiteralPath $ResponseFile) { Write-RunLog ([IO.File]::ReadAllText($ResponseFile, $Utf8NoBom).TrimEnd("`n", "`r")) }
  }
}

# Write what a run cost to the ledger: node server/record.mjs add-spend '<json>'. Says so either
# way, because a cost that was not recorded is the failure this whole file exists to prevent.
function Record-Spend {
  param([string]$ResponseFile, [string]$Started, [int]$ExitCode, [string]$Detail)
  $costFile = "$ResponseFile.cost"
  if ((Test-Path -LiteralPath $costFile) -and (Get-Item -LiteralPath $costFile).Length -gt 0) {
    $cost = [IO.File]::ReadAllText($costFile, $Utf8NoBom).Trim()
    if ($ExitCode -eq 0) { $outcome = "ok" } else { $outcome = "failed" }
    $json = '{"started":"' + $Started + '","cost_usd":' + $cost + ',"outcome":"' + $outcome + '","detail":"' + (ConvertTo-JsonString $Detail) + '"}'
    if (Invoke-Record @("add-spend", $json)) { Write-RunLog "spend recorded: `$$cost" }
  } else {
    Write-RunLog "spend NOT recorded — no cost returned (crash, timeout, or non-JSON response)"
  }
}

# Run one slash command headlessly and record what it cost. Logs the model's narrative and returns
# claude's exit code.
#   Invoke-ClaudeRun "<prompt>" "<budget>" "<ledger detail>"
function Invoke-ClaudeRun {
  param([string]$Prompt, [string]$Budget, [string]$Detail)
  $started = Get-UtcStamp
  $script:RunClaudeDenied = ""
  $run = Invoke-Claude $Prompt $Budget
  $resp = $run.ResponseFile
  $rc = [int]$run.ExitCode
  try {
    # stderr is not part of the response, but it is part of the log, as it is in the bash.
    if ($run.StderrText) { Write-RunLog $run.StderrText.TrimEnd("`n", "`r") }
    Read-ClaudeResponse $resp
    # A run that was refused its tools is a failed run, whatever the exit code says. It has to be
    # both here and in the ledger: four refused research runs were each written down as
    # `outcome: ok`, so the one record that could have shown $1.48 buying nothing agreed with the
    # status file instead of contradicting it.
    $script:RunClaudeDenied = Get-DeniedTools $resp
    if ($script:RunClaudeDenied) {
      Write-RunLog ("TOOLS REFUSED: " + $script:RunClaudeDenied + " — the run could not do its work.")
      if ($rc -eq 0) { $rc = 1 }
    }
    Record-Spend -ResponseFile $resp -Started $started -ExitCode $rc -Detail $Detail
  } finally {
    Remove-Item -LiteralPath $resp, "$resp.cost" -Force -ErrorAction SilentlyContinue
  }
  return $rc
}

# What to tell the user, read off what actually happened. Ordered by how specific the evidence is:
# a refused tool and an authentication line are unambiguous, and the caller's own fallback is what
# is left when nothing else explains it.
# Twin of classify_failure() in scripts/lib/claude-run.sh — change both together.
function Get-FailureReason {
  param([string]$Out, [string]$Fallback)
  if ($null -eq $Out) { $Out = "" }
  if ($script:RunClaudeDenied) {
    return ("JobSeeker was not allowed to use the tools it needs (" + $script:RunClaudeDenied + "), so the run did nothing. Update JobSeeker — older copies could not grant them.")
  }
  if ($Out -match 'OAuth|authenticate|Authentication|not logged in|/login') {
    return "Your Claude login has expired. Open a terminal, run claude, sign in, then try again."
  }
  if ($Out -match 'Unknown command') {
    return "This copy of JobSeeker is missing the command this step runs, so nothing happened. Reinstall or update JobSeeker."
  }
  if ($Out -match 'redit balance|insufficient|quota|ate limit') {
    return "Claude refused the request - out of credit, or rate limited. Check your Claude account, then try again."
  }
  if ($Out -match 'budget') {
    return "The per-run spending cap stopped this before it finished. Raise it in Settings > Spending."
  }
  if ($Out -match 'ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|Network') {
    return "Claude could not be reached - this PC looks offline. Check the connection and try again."
  }
  if ($Out -match 'too old to be told what it may do') {
    return "The Claude Code CLI on this PC is too old for JobSeeker to grant it the tools it needs, so the run did nothing. Update it (run: claude install stable) and try again."
  }
  if ($Out -match 'waiting on your approval|permission denied|was denied|were denied|tool permissions') {
    # No denial in the JSON, but the model says it was blocked. Rarer and less certain than the
    # array above, so it sits below the causes that name themselves — and deliberately matches
    # PHRASES, not the bare word "permission": this file's own "no --permission-mode" warning
    # contains it, and matched, which reported an out-of-date CLI as a mysterious block.
    return "JobSeeker was blocked from using a tool it needs, so the run did nothing. Update JobSeeker, then try again."
  }
  return $Fallback
}
