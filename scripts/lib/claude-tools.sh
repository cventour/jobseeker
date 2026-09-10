#!/usr/bin/env bash
# What an unattended run is allowed to do, and how it says when it was not allowed to do it.
# Windows twin: scripts/win/lib/claude-tools.ps1 — change both together.
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
# This lives in its own file because BOTH the shared runner (lib/claude-run.sh) and the scheduled
# daily run (job-run.sh, standalone by design) need the same list, and a list kept in two places is
# a list that drifts. Anything not named here still asks, and therefore still fails closed: add the
# specific command, never a bare `Bash`.

CLAUDE_ALLOWED_TOOLS="${CLAUDE_ALLOWED_TOOLS:-WebSearch WebFetch \
Bash(node server/record.mjs:*) \
Bash(node server/audit.mjs:*) \
Bash(node scripts/browser-probe.mjs:*) \
Bash(node scripts/browser-read.mjs:*) \
Bash(node scripts/browser-do.mjs:*) \
Bash(node scripts/check-urls.mjs:*) \
Bash(node scripts/discover-board.mjs:*) \
Bash(node scripts/board-sweep.mjs:*) \
Bash(node scripts/chat-sweep.mjs:*) \
mcp__claude_ai_Gmail__search_threads \
mcp__claude_ai_Gmail__get_thread \
mcp__claude_ai_Gmail__get_message \
mcp__claude_ai_Gmail__list_labels \
mcp__claude_ai_Gmail__list_drafts \
mcp__claude_ai_Gmail__get_draft \
mcp__claude_ai_Gmail__create_draft \
mcp__claude_ai_Gmail__update_draft \
mcp__claude_ai_Google_Calendar__list_calendars \
mcp__claude_ai_Google_Calendar__list_events \
mcp__claude_ai_Google_Calendar__create_event \
mcp__claude_ai_Google_Calendar__update_event \
mcp__plugin_whatsapp-claude-channel_whatsapp__reply}"

# The connector tools above are named ONE BY ONE rather than as mcp__claude_ai_Gmail__*, and the
# omissions are the point: send_message, reply, forward, trash_* and the spam and label mutations
# are not here. Reading the inbox and preparing a DRAFT need no permission from the user; putting
# something in front of another human does, and in this product that permission is an approval
# record, checked by the agents and by scripts/send-approval.sh. A wildcard would have quietly
# handed an unattended run the ability to send mail on its own, which is the one thing the whole
# design promises it cannot do. The WhatsApp reply tool IS here because that is how an ALREADY
# approved message goes out — the gate is the approval record, not the permission prompt.
#
# Untested as of writing: whether a headless run needs these grants at all. A probe confirmed the
# tools are OFFERED to a headless session and to its subagents (contradicting the belief that they
# are not), but not whether CALLING one prompts. Naming them costs nothing if it turns out to be
# unnecessary, and fixes a silent denial if it is not.
#
# These names must match the MCP servers as they are actually loaded on the machine. They are the
# CLI's names (claude_ai_Gmail); other surfaces name the same connectors differently, and a rule
# naming a server that is not loaded matches nothing and grants nothing.

# Both flags are long-standing, but a CLI too old for them would reject the whole invocation with
# "unknown option" — every paid path broken at once, which is worse than the bug being fixed. So ask
# once, and if the answer is no, say so rather than dropping the flags and quietly reproducing the
# denial loop. Cached: `claude --help` is a process, and this is asked once per run.
CLAUDE_PERMS_OK=""
claude_perms_supported() {
  [ -n "$CLAUDE_PERMS_OK" ] && { [ "$CLAUDE_PERMS_OK" = "yes" ] && return 0 || return 1; }
  local help; help="$("${CLAUDE_BIN:-claude}" --help 2>/dev/null)"
  case "$help" in
    *--permission-mode*allowedTools*|*allowedTools*--permission-mode*) CLAUDE_PERMS_OK="yes" ;;
    *) CLAUDE_PERMS_OK="no" ;;
  esac
  [ "$CLAUDE_PERMS_OK" = "yes" ]
}

# The activity log is where somebody looks when a button did nothing. A failure that exists only in
# a .log file under data/ is a failure nobody finds: those four refused research runs were all
# sitting in data/.markets-run.log while the dashboard said "ok" on every one of them.
log_problem() { # type, one-line detail
  "${NODE_BIN:-node}" "$REPO/server/record.mjs" log "$1" "$2" >/dev/null 2>&1 ||
    echo "could not write the activity row: $1 — $2"
}
