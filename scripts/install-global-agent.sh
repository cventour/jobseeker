#!/usr/bin/env bash
# Make "jobseeker, ..." work from ANY directory, not only inside this repo.
#
#   bash scripts/install-global-agent.sh            install / refresh
#   bash scripts/install-global-agent.sh --remove   take it back out
#
# What gets installed is ONE user-level agent — a thin front door in ~/.claude/agents that knows
# the absolute path of this install and defers to the project's own agents for everything else.
#
# Deliberately NOT a copy of the nine project agents, for three reasons that were all verified
# rather than assumed:
#   * every project agent runs relative commands (`node server/record.mjs`, `cat data/...`) — 36
#     such calls — so verbatim copies would load in every project and work in none of them;
#   * copies go stale: the project files update with `git pull` or a release unzip, and a snapshot
#     in ~/.claude would keep executing last month's rules against this month's data;
#   * eight of the nine are specialists that /job-run fans out inside a repo session. Installed
#     globally they would appear in the agent list of every unrelated project as noise.
# The shim never goes stale because it contains no procedure — only the address of the install and
# the instruction to read the live playbooks there.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/.claude/agents/jobseeker.md"
MARKER="installed-by: JobSeeker scripts/install-global-agent.sh"

if [ "${1:-}" = "--remove" ]; then
  if [ -f "$DEST" ] && grep -q "$MARKER" "$DEST"; then
    rm -f "$DEST"
    echo "removed $DEST"
  elif [ -f "$DEST" ]; then
    echo "NOT removing $DEST — it was not installed by this script" >&2
    exit 1
  else
    echo "nothing to remove"
  fi
  exit 0
fi

# Refuse to overwrite a file some other tool (or the user) put there. A marker check, not a prompt:
# this runs from the graphical installer where nobody is watching a terminal.
if [ -f "$DEST" ] && ! grep -q "$MARKER" "$DEST"; then
  echo "NOT overwriting $DEST — it exists and was not installed by this script" >&2
  exit 1
fi

mkdir -p "$HOME/.claude/agents"
cat > "$DEST.tmp" <<AGENT
---
name: jobseeker
description: The single front door for ALL job-search tasks — address it as "@jobseeker" or "jobseeker" from any directory. Check Gmail/WhatsApp/LinkedIn for updates, find/curate roles, research markets, prep an application, draft a follow-up, reconcile tasks, or answer "what's my pipeline / what's due". Defers to the JobSeeker install's own playbooks.
---

<!-- $MARKER
     repo: $REPO
     Re-running scripts/install-global-agent.sh refreshes this file; --remove deletes it. -->

You are **jobseeker**, reached from OUTSIDE the JobSeeker project directory. The install lives at:

    $REPO

Rules, in order:

1. **Every shell command runs against that directory.** Prefix each with \`cd "$REPO" &&\`, or use
   absolute paths under it. The playbooks you are about to read use relative paths (\`data/...\`,
   \`node server/record.mjs\`) and every one of them assumes that cwd.
2. **Read \`$REPO/.claude/agents/jobseeker.md\` and follow it exactly** — it is the live front-door
   playbook, including the table mapping each kind of request to a specialist playbook, and the
   rules file \`$REPO/.claude/AGENT-RULES.md\` it binds you to. Do not act from memory of what those
   files might say; they change with every release and this shim deliberately contains no
   procedure of its own.
3. If that file does not exist, say so plainly: the JobSeeker install has moved or been deleted,
   and re-running \`scripts/install-global-agent.sh\` from wherever it lives now will repoint this.
AGENT
mv "$DEST.tmp" "$DEST"
echo "installed: ~/.claude/agents/jobseeker.md → $REPO"
