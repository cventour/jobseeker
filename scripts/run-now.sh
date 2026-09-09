#!/usr/bin/env bash
# Run one of the job-search commands right now, from the dashboard's "Run now" buttons.
# Windows twin: scripts/win/run-now.ps1 — change both together.
#
#   bash scripts/run-now.sh track
#
# The scheduled path (scripts/job-run.sh) already existed; this is the same work when you do not
# want to wait for 08:00, or have no schedule installed at all. It never applies and never sends:
# every command below queues approvals for you, exactly as the scheduled run does.
#
# It SPENDS MONEY. The per-run budget and the monthly ceiling from your config are honoured here
# for the same reason they are honoured by the scheduler — a cap that only applies to the paths you
# are not looking at is not a cap.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
. "$REPO/scripts/lib/claude-run.sh"

SLUG="${1:-}"
TARGET="${2:-}"
LOG="$REPO/data/.run-now.log"
STATUS="$REPO/data/.run-now.status.json"

# The whole menu, in one place: slug -> slash command, label, per-run budget default, minutes.
#
# `apply` is the only one that takes an argument. It shares this script — and therefore the run lock
# and the spend caps — because it drives Chrome like the others, and two agents in the same browser
# read each other's tabs (AGENT-RULES §13).
case "$SLUG" in
  job-run)  PROMPT="/job-run"; LABEL="Full daily run";        DEFAULT_BUDGET=5 ;;
  track)    PROMPT="/track";   LABEL="Read my channels";      DEFAULT_BUDGET=3 ;;
  curate)   PROMPT="/curate";  LABEL="Find new roles";        DEFAULT_BUDGET=3 ;;
  followup) PROMPT="/followup";LABEL="Draft due follow-ups";  DEFAULT_BUDGET=2 ;;
  apply)
    # The id reaches this from a web form, and it is about to be interpolated into a prompt. An
    # allow-list on the SHAPE, checked again here rather than trusted from the caller.
    if ! printf '%s' "$TARGET" | grep -qE '^prop_[a-z0-9]+$'; then
      echo "invalid proposal id '$TARGET' — expected prop_xxxxxx" >&2
      exit 64
    fi
    if [ ! -f "$REPO/data/proposals/$TARGET.md" ]; then
      echo "no such proposal: $TARGET" >&2
      exit 66
    fi
    PROMPT="/apply-fill $TARGET"; LABEL="Fill an application"; DEFAULT_BUDGET=3 ;;
  *)
    echo "usage: run-now.sh <job-run|track|curate|followup|apply <proposal-id>>" >&2
    exit 64 ;;
esac

write_status() { # state, detail
  cat > "$STATUS" <<JSON
{
  "slug": "$SLUG",
  "label": "$LABEL",
  "state": "$1",
  "started": "$STARTED",
  "finished": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "detail": "$(printf '%s' "$2" | sed 's/"/\\"/g')"
}
JSON
}

STARTED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

mkdir -p "$REPO/data"
{
  echo "==================== run-now '$SLUG' $(date '+%Y-%m-%d %H:%M:%S') ===================="

  require_claude || { write_status "failed" "claude CLI not found on PATH"; exit 127; }

  # Taken here rather than inside the claude call, so a second click is refused before it has
  # spent anything, and the dashboard can see who holds it.
  if ! take_run_lock "$SLUG"; then
    write_status "skipped-busy" "another run was already in progress"
    exit 75
  fi

  if month_ceiling_blocks; then
    write_status "skipped-budget" "monthly spend ceiling reached; run not started"
    "$NODE_BIN" "$REPO/server/record.mjs" log run-skipped "monthly spend ceiling reached: '$SLUG' not started from the dashboard" >/dev/null 2>&1
    exit 0
  fi

  BUDGET="$(run_budget "$DEFAULT_BUDGET")"
  echo "---- $LABEL ($PROMPT), budget \$$BUDGET ----"
  "$NODE_BIN" "$REPO/server/record.mjs" log run-start "$LABEL started from the dashboard ($PROMPT)" >/dev/null 2>&1

  if [ "$SLUG" = "job-run" ]; then
    # The daily pipeline has hardening the other commands do not need — a watchdog, one retry, a
    # memory guard, a full wake before it touches Chrome. Delegate rather than reimplement a
    # weaker copy of it here; it writes its own log and its own status file.
    JOBRUN_SOURCE=manual bash "$REPO/scripts/job-run.sh"
    rc=$?
    echo "job-run.sh exited $rc (its own output is in data/.job-run.log)"
  else
    run_claude "$PROMPT" "$BUDGET" "$LABEL (dashboard)"
    rc=$?
  fi

  "$NODE_BIN" "$REPO/server/record.mjs" log run-finish "$LABEL finished (exit $rc)" >/dev/null 2>&1
  if [ $rc -eq 0 ]; then write_status "ok" "$LABEL completed"; else write_status "failed" "$LABEL exited $rc"; fi

  echo "==================== done $(date '+%Y-%m-%d %H:%M:%S') (exit $rc) ===================="
  exit $rc
} >> "$LOG" 2>&1
