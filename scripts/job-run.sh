#!/usr/bin/env bash
# Local scheduler entrypoint for the daily job-search pipeline.
# Runs the /job-run slash command headless via the Claude Code CLI, from the repo root, so it has
# access to the local Markdown state, the agents in .claude/, and the connected MCP servers.
# Invoked by launchd/cron. See docs/SCHEDULER.md to install.
#
# Hardening, because an unattended run that dies is invisible — you only notice the digest never
# arrived, possibly days later:
#   * a hard timeout, so a wedged run cannot hold the data/ lock or burn budget indefinitely,
#   * one retry, since most failures here are transient (network, MCP not yet awake after boot),
#   * a spend cap via --max-budget-usd,
#   * a memory guard (scripts/rss-guard.sh) — on 2026-07-29 a fanned-out run spawned `claude`
#     processes that leaked to 15.9/12.0/6.1 GB and jetsam took the whole laptop down. The guard
#     kills a runaway child, or aborts the attempt, long before the kernel has to,
#   * data/.job-run.status.json, which server/audit.mjs reads so the supervisor can say
#     "yesterday's scheduled run never finished",
#   * a macOS notification on final failure.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

LOG_DIR="$REPO/data"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/.job-run.log"
STATUS="$LOG_DIR/.job-run.status.json"

# Tunables (override via the environment, e.g. in the launchd plist).
TIMEOUT_SECS="${JOBRUN_TIMEOUT_SECS:-2700}"   # 45 min
# Per-run cap. Config is the source of truth so the dashboard can change it; the env var stays as
# an override for one-off manual runs.
MAX_BUDGET_USD="${JOBRUN_MAX_BUDGET_USD:-}"
ATTEMPTS="${JOBRUN_ATTEMPTS:-2}"              # initial try + 1 retry
RETRY_SLEEP="${JOBRUN_RETRY_SLEEP:-60}"
# How many browser-only careers boards to read per run. Chrome is serial, so this is a budget, not a
# limit on ambition: 15 x ~10s drains the queue over a few days without starving the chat sweep.
BOARD_SWEEP_MAX="${JOBRUN_BOARD_SWEEP_MAX:-15}"
BOARD_SWEEP_TIMEOUT="${JOBRUN_BOARD_SWEEP_TIMEOUT:-900}"   # 15 min ceiling on the whole sweep
# Memory guard. Defaults leave plenty of room for a healthy run (the session itself sits around
# 0.5 GB) while catching a leaker within minutes. Set JOBRUN_GUARD=0 to disable.
GUARD_ENABLED="${JOBRUN_GUARD:-1}"
export GUARD_MAX_RSS_MB="${JOBRUN_GUARD_MAX_RSS_MB:-4096}"
export GUARD_TOTAL_RSS_MB="${JOBRUN_GUARD_TOTAL_RSS_MB:-12288}"
export JOBRUN_SOURCE=scheduled

# Force a FULL wake before touching Chrome. Measured on this machine across four consecutive
# mornings: at every 08:00 firing, `pmset -g log` showed the Mac in DarkWake — a background
# maintenance state (Time Machine, Spotlight, mail fetch) that macOS deliberately keeps invisible:
# no display, no new GUI windows. `open -g -a "Google Chrome"` was returning success (LaunchServices
# accepted it) while the actual process never appeared for the full 180s ensureChrome() budget in
# scripts/browser.mjs — DarkWake was silently discarding the launch. This looked identical to a
# broken permission or a slow machine; it was neither. `caffeinate -u` is the documented way to ask
# for a real wake (turns the display on, exits DarkWake) and needs no sudo, unlike `pmset schedule`.
#
# The `-t` ceiling (run timeout + 5 min) is a BACKSTOP, not the normal exit path — it exists only so
# a killed or crashed run cannot hold the Mac awake indefinitely. The normal path is the EXIT trap
# below, which kills it the moment the run actually finishes, so a run that completes in 10 minutes
# does not force the Mac awake for the other 40.
CAFFEINATE_PID=""
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -u -t $((TIMEOUT_SECS + 300)) >/dev/null 2>&1 &
  CAFFEINATE_PID=$!
  disown
fi

