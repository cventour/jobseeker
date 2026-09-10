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

JOBRUN_STATUS="$REPO/data/.job-run.status.json"

# One field out of the status file job-run.sh writes. Whether that file belongs to the run WE
# started is decided by the caller comparing its contents before and after, not by comparing
# timestamps: these stamps have one-second resolution, so a job-run that died instantly would
# sometimes carry the same second as our own start and be accepted as fresh. Handing back last
# hour's "ok" is worse than handing back nothing at all, and it is the same class of bug as the one
# this whole change is about.
jobrun_field() { # field -> value, or nothing
  "$NODE_BIN" -e '
    const fs=require("fs");
    try{
      const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      if(s.state === "running") process.exit(0);   // still in flight; not a verdict
      process.stdout.write(String(s[process.argv[2]] ?? ""));
    }catch{}
  ' "$JOBRUN_STATUS" "$1" 2>/dev/null
}

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
    # Snapshot the verdict already on disk, so "job-run wrote one" can be told from "job-run died
    # before it could". Contents, not timestamps — see jobrun_field.
    JR_BEFORE="$(cat "$JOBRUN_STATUS" 2>/dev/null)" || JR_BEFORE=""
    JOBRUN_SOURCE=manual bash "$REPO/scripts/job-run.sh"
    rc=$?
    echo "job-run.sh exited $rc (its own output is in data/.job-run.log)"
    # And its status file is the verdict, not its exit code. job-run.sh deliberately records
    # `failed` for a run that finished but wrote no digest — the one deliverable it exists to
    # produce — while still exiting 0, so trusting rc here reported "Full daily run completed" for
    # a run whose own status file, written seconds earlier, said the opposite. That is what "it
    # said it finished and nothing appeared" is: not a run that lied, a verdict thrown away by
    # the caller that displayed it.
    JR_AFTER="$(cat "$JOBRUN_STATUS" 2>/dev/null)" || JR_AFTER=""
    if [ -n "$JR_AFTER" ] && [ "$JR_AFTER" != "$JR_BEFORE" ]; then
      JR_STATE="$(jobrun_field state)"
      JR_DETAIL="$(jobrun_field detail)"
    fi
  else
    # Captured as well as logged, so a failure can be explained in words rather than as an exit
    # code. Redirected rather than piped into tee: run_claude sets RUN_CLAUDE_DENIED, and the
    # left-hand side of a pipeline is a subshell whose variables die with it.
    RUNLOG="$(mktemp)"
    run_claude "$PROMPT" "$BUDGET" "$LABEL (dashboard)" > "$RUNLOG" 2>&1
    rc=$?
    cat "$RUNLOG"
  fi

  "$NODE_BIN" "$REPO/server/record.mjs" log run-finish "$LABEL finished (exit $rc)" >/dev/null 2>&1
  if [ -n "${JR_STATE:-}" ]; then
    write_status "$JR_STATE" "$LABEL ${JR_DETAIL:-finished}"
    # Keep the exit code and the status agreeing. Nothing consumes this one — the dashboard reads
    # the file — but a script whose exit code contradicts what it just wrote down is how this bug
    # got here in the first place.
    [ "$JR_STATE" = "ok" ] || [ "$JR_STATE" = "partial" ] || rc=1
  elif [ $rc -eq 0 ]; then
    write_status "ok" "$LABEL completed"
  else
    # Say why, and say it where someone will see it. job-run writes its own row, so this covers the
    # other buttons; a status file is overwritten by the next run, the activity log is not.
    WHY="$(classify_failure "${RUNLOG:-}" "$LABEL exited $rc — the full output is in data/.run-now.log.")"
    write_status "failed" "$WHY"
    log_problem run-failed "$LABEL did not finish. $WHY"
  fi
  [ -n "${RUNLOG:-}" ] && rm -f "$RUNLOG"

  echo "==================== done $(date '+%Y-%m-%d %H:%M:%S') (exit $rc) ===================="
  exit $rc
} >> "$LOG" 2>&1
