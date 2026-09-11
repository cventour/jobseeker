# What an unattended run is allowed to do, and how it says when it was not allowed to do it.
#
# Twin of scripts/lib/claude-tools.sh — change both together.
#
# A headless run has nobody to answer a permission prompt. `claude -p` sends prompts to a host that
# is not there and DENIES anything that would have asked -- so with no flags, the agents get their
# Write, WebSearch, WebFetch and most of their Bash refused, one at a time, and then narrate their
# way to a clean exit 0. Not a hypothetical: one user's market research ran four times over two
# hours, was refused every tool it needed every time, wrote nothing, and cost $1.48 while every
# status file said "ok".
#
# So every paid run says up front what it is allowed to do:
#   --permission-mode acceptEdits   the file writes (data/, and the two config files the wizard owns)
#   --allowedTools ...              everything else, named one by one
# Both are inherited by subagents, which is the half that actually mattered: the work is done by
# prioritization-agent, role-scout and the trackers, not by the top-level session.
#
# Deliberately flags on the command line and NOT a .claude/settings.json. The flags apply to exactly
# these unattended runs and are visible in the script that spends the money; a settings file would
# silently widen every interactive session in the repo as well.
#
# This lives in its own file because BOTH the shared runner (lib/claude-run.ps1) and the scheduled
# daily run (job-run.ps1, standalone by design) need the same list, and a list kept in two places is
# a list that drifts. Anything not named here still asks, and therefore still fails closed: add the
# specific command, never a bare `Bash`.
#
# Dot-source it, do not execute it. It expects $Repo to be set to the repo root.

# One string, exactly as the bash passes it: the CLI accepts a space-separated list in a single
# argument, and splitting it into several would make each fragment its own tool name.
$ClaudeAllowedTools = @(
  "WebSearch WebFetch",
  "Bash(node server/record.mjs:*)",
  "Bash(node server/audit.mjs:*)",
  "Bash(node scripts/browser-probe.mjs:*)",
  "Bash(node scripts/browser-read.mjs:*)",
  "Bash(node scripts/browser-do.mjs:*)",
  "Bash(node scripts/check-urls.mjs:*)",
  "Bash(node scripts/discover-board.mjs:*)",
  "Bash(node scripts/board-sweep.mjs:*)",
  "Bash(node scripts/chat-sweep.mjs:*)",
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__get_thread",
  "mcp__claude_ai_Gmail__get_message",
  "mcp__claude_ai_Gmail__list_labels",
  "mcp__claude_ai_Gmail__list_drafts",
  "mcp__claude_ai_Gmail__get_draft",
  "mcp__claude_ai_Gmail__create_draft",
  "mcp__claude_ai_Gmail__update_draft",
  "mcp__claude_ai_Google_Calendar__list_calendars",
  "mcp__claude_ai_Google_Calendar__list_events",
  "mcp__claude_ai_Google_Calendar__create_event",
  "mcp__claude_ai_Google_Calendar__update_event",
  "mcp__plugin_whatsapp-claude-channel_whatsapp__reply"
) -join " "

# The connector tools above are named ONE BY ONE rather than as mcp__claude_ai_Gmail__*, and the
# omissions are the point: send_message, reply, forward, trash_* and the spam and label mutations
# are not here. Reading the inbox and preparing a DRAFT need no permission from the user; putting
# something in front of another human does, and in this product that permission is an approval
# record, checked by the agents and by send-approval.ps1. A wildcard would have quietly handed an
# unattended run the ability to send mail on its own, which is the one thing the whole design
# promises it cannot do. The WhatsApp reply tool IS here because that is how an ALREADY approved
# message goes out — the gate is the approval record, not the permission prompt.
#
# These names must match the MCP servers as they are actually loaded on the machine. They are the
# CLI's names (claude_ai_Gmail); other surfaces name the same connectors differently, and a rule
# naming a server that is not loaded matches nothing and grants nothing.

# Both flags are long-standing, but a CLI too old for them would reject the whole invocation with
# "unknown option" — every paid path broken at once, which is worse than the bug being fixed. So ask
# once, and if the answer is no, say so rather than dropping the flags and quietly reproducing the
# denial loop. Cached: `claude --help` is a process, and this is asked once per run.
$script:ClaudePermsOk = $null
function Test-ClaudePermsSupported {
  param([string]$ClaudePath)
  if ($null -ne $script:ClaudePermsOk) { return $script:ClaudePermsOk }
  if (-not $ClaudePath) { $ClaudePath = "claude" }
  $help = ""
  try { $help = (& $ClaudePath --help 2>&1 | Out-String) } catch { $help = "" }
  $script:ClaudePermsOk = ($help -match "--permission-mode" -and $help -match "allowedTools")
  return $script:ClaudePermsOk
}

# The tool names a response says were refused, as one readable phrase ("Write, WebSearch"), or "".
# The CLI's own account of what happened, rather than a guess made by pattern-matching prose.
function Get-DeniedTools {
  param([string]$ResponseFile)
  if (-not (Test-Path -LiteralPath $ResponseFile)) { return "" }
  $node = $env:NODE_BIN
  if (-not $node) {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { $node = $c.Source } else { $node = "node" }
  }
  $snippet = @'

    const fs=require("fs");
    const parse=(s)=>{ try { return JSON.parse(s); } catch { return null; } };
    const raw=fs.readFileSync(process.argv[1],"utf8");
    let d=parse(raw);
    if(!d){ const lines=raw.split("\n").filter(l=>l.trim().startsWith("{"));
            for(let i=lines.length-1;i>=0&&!d;i--) d=parse(lines[i]); }
    const den=(d && Array.isArray(d.permission_denials))?d.permission_denials:[];
    const names=[...new Set(den.map(x=>String((x&&x.tool_name)||"").trim()).filter(Boolean))];
    process.stdout.write(names.join(", "));

'@
  # The code travels in an environment variable, never on the command line: Windows PowerShell 5.1
  # mangles double quotes inside native arguments, and this snippet is made of them. Passed directly,
  # node received broken JavaScript, printed nothing, and every refused tool went unreported on
  # Windows -- found only once the Windows suite could run this far. Same transport as
  # Invoke-Node -Snippet in claude-run.ps1; process.argv[1] is still the response file.
  $env:JOBSEEKER_NODE_SNIPPET = $snippet
  try { return ((& $node "-e" "eval(process.env.JOBSEEKER_NODE_SNIPPET)" $ResponseFile 2>$null | Out-String).Trim()) }
  catch { return "" }
  finally { Remove-Item -Path Env:JOBSEEKER_NODE_SNIPPET -ErrorAction SilentlyContinue }
}

# The activity log is where somebody looks when a button did nothing. A failure that exists only in
# a .log file under data/ is a failure nobody finds: those four refused research runs were all
# sitting in data/.markets-run.log while the dashboard said "ok" on every one of them.
#
# Self-contained on purpose: the two callers each have their own node helper with its own parameter
# shape, and this has to work from both.
function Write-Problem {
  param([string]$Type, [string]$Detail)
  $node = $env:NODE_BIN
  if (-not $node) {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { $node = $c.Source } else { $node = "node" }
  }
  try { & $node ([IO.Path]::Combine($Repo, "server", "record.mjs")) "log" $Type $Detail *>$null } catch { }
}