iso_now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Coverage, not just exit status. A run that read no messages and skipped 33 boards used to write
# state:"ok" and look identical to a complete one — the drought was invisible for 9 runs. These
# fields come from measurement (scripts/browser-probe.mjs, the board registry), never from the
# model's own account of what it did.
coverage_json() {
  node -e '
    const fs = require("fs");
    const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
    const b = rd("data/.browser-status.json");
    let queued = null;
    try {
      queued = fs.readFileSync("data/boards.md", "utf8")
        .split("\n")
        .filter((l) => /^\|/.test(l))
        .filter((l) => /\|\s*(browser|blocked)\s*\|/.test(l)).length;
    } catch {}
    process.stdout.write(JSON.stringify({
      browser_mode: b ? (b.capabilities?.read_mechanism ?? "none") : "unknown",
      can_read_pages: b ? Boolean(b.capabilities?.read_page_content) : null,
      chrome_running: b ? b.chrome_running : null,
      chrome_launched_by_us: b ? Boolean(b.chrome_launched_by_us) : null,
      whatsapp_unread: b?.whatsapp?.unread ?? null,
      blockers: b?.blockers ?? [],
      boards_browser_pending: queued,
    }));
  ' 2>/dev/null || printf '{"browser_mode":"unknown"}'
}

write_status() { # state, attempts_used, detail
  cat > "$STATUS" <<EOF
{
  "state": "$1",
  "started": "$STARTED",
  "finished": "$(iso_now)",
  "attempts": $2,
  "timeout_secs": $TIMEOUT_SECS,
  "detail": "$(printf '%s' "$3" | sed 's/"/\\"/g')",
  "coverage": $(coverage_json)
}
EOF
}

notify() { # title, message — best-effort desktop alert; never fatal.
  command -v osascript >/dev/null 2>&1 &&
    osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true
}

# Portable timeout: GNU `timeout` is not on macOS by default, and launchd's PATH is minimal even
# when Homebrew's is installed. Run the child in the background with a watchdog instead.
run_with_timeout() {
  local secs="$1"; shift
  "$@" &
  local child=$!
  ( sleep "$secs"; kill -TERM "$child" 2>/dev/null; sleep 10; kill -KILL "$child" 2>/dev/null ) &
  local watchdog=$!
  # Memory guard runs for the life of the attempt, watching everything under the claude process.
  local guard=""
  if [ "$GUARD_ENABLED" = "1" ] && [ -r "$REPO/scripts/rss-guard.sh" ]; then
    bash "$REPO/scripts/rss-guard.sh" "$child" &
    guard=$!
  fi
  wait "$child"; local rc=$?
  kill -TERM "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
  [ -n "$guard" ] && { kill -TERM "$guard" 2>/dev/null; wait "$guard" 2>/dev/null; }
  return $rc
}

# The WhatsApp MCP server is a STDIO server, so every claude session spawns its own instance — and
# two instances cannot share one WhatsApp device link. Any pre-existing instance therefore blocks
# this run from connecting, and the digest silently fails to send (observed 30 Jul, 31 Jul, 1 Aug:
# three runs in a row printed the digest into a log instead of delivering it).
#
# The blocker is usually NOT a reparented orphan — it is a stale-but-alive interactive session from
# days ago still holding the link. So this reaps every instance found before launching, not just
# ones with a dead parent. That does mean an interactive session open at 08:00 loses WhatsApp for
# the rest of its life; the scheduled digest is the higher priority, and the session gets it back on
# restart. Set JOBRUN_REAP_WHATSAPP=0 to disable.


reap_whatsapp_mcp() {
  [ "${JOBRUN_REAP_WHATSAPP:-1}" = "1" ] || { echo "whatsapp reaping disabled"; return 0; }
  local pids
  pids="$(pgrep -f "whatsapp-claude-channel" 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    echo "whatsapp MCP: no pre-existing instance — this run will spawn a clean one"
    return 0
  fi
  for p in $pids; do
    local pp owner age
    pp="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
    owner="$(ps -o comm= -p "${pp:-0}" 2>/dev/null || echo 'DEAD')"
    age="$(ps -o etime= -p "$p" 2>/dev/null | tr -d ' ')"
    echo "whatsapp MCP: killing pid $p (up $age, parent $pp [${owner:-DEAD}]) — it holds the device link"
    kill -TERM "$p" 2>/dev/null
  done
  sleep 2
  for p in $pids; do kill -0 "$p" 2>/dev/null && { echo "whatsapp MCP: pid $p ignored SIGTERM, forcing"; kill -KILL "$p" 2>/dev/null; }; done
  echo "whatsapp MCP: link released; claude will spawn a fresh instance on start"
}

