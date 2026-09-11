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
    log_problem markets-failed "Researching '$MARKET' could not start: the Claude Code CLI is not on this machine."
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
    log_problem markets-failed "Researching '$MARKET' did not start: the monthly spend ceiling has been reached. Raise it in Settings ▸ Spending."
    exit 0
  fi

  BUDGET="$(run_budget 5)"
  # Captured as well as logged, because the reason a run failed is in what claude said and the
  # message the dashboard shows has to be built from it. NOT a pipe into tee: run_claude sets
  # RUN_CLAUDE_DENIED, and the left-hand side of a pipeline is a subshell whose variables die with
  # it -- the one fact worth reporting would be the one fact thrown away.
  RUNLOG="$(mktemp)"
  run_claude "/markets $MARKET" "$BUDGET" "market research: $MARKET" > "$RUNLOG" 2>&1
  rc=$?
  cat "$RUNLOG"

  # The claim to check is not "claude exited 0" but "the list has companies in it that were not
  # there before". Those came apart completely: four consecutive runs were refused every tool they
  # needed, wrote nothing, exited 0, and were each recorded as "Cyber Security researched" while
  # data/markets/cyber-security.md sat at its empty scaffold. Both halves matter -- rows alone
  # would call a stale list from last week a success.
  read -r ROWS FRESH <<EOF
$("$NODE_BIN" -e '
  const fs=require("fs"), path=require("path");
  const name=process.argv[1], since=Date.parse(process.argv[2])||0;
  const slug=(s)=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
  const dir="data/markets";
  let file=path.join(dir, slug(name)+".md");
  // The agent chooses the filename, so a market whose slug does not match falls back to the file
  // that names this market in its own heading.
  try{
    if(!fs.existsSync(file)){
      for(const f of fs.readdirSync(dir).filter(f=>f.endsWith(".md"))){
        const m=/^#\s*Market:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir,f),"utf8"));
        if(m && slug(m[1])===slug(name)){ file=path.join(dir,f); break; }
      }
    }
  }catch{}
  let rows=0, fresh=0;
  try{
    const t=fs.readFileSync(file,"utf8");
    rows=t.split("\n").filter((l)=>{ const s=l.trim();
      return s.startsWith("|") && !/^\|\s*-+/.test(s) && !/^\|\s*company\s*\|/i.test(s); }).length;
    fresh=fs.statSync(file).mtimeMs>=since-1000 ? 1 : 0;
  }catch{}
  process.stdout.write(rows+" "+fresh);
' "$MARKET" "$STARTED" 2>/dev/null || echo "0 0")
EOF

  if [ $rc -eq 0 ] && [ "${ROWS:-0}" -gt 0 ] && [ "${FRESH:-0}" = "1" ]; then
    write_status "ok" "$MARKET researched — $ROWS companies"
    "$NODE_BIN" "$REPO/server/record.mjs" log markets \
      "Market research for '$MARKET' finished: $ROWS companies ranked" >/dev/null 2>&1
  else
    if [ $rc -ne 0 ]; then
      FALLBACK="The research pass exited $rc — the full output is in data/.markets-run.log."
    elif [ "${ROWS:-0}" -gt 0 ]; then
      FALLBACK="The run finished but did not update the list — data/markets/ still holds what was there before."
    else
      FALLBACK="The run finished but wrote no companies, so nothing was saved."
    fi
    WHY="$(classify_failure "$RUNLOG" "$FALLBACK")"
    write_status "failed" "$WHY"
    # In the activity log, not only in a file under data/ that nobody opens.
    log_problem markets-failed "Researching '$MARKET' produced nothing. $WHY"
    rc=1
  fi
  rm -f "$RUNLOG"

  echo "==================== done $(date '+%Y-%m-%d %H:%M:%S') (exit $rc) ===================="
  exit $rc
} >> "$LOG" 2>&1
