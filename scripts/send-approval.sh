#!/usr/bin/env bash
# Send one message you have already approved, from the dashboard.
#
#   bash scripts/send-approval.sh appr_ab12cd
#
# This is the last step of the approval loop, and the ONLY thing in the repo that acts on your
# behalf. It refuses unless the record already says approved/edited — the permission is the
# record, never the click that started this script, so an approval that was rejected, still
# pending, or already sent can never be sent by rerunning this.
#
# Email is not actually sent by anything here: the comms-agent prepares a Gmail draft and you
# press send. LinkedIn is copy/paste. Only WhatsApp goes out directly.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
. "$REPO/scripts/lib/claude-run.sh"

ID="${1:-}"
LOG="$REPO/data/.approvals.log"

# The id becomes a filename and reaches a slash command, so it is validated against the same shape
# record.mjs enforces rather than merely quoted.
if ! printf '%s' "$ID" | grep -Eq '^appr_[A-Za-z0-9_-]{1,40}$'; then
  echo "usage: send-approval.sh <appr_id>" >&2
  exit 64
fi

mkdir -p "$REPO/data"
{
  echo "==================== send-approval '$ID' $(date '+%Y-%m-%d %H:%M:%S') ===================="

  require_claude || { "$NODE_BIN" "$REPO/server/record.mjs" approval-dispatch "$ID" failed "claude CLI not on PATH" >/dev/null 2>&1; exit 127; }

  # Re-read the record here, in the process that is about to act. The dashboard checked it too, but
  # between the click and this line the file may have been edited by hand or by an agent, and the
  # check that matters is the one closest to the send.
  GATE="$("$NODE_BIN" -e '
    const fs=require("fs");
    let t;
    try { t=fs.readFileSync("data/approvals/"+process.argv[1]+".md","utf8"); }
    catch { process.stdout.write("refuse no-such-approval"); process.exit(0); }
    const m=/^---\n([\s\S]*?)\n---/.exec(t) || [];
    const f=(k)=>{ const x=new RegExp("^"+k+":[ \t]*(.*)$","m").exec(m[1]||""); return x?x[1].trim():""; };
    const status=f("status"), dispatch=f("dispatch"), kind=f("kind");
    if(!["approved","edited"].includes(status)) process.stdout.write("refuse status="+(status||"unset"));
    else if(["sent","running"].includes(dispatch)) process.stdout.write("refuse dispatch="+dispatch);
    else if(kind==="apply") process.stdout.write("refuse kind=apply");
    else process.stdout.write("ok");
  ' "$ID" 2>&1)"

  if [ "$GATE" != "ok" ]; then
    echo "NOT SENDING $ID — $GATE"
    exit 65
  fi

  if ! take_run_lock "send-approval"; then exit 75; fi

  "$NODE_BIN" "$REPO/server/record.mjs" approval-dispatch "$ID" running "sending from the dashboard" >/dev/null 2>&1

  BUDGET="$(run_budget 1)"
  run_claude "/send-approval $ID" "$BUDGET" "send approval $ID"
  rc=$?

  if [ $rc -eq 0 ]; then
    "$NODE_BIN" "$REPO/server/record.mjs" approval-dispatch "$ID" sent "sent from the dashboard" >/dev/null 2>&1
  else
    # `failed` is deliberately re-dispatchable: the send did not happen, so refusing to try again
    # would strand the message with no way forward but hand-editing a file.
    "$NODE_BIN" "$REPO/server/record.mjs" approval-dispatch "$ID" failed "exit $rc — see data/.approvals.log" >/dev/null 2>&1
  fi

  echo "==================== done $(date '+%Y-%m-%d %H:%M:%S') (exit $rc) ===================="
  exit $rc
} >> "$LOG" 2>&1