# launchd gives a minimal PATH; resolve node once rather than at each call site.
NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"
COST_FILE="$(mktemp)"
# Single EXIT trap for both cleanups — a second `trap ... EXIT` would silently REPLACE this one
# rather than add to it, which is exactly how the caffeinate release would have gone missing.
trap 'rm -f "$COST_FILE"; [ -n "$CAFFEINATE_PID" ] && kill "$CAFFEINATE_PID" 2>/dev/null' EXIT

# ---- spend caps -------------------------------------------------------------------------------
# Read from config/job-seeker.config.md so the dashboard owns them. Falls back to a sane per-run cap
# and NO monthly ceiling, because a ceiling nobody set must never block a run.
read_cfg() {
  "$NODE_BIN" -e '
    const fs=require("fs");
    try{
      const t=fs.readFileSync("config/job-seeker.config.md","utf8");
      const m=new RegExp("^"+process.argv[1]+":[ \\t]*(.*)$","m").exec(t);
      process.stdout.write(m && m[1] ? m[1].trim() : "");
    }catch{ process.stdout.write(""); }
  ' "$1" 2>/dev/null
}
[ -n "$MAX_BUDGET_USD" ] || MAX_BUDGET_USD="$(read_cfg max_spend_per_run_usd)"
[ -n "$MAX_BUDGET_USD" ] || MAX_BUDGET_USD=5
MONTH_CAP="$(read_cfg max_spend_per_month_usd)"

# Stamped before the ceiling gate, because a refused run still writes a status file and that file
# needs a start time like any other.
STARTED="$(iso_now)"

# ---- monthly ceiling -------------------------------------------------------------------------
# Checked BEFORE any work starts, because the point is to not spend the money. A blocked run is
# the one thing here that must never be quiet: it writes its own state, notifies, and says exactly
# how to lift it. A silent skip would look identical to a run that simply found nothing.
if [ -n "$MONTH_CAP" ]; then
  SPENT="$("$NODE_BIN" "$REPO/server/record.mjs" list-spend 2>/dev/null \
    | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{process.stdout.write(String(JSON.parse(s).month_total_usd||0))}catch{process.stdout.write("0")}})' )"
  OVER="$("$NODE_BIN" -e 'process.stdout.write(Number(process.argv[1])>=Number(process.argv[2])?"1":"0")' "$SPENT" "$MONTH_CAP")"
  if [ "$OVER" = "1" ]; then
    echo "MONTHLY SPEND CEILING REACHED: \$$SPENT of \$$MONTH_CAP this month — not starting."
    echo "Raise max_spend_per_month_usd in the dashboard (Settings) or in config/job-seeker.config.md."
    write_status "skipped-budget" 0 "month-to-date \$$SPENT reached the \$$MONTH_CAP ceiling; run not started"
    notify "JobSeeker did not run" "Monthly spend ceiling reached (\$$SPENT of \$$MONTH_CAP). Raise it in Settings."
    "$NODE_BIN" "$REPO/server/record.mjs" log run-skipped "monthly spend ceiling reached: \$$SPENT of \$$MONTH_CAP" >/dev/null 2>&1
    exit 0
  fi
  echo "spend this month: \$$SPENT of \$$MONTH_CAP ceiling"
fi

write_status "running" 0 "in progress"

