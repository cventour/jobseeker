#!/usr/bin/env bash
# Research one market: find and rank vendors for it, filling data/markets/<slug>.md.
# Windows twin: scripts/win/research-market.ps1 — change both together.
#
#   bash scripts/research-market.sh "Healthtech"
#
# Normally this happens on its own. A market with no `last_reviewed` is reported `stale` by
# server/audit.mjs, and the daily run researches every stale market — so adding a market and
# waiting until tomorrow is the zero-effort path. This script exists for the case where there IS no
# daily run (manual mode), or where waiting is not wanted: the dashboard offers it as a button.
#
# It SPENDS MONEY — a research pass is a Claude call costing roughly a dollar and taking minutes —
# so it carries the same guards as the scheduled run rather than a lighter version of them:
# the monthly ceiling is honoured, the actual cost is recorded to the same ledger, and a run that
# cannot be measured says so instead of quietly counting as free.
#
# It used to carry hand-copied versions of that plumbing and its own bare `command -v claude`. The
# copy went stale: every other paid path resolves the CLI through resolve_claude, which also looks
# where the installer actually puts it, and this one did not. A GUI app hands its children launchd's
# PATH -- /usr/bin:/bin:/usr/sbin:/sbin -- so the button exited 127 before spending a cent on every
# machine where claude lives in ~/.local/bin, which is most of them. Nothing said so: the dashboard
# spawns this detached with stdio ignored and then promises the companies will appear on reload.
# Hence the shared library below, and the status file this now writes.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
. "$REPO/scripts/lib/claude-run.sh"

MARKET="${1:-}"
if [ -z "$MARKET" ]; then
  echo "usage: research-market.sh <market name>" >&2
  exit 64
fi

LOG="$REPO/data/.markets-run.log"
STATUS="$REPO/data/.markets-run.status.json"

# The one thing the dashboard can read back. Written at every exit that matters, because the only
# state worse than "failed" on this screen is nothing at all -- which is what it said before.
write_status() { # state, detail
  cat > "$STATUS.tmp" <<JSON
{
  "market": "$(printf '%s' "$MARKET" | sed 's/"/\\"/g')",
  "state": "$1",
  "started": "$STARTED",
  "finished": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "detail": "$(printf '%s' "$2" | sed 's/"/\\"/g')"
}
JSON
  # Atomic. A reader that catches this half-written sees invalid JSON and reports nothing at all,
  # which looks identical to a market nobody ever researched.
  mv "$STATUS.tmp" "$STATUS"
}

STARTED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

mkdir -p "$REPO/data"
{
  echo "==================== research-market '$MARKET' $(date '+%Y-%m-%d %H:%M:%S') ===================="

  write_status "running" "researching $MARKET"

  # require_claude prints where it looked, and puts the directory it found on PATH so anything
  # claude itself shells out to can find its neighbours.
  if ! require_claude; then
    write_status "failed" "The Claude Code CLI could not be found on this machine."
    exit 127
  fi

  # One claude-driven run at a time, whatever started it. This script never took the lock, so the
  # research pass could land on top of a daily run and the two read each other's Chrome tabs
  # (AGENT-RULES §13) -- the exact thing the lock exists to stop.
  if ! take_run_lock "markets"; then
    write_status "skipped-busy" "another run was already in progress, so $MARKET was not researched"
    exit 75
  fi

  # Refuse BEFORE spending, exactly as the daily run does. A ceiling that only applies to the
  # scheduled path would be a ceiling with a hole in it.
  if month_ceiling_blocks; then
    write_status "skipped-budget" "monthly spend ceiling reached; $MARKET was not researched"
    exit 0
  fi

  BUDGET="$(run_budget 5)"
  run_claude "/markets $MARKET" "$BUDGET" "market research: $MARKET"
  rc=$?

  "$NODE_BIN" "$REPO/server/record.mjs" log markets \
    "Market research for '$MARKET' finished (exit $rc), started from the dashboard" >/dev/null 2>&1

  if [ $rc -eq 0 ]; then
    write_status "ok" "$MARKET researched"
  else
    write_status "failed" "the research pass exited $rc — see data/.markets-run.log"
  fi

  echo "==================== done $(date '+%Y-%m-%d %H:%M:%S') (exit $rc) ===================="
  exit $rc
} >> "$LOG" 2>&1
