#!/usr/bin/env bash
# Run one of the job-search commands right now, from the dashboard's "Run now" buttons.
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
LOG="$REPO/data/.run-now.log"
STATUS="$REPO/data/.run-now.status.json"

# The whole menu, in one place: slug -> slash command, label, per-run budget default, minutes.
case "$SLUG" in
  job-run)  PROMPT="/job-run"; LABEL="Full daily run";        DEFAULT_BUDGET=5 ;;
  track)    PROMPT="/track";   LABEL="Read my channels";      DEFAULT_BUDGET=3 ;;
  curate)   PROMPT="/curate";  LABEL="Find new roles";        DEFAULT_BUDGET=3 ;;
  followup) PROMPT="/followup";LABEL="Draft due follow-ups";  DEFAULT_BUDGET=2 ;;
  *)
    echo "usage: run-now.sh <job-run|track|curate|followup>" >&2
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