{
  echo "==================== job-run $(date '+%Y-%m-%d %H:%M:%S') ===================="
  if ! command -v claude >/dev/null 2>&1; then
    echo "ERROR: 'claude' CLI not found on PATH. Install Claude Code, or edit PATH in the launchd plist."
    write_status "failed" 0 "claude CLI not found on PATH"
    notify "JobSeeker run failed" "claude CLI not found on PATH"
    exit 127
  fi

  reap_whatsapp_mcp

  # Measure browser capability once, up front. Runs before `claude` so the verdict is a fact the
  # run reads rather than a story it invents; exports the summary so the digest cannot contradict
  # it. Never fatal — "no browser" is a reportable outcome, not a failed run.
  if node "$REPO/scripts/browser-probe.mjs" 2>&1; then :; else echo "browser-probe failed (continuing)"; fi
  read_mech() { node -e 'try{const b=require("./data/.browser-status.json");process.stdout.write(b.capabilities?.read_mechanism??"none")}catch{process.stdout.write("unknown")}' 2>/dev/null || echo unknown; }

  # One retry when the first probe finds nothing. The observed failure was a COLD Chrome at 08:00:
  # it had been launched but was still settling, the probe called it a day, and the entire morning
  # ran browser-less -- no WhatsApp, no LinkedIn, boards skipped. Waiting 45s once is far cheaper
  # than losing the day's sweep, and it costs nothing on the normal path where Chrome is already up.
  if [ "$(read_mech)" = "none" ]; then
    echo "browser: no read mechanism on first probe — waiting 45s for Chrome to settle, then retrying once"
    sleep 45
    node "$REPO/scripts/browser-probe.mjs" 2>&1 || true
  fi
  JOBRUN_BROWSER="$(read_mech)"
  export JOBRUN_BROWSER
  echo "browser capability: read-pages via ${JOBRUN_BROWSER}"

  # Drain some of the browser board queue BEFORE claude runs, so the scout reads cached page text
  # instead of being told to "open Chrome" with tools it does not have in a headless run. This is
  # the mechanical half; scoring the listings against the CV stays with role-scout.
  # Skipped entirely when the probe says pages are unreadable — there is nothing it could do.
  if [ "$JOBRUN_BROWSER" != "none" ] && [ "$JOBRUN_BROWSER" != "unknown" ]; then
    echo "---- board sweep (max ${BOARD_SWEEP_MAX} boards, oldest first, ${BOARD_SWEEP_TIMEOUT}s cap) ----"
    # Hard-capped. Every step inside is bounded, but this runs BEFORE the claude attempt and outside
    # its watchdog — one wedged page must not be able to eat the morning.
    run_with_timeout "$BOARD_SWEEP_TIMEOUT" node "$REPO/scripts/board-sweep.mjs" --max "$BOARD_SWEEP_MAX" 2>&1 ||
      echo "board-sweep did not finish cleanly (continuing; the queue is picked up next run)"
  else
    echo "board sweep skipped: no way to read pages (${JOBRUN_BROWSER})"
  fi

  rc=1
  for attempt in $(seq 1 "$ATTEMPTS"); do
    echo "---- attempt $attempt/$ATTEMPTS (timeout ${TIMEOUT_SECS}s, budget \$${MAX_BUDGET_USD}) ----"
    # -p runs a single prompt headlessly and exits. The pipeline queues approvals; it never
    # applies or sends on its own.
    # Tells /job-run this is the scheduled run rather than a manual one, so the run-start row in
    # the activity log says which.
      # --output-format json so the run's ACTUAL cost can be recorded. Previously the log printed
      # the budget LIMIT and never the spend, so "what is this costing me" had no answer and a
      # ceiling across runs was impossible. The JSON carries `result` (the narrative) alongside
      # `total_cost_usd`, so the readable log survives -- extracted back out below.
      RESP="$(mktemp)"
      # stdout ONLY. `2>&1` here was silently breaking the whole spend ledger: any stderr line the
      # CLI emits (a warning, a notice) landed in the same file as the JSON, so JSON.parse threw,
      # the catch below printed the raw blob, and total_cost_usd was never extracted. Four
      # consecutive runs logged "spend NOT recorded" while their own output carried
      # total_cost_usd 3.8 / 4.9 — which meant data/spend.md stayed empty, Settings reported
      # "$0.00 across 0 runs", and the monthly ceiling could never fire no matter what was spent.
      # stderr now goes to the run log, where it is readable but cannot corrupt the payload.
      JOBRUN_SOURCE=scheduled \
        run_with_timeout "$TIMEOUT_SECS" claude -p "/job-run" \
          --max-budget-usd "$MAX_BUDGET_USD" --output-format json > "$RESP"
      rc=$?

      # Put the narrative back in the log, so this costs nothing in readability. If the response is
      # not JSON (a crash, a watchdog kill) print it raw rather than losing it.
      "$NODE_BIN" -e '
        const fs = require("fs");
        const raw = fs.readFileSync(process.argv[1], "utf8");
        try {
          const d = JSON.parse(raw);
          if (d.result) process.stdout.write(d.result + "\n");
          if (typeof d.total_cost_usd === "number") {
            fs.writeFileSync(process.argv[2], String(d.total_cost_usd));
            process.stdout.write("\n---- cost $" + d.total_cost_usd.toFixed(4) +
              "  " + (d.num_turns ?? "?") + " turns ----\n");
          }
        } catch { process.stdout.write(raw); }
      ' "$RESP" "$COST_FILE" 2>/dev/null || cat "$RESP"
      rm -f "$RESP"
    if [ $rc -eq 0 ]; then
      echo "---- attempt $attempt succeeded ----"
      break
    fi
    # 143 = SIGTERM, i.e. our watchdog fired.
    if [ $rc -eq 143 ]; then
      echo "---- attempt $attempt TIMED OUT after ${TIMEOUT_SECS}s ----"
    else
      echo "---- attempt $attempt failed (exit $rc) ----"
    fi
    [ "$attempt" -lt "$ATTEMPTS" ] && { echo "retrying in ${RETRY_SLEEP}s..."; sleep "$RETRY_SLEEP"; }
  done

    # Record what it cost, whatever the outcome. A failed or timed-out run still spends money, and
    # a ledger that only counts successes would understate the month and let the ceiling be
    # overshot silently.
    if [ -s "$COST_FILE" ]; then
      COST="$(cat "$COST_FILE")"
      "$NODE_BIN" "$REPO/server/record.mjs" add-spend "{\"started\":\"$STARTED\",\"cost_usd\":$COST,\"outcome\":\"$([ $rc -eq 0 ] && echo ok || echo failed)\",\"detail\":\"attempt $attempt of $ATTEMPTS\"}" >/dev/null 2>&1 \
        && echo "spend recorded: \$$COST"
    else
      echo "spend NOT recorded — no cost returned (crash, timeout, or non-JSON response)"
    fi


  # A run that dies mid-write leaves the advisory lock behind; it self-heals after 60s (see
  # server/lock.mjs) but clearing it here means the dashboard is responsive immediately.
  if [ $rc -ne 0 ] && [ -e "$REPO/data/.lock" ]; then
    echo "clearing stale data/.lock left by the failed run"
    rm -rf "$REPO/data/.lock"
  fi

  # Report the attempt actually USED ($attempt, which survives the loop), not the configured
  # maximum. Passing $ATTEMPTS made a first-try success read as "attempts: 2" — indistinguishable
  # from a run that needed its retry, which is exactly the signal this file exists to carry.
  # The digest is the whole point of an unattended run, and its delivery has failed silently before
  # (the WhatsApp MCP server is stdio — every session spawns its own, and a second instance cannot
  # claim a device link an orphaned one still holds). /job-run always writes the digest to
  # data/.last-digest.md with a `delivered:` line, so a push failure degrades to a desktop
  # notification rather than to nothing at all.
  DIGEST="$LOG_DIR/.last-digest.md"
  if [ -r "$DIGEST" ]; then
    delivery="$(grep -m1 -E '^(delivered|not-delivered):' "$DIGEST" || echo '')"
    headline="$(grep -m1 -E '^- ' "$DIGEST" | sed 's/^- //' | cut -c1-110)"
    case "$delivery" in
      not-delivered:*)
        echo "DIGEST NOT DELIVERED — ${delivery#not-delivered: }"
        notify "JobSeeker digest not delivered" "${headline:-See data/.last-digest.md} — WhatsApp failed, digest saved locally"
        ;;
      delivered:*) echo "digest delivered via ${delivery#delivered: }" ;;
      *)           echo "digest file present but carries no delivery line" ;;
    esac
  else
    echo "WARNING: no data/.last-digest.md written — the run produced no digest"
    [ $rc -eq 0 ] && notify "JobSeeker run finished with no digest" "Run reported success but wrote no digest file"
  fi

  if [ $rc -eq 0 ]; then
    write_status "ok" "$attempt" "completed on attempt $attempt of $ATTEMPTS"
  else
    write_status "failed" "$attempt" "exit code $rc after $attempt attempt(s) of $ATTEMPTS"
    notify "JobSeeker daily run failed" "Exit $rc after $attempt attempt(s). See data/.job-run.log"
  fi

  echo "==================== done $(date '+%Y-%m-%d %H:%M:%S') (exit $rc) ===================="
  exit $rc
} >> "$LOG" 2>&1
