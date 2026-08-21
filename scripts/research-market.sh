#!/usr/bin/env bash
# Research one market: find and rank vendors for it, filling data/markets/<slug>.md.
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

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

MARKET="${1:-}"
if [ -z "$MARKET" ]; then
  echo "usage: research-market.sh <market name>" >&2
  exit 64
fi

LOG="$REPO/data/.markets-run.log"
NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"

# Same reader as job-run.sh: config is the source of truth so the dashboard can change the caps.
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

BUDGET="$(read_cfg max_spend_per_run_usd)"; [ -n "$BUDGET" ] || BUDGET=5
MONTH_CAP="$(read_cfg max_spend_per_month_usd)"

{
  echo "==================== research-market '$MARKET' $(date '+%Y-%m-%d %H:%M:%S') ===================="

  if ! command -v claude >/dev/null 2>&1; then
    echo "ERROR: 'claude' CLI not found on PATH — cannot research a market without it."
    exit 127
  fi

  # Refuse BEFORE spending, exactly as the daily run does. A ceiling that only applies to the
  # scheduled path would be a ceiling with a hole in it.
  if [ -n "$MONTH_CAP" ]; then
    SPENT="$("$NODE_BIN" "$REPO/server/record.mjs" list-spend 2>/dev/null \
      | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          try{process.stdout.write(String(JSON.parse(s).month_total_usd||0))}catch{process.stdout.write("0")}})')"
    OVER="$("$NODE_BIN" -e 'process.stdout.write(Number(process.argv[1])>=Number(process.argv[2])?"1":"0")' "$SPENT" "$MONTH_CAP")"
    if [ "$OVER" = "1" ]; then
      echo "MONTHLY CEILING REACHED: \$$SPENT of \$$MONTH_CAP — not researching '$MARKET'."
      exit 0
    fi
  fi

  STARTED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  RESP="$(mktemp)"
  # stdout only — stderr into this file would break the JSON parse and lose the cost, which is
  # exactly how the daily run's ledger stayed empty for five runs.
  claude -p "/markets $MARKET" --max-budget-usd "$BUDGET" --output-format json > "$RESP"
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
  ' "$RESP" "$RESP.cost" 2>/dev/null || cat "$RESP"

  if [ -s "$RESP.cost" ]; then
    COST="$(cat "$RESP.cost")"
    "$NODE_BIN" "$REPO/server/record.mjs" add-spend \
      "{\"started\":\"$STARTED\",\"cost_usd\":$COST,\"outcome\":\"$([ $rc -eq 0 ] && echo ok || echo failed)\",\"detail\":\"market research: $MARKET\"}" >/dev/null 2>&1 \
      && echo "spend recorded: \$$COST"
  else
    echo "spend NOT recorded — no cost returned"
  fi
  rm -f "$RESP" "$RESP.cost"

  "$NODE_BIN" "$REPO/server/record.mjs" log markets \
    "Market research for '$MARKET' finished (exit $rc), started from the dashboard" >/dev/null 2>&1

  echo "==================== done $(date '+%Y-%m-%d %H:%M:%S') (exit $rc) ===================="
  exit $rc
} >> "$LOG" 2>&1
