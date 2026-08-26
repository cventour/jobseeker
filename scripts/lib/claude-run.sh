#!/usr/bin/env bash
# Shared plumbing for every path that spends money by calling `claude -p` outside the scheduler:
# the dashboard's Run now buttons, market research, and the approval sender.
#
# It exists because that plumbing is not optional and had already been duplicated once. A caller
# that forgets any of it fails in a way nobody notices for days:
#   * the monthly ceiling must be checked BEFORE the spend, or it is a ceiling with a hole in it,
#   * the actual cost must be parsed out of the JSON and written to the ledger, or Settings reports
#     "$0.00 across 0 runs" while real money is going out (this happened for five runs),
#   * stdout must carry ONLY the JSON — a stray stderr line breaks the parse and loses the cost,
#   * and two runs must never overlap, because Chrome is a serial resource (AGENT-RULES §13).
#
# Source it, do not execute it:  . "$(dirname "$0")/lib/claude-run.sh"
# It expects REPO to be set to the repo root and the cwd to be there.

NODE_BIN="${NODE_BIN:-$(command -v node || echo /opt/homebrew/bin/node)}"

# Read one key out of the user's config. Config is the source of truth for the caps so the
# dashboard can change them without editing scripts.
read_cfg() {
  "$NODE_BIN" -e '
    const fs=require("fs");
    try{
      const t=fs.readFileSync("config/job-seeker.config.md","utf8");
      const m=new RegExp("^"+process.argv[1]+":[ \t]*(.*)$","m").exec(t);
      process.stdout.write(m && m[1] ? m[1].trim() : "");
    }catch{ process.stdout.write(""); }
  ' "$1" 2>/dev/null
}

# ---- the run lock -----------------------------------------------------------------------------
# One claude-driven run at a time, whatever started it. Not an optimisation: two runs read Chrome
# at once, and the second one's reads land in the first one's tabs.
#
# The lock records the PID so a crashed run cannot wedge the button forever — a lock whose process
# is gone is stale and taken over, rather than needing the user to delete a file they were never
# told about.
RUN_LOCK="${RUN_LOCK:-$REPO/data/.run-now.lock}"

run_lock_holder() { # prints "<pid> <slug> <started>" if a LIVE run holds the lock, else nothing
  [ -r "$RUN_LOCK" ] || return 0
  local pid slug started
  read -r pid slug started < "$RUN_LOCK" 2>/dev/null || return 0
  [ -n "${pid:-}" ] || return 0
  if kill -0 "$pid" 2>/dev/null; then printf '%s %s %s' "$pid" "$slug" "$started"; else rm -f "$RUN_LOCK"; fi
}

take_run_lock() { # slug — fails (rc 1) if another live run holds it
  local held; held="$(run_lock_holder)"
  if [ -n "$held" ]; then
    echo "ANOTHER RUN IS IN PROGRESS ($held) — not starting '$1'. Chrome can only be driven by one run at a time."
    return 1
  fi
  mkdir -p "$(dirname "$RUN_LOCK")"
  printf '%s %s %s\n' "$$" "$1" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$RUN_LOCK"
  # Released on ANY exit, including a kill. Callers must not install their own EXIT trap: a second
  # `trap ... EXIT` replaces this one rather than adding to it, and the lock would leak.
  trap 'rm -f "$RUN_LOCK"' EXIT
  return 0
}

# ---- spend ------------------------------------------------------------------------------------
# Refuse before spending. A blocked run says so loudly and says how to lift it; a silent skip is
# indistinguishable from a run that found nothing.
month_ceiling_blocks() { # prints the reason and returns 0 (blocked) / 1 (clear)
  local cap spent over
  cap="$(read_cfg max_spend_per_month_usd)"
  [ -n "$cap" ] || return 1
  spent="$("$NODE_BIN" "$REPO/server/record.mjs" list-spend 2>/dev/null \
    | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{process.stdout.write(String(JSON.parse(s).month_total_usd||0))}catch{process.stdout.write("0")}})')"
  over="$("$NODE_BIN" -e 'process.stdout.write(Number(process.argv[1])>=Number(process.argv[2])?"1":"0")' "$spent" "$cap")"
  if [ "$over" = "1" ]; then
    echo "MONTHLY SPEND CEILING REACHED: \$$spent of \$$cap this month — not starting."
    echo "Raise max_spend_per_month_usd in the dashboard (Settings ▸ Spending) to lift it."
    return 0
  fi
  echo "spend this month: \$$spent of \$$cap ceiling"
  return 1
}

run_budget() { # per-run cap, config first, then the passed default
  local b; b="$(read_cfg max_spend_per_run_usd)"
  printf '%s' "${b:-${1:-5}}"
}

# Run one slash command headlessly and record what it cost. Prints the model's narrative to stdout
# and returns claude's exit code.
#   run_claude "<prompt>" "<budget>" "<ledger detail>"
run_claude() {
  local prompt="$1" budget="$2" detail="$3"
  local started resp rc
  started="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  resp="$(mktemp)"
  # stdout only — see the note at the top of this file.
  claude -p "$prompt" --max-budget-usd "$budget" --output-format json > "$resp"
  rc=$?

  "$NODE_BIN" -e '
    const fs=require("fs");
    const raw=fs.readFileSync(process.argv[1],"utf8");
    const parse=(s)=>{ try { return JSON.parse(s); } catch { return null; } };
    let d=parse(raw);
    if(!d){ const lines=raw.split("\n").filter(l=>l.trim().startsWith("{"));
            for(let i=lines.length-1;i>=0&&!d;i--) d=parse(lines[i]); }
    if(!d){ process.stdout.write(raw); process.exit(0); }
    if(d.result) process.stdout.write(d.result+"\n");
    if(typeof d.total_cost_usd==="number") fs.writeFileSync(process.argv[2], String(d.total_cost_usd));
  ' "$resp" "$resp.cost" 2>/dev/null || cat "$resp"

  if [ -s "$resp.cost" ]; then
    local cost; cost="$(cat "$resp.cost")"
    "$NODE_BIN" "$REPO/server/record.mjs" add-spend \
      "{\"started\":\"$started\",\"cost_usd\":$cost,\"outcome\":\"$([ $rc -eq 0 ] && echo ok || echo failed)\",\"detail\":\"$(printf '%s' "$detail" | sed 's/"/\\"/g')\"}" >/dev/null 2>&1 \
      && echo "spend recorded: \$$cost"
  else
    echo "spend NOT recorded — no cost returned (crash, timeout, or non-JSON response)"
  fi
  rm -f "$resp" "$resp.cost"
  return $rc
}

require_claude() {
  command -v claude >/dev/null 2>&1 && return 0
  echo "ERROR: 'claude' CLI not found on PATH — nothing can run without it."
  return 127
}
