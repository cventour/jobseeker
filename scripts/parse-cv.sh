#!/usr/bin/env bash
# Read the newest uploaded CV into data/profile.md, by running /jobseeker parse-cv headlessly.
# Windows twin: scripts/win/parse-cv.ps1 — change both together.
#
#   bash scripts/parse-cv.sh
#
# The welcome wizard starts this the moment a CV is dropped, and then lets you walk on — so this
# writes data/.cv-parse.status.json as it goes, which is the only way the page can tell the
# difference between "still reading" and "died twenty seconds ago". Without that file a failed
# parse is indistinguishable from a slow one, and the wizard would wait forever.
#
# It SPENDS MONEY (a small amount — one PDF read and one file written), and honours the same caps
# as every other path that calls claude.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
. "$REPO/scripts/lib/claude-run.sh"

LOG="$REPO/data/.cv-parse.log"
STATUS="$REPO/data/.cv-parse.status.json"

CV="$(ls -t templates/cv/*.pdf 2>/dev/null | head -1)"

write_status() { # state, detail
  mkdir -p "$REPO/data"
  cat > "$STATUS" <<JSON
{
  "state": "$1",
  "file": "$(printf '%s' "${CV:-}" | sed 's/"/\\"/g')",
  "started": "$STARTED",
  "finished": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "detail": "$(printf '%s' "$2" | sed 's/"/\\"/g')"
}
JSON
}

STARTED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

if [ -z "$CV" ]; then
  write_status "failed" "No PDF in templates/cv/ — nothing to read."
  echo "no CV to parse" >&2
  exit 66
fi

write_status "running" "reading $CV"

{
  echo "==================== parse-cv '$CV' $(date '+%Y-%m-%d %H:%M:%S') ===================="
  require_claude || {
    write_status "failed" "The Claude Code CLI is not on this machine's PATH."
    log_problem cv-failed "Reading $(basename "$CV") could not start: the Claude Code CLI is not on this machine."
    exit 127
  }

  if month_ceiling_blocks; then
    write_status "failed" "The monthly spending limit has been reached, so the CV was not read."
    log_problem cv-failed "Reading $(basename "$CV") did not start: the monthly spend ceiling has been reached. Raise it in Settings ▸ Spending."
    exit 0
  fi

  # Deliberately NOT under the run lock. Reading a CV touches no browser and no channel, it is the
  # one thing the wizard needs to overlap with everything else, and blocking it behind a 40-minute
  # /jobseeker job-run would strand someone on step 2 with no explanation.
  # Captured as well as logged, because the reason a run failed is in what claude said and the
  # message the wizard shows has to be built from it. Without this the only signal is the exit
  # code, and every non-zero exit was reported to the user as "your PDF is probably a scan".
  # NOT a pipe into tee: run_claude sets RUN_CLAUDE_DENIED, and the left-hand side of a pipeline is
  # a subshell whose variables die with it — the one fact worth reporting would be the one thrown
  # away. Redirect, then print, which lands in the same log either way.
  RUNLOG="$(mktemp)"
  run_claude "/jobseeker parse-cv" "$(run_budget 1)" "parse CV" > "$RUNLOG" 2>&1
  rc=$?
  cat "$RUNLOG"

  # The claim to check is not "claude exited 0" but "data/profile.md now describes a real person".
  # A run that fails halfway can exit clean and leave the placeholder behind, and a wizard that
  # believes the exit code would then pre-fill nothing and explain nothing.
  PARSED="$("$NODE_BIN" -e '
    const fs=require("fs");
    try{
      const t=fs.readFileSync("data/profile.md","utf8");
      const m=/^titles:[ \t]*(.*)$/m.exec(t);
      process.stdout.write(m && m[1].trim() && !/No CV parsed yet/i.test(t) ? "1" : "0");
    }catch{ process.stdout.write("0"); }' 2>/dev/null)"

  if [ $rc -eq 0 ] && [ "$PARSED" = "1" ]; then
    write_status "ok" "Read $(basename "$CV")"
  elif [ "$PARSED" = "1" ]; then
    write_status "ok" "Read $(basename "$CV") (the run reported exit $rc)"
  else
    # Name the actual cause. A failed parse has several, they need different answers, and the file
    # is only one of them -- telling someone with an expired login to re-export their CV sends them
    # to fix a thing that was never broken.
    WHY="$(classify_failure "$RUNLOG" "Nothing could be read from $(basename "$CV"). If it is a scan rather than a text PDF, export it again from Word, Pages or Google Docs.")"
    write_status "failed" "$WHY"
    log_problem cv-failed "Reading $(basename "$CV") produced nothing. $WHY"
  fi
  rm -f "$RUNLOG"

  echo "==================== done $(date '+%Y-%m-%d %H:%M:%S') (exit $rc, parsed=$PARSED) ===================="
  exit $rc
} >> "$LOG" 2>&1
