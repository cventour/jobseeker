#!/usr/bin/env bash
# Step the daily run down when nobody is using what it produces, and turn it off if the whole
# system goes untouched.
# Windows twin: scripts/win/schedule-ladder.ps1 — change both together.
#
#   bash scripts/schedule-ladder.sh          evaluate and act (called at the end of every run)
#   bash scripts/schedule-ladder.sh --show   print the current tier and what happens next
#   bash scripts/schedule-ladder.sh --reset  back to daily, clock restarted (the dashboard's Restore)
#
# The ladder:
#   1  every day            -> 2 after 3 days with no roles reviewed
#   2  Mondays + Thursdays  -> 3 after 3 more
#   3  Mondays only         -> 4 only if NOTHING is touched for 14 days
#   4  not scheduled
#
# Two rules make this safe to run unattended:
#
#   * IT WARNS FIRST. A step is only taken on the run AFTER the one that warned, so there is always
#     a full cycle in which the dashboard says what is about to happen and how to stop it. A change
#     to someone's schedule that they discover afterwards is a change made behind their back.
#   * THE CLOCK STARTS WHEN THE LADDER IS ARMED, never from history. An install upgrading into this
#     feature has, by definition, never seen a warning — stepping it down on the first run for a
#     month of backdated silence would be punishing someone for evidence they were never shown.
#
# Recovery is deliberately NOT automatic: when reviewing resumes the dashboard offers a button.
# The decision to speed your machine back up is yours, in the same way the warning was.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

STATE="$REPO/data/.schedule-tier.json"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /opt/homebrew/bin/node)}"
# FAKE_TODAY pins the clock so the test suite can drive the ladder across dated scenarios.
TODAY="${FAKE_TODAY:-$(date '+%F')}"

# The cadence the USER chose, written by the wizard as `schedule_days` in the config file. Tier 1 is
# whatever that says — not "every day".
#
# Hardcoding daily here meant the ladder's own Restore button PROMOTED anyone who had asked for less:
# a twice-a-week user pressed "back to normal" and got seven runs a week they never asked for. A
# ladder is allowed to run things less often than you chose. It is not allowed to run them more.
baseline_days() {
  local v
  v="$("$NODE_BIN" -e '
    const fs=require("fs");
    try{
      const t=fs.readFileSync(process.argv[1],"utf8");
      /* [^\S\n] not \s: \s matches the newline, so an EMPTY value swallows the line break and
         captures whatever follows — which made a blank setting read as "---". */
      const m=/^schedule_days:[^\S\n]*(.*)$/m.exec(t);
      process.stdout.write(m ? m[1].trim() : "");
    }catch{ process.stdout.write(""); }' "$REPO/config/job-seeker.config.md" 2>/dev/null)"
  # "off" is printed through, not turned into an empty string: empty already means "every day" to
  # set-schedule.sh, and the two must not collide — an off baseline that read as every-day let the
  # ladder step an unscheduled install onto Mondays and Thursdays.
  case "$v" in
    off) printf 'off' ;;
    "")  printf '0,1,2,3,4,5,6' ;;
    *)   printf '%s' "$v" ;;
  esac
}

# Tier -> the day list scripts/set-schedule.sh understands. Tier 4 has none: it is removal.
#
# Tiers 2 and 3 are INTERSECTED with the baseline, so a step is always a reduction. Without that,
# stepping a Mondays-only user "down" to tier 2 would move them to Mondays AND Thursdays.
tier_days() {
  local base; base="$(baseline_days)"
  # Nothing to step down from. Every tier is "not scheduled".
  [ "$base" = "off" ] && { printf ''; return; }
  case "$1" in
    1) printf '%s' "$base" ;;
    2) intersect_days "$base" "1,4" ;;
    3) intersect_days "$base" "1" ;;
    *) printf '' ;;
  esac
}

# Days present in BOTH lists, in order. An empty baseline means every day, so everything survives.
intersect_days() { # base, tier
  local base="$1" want="$2" out="" d
  [ -n "$base" ] || { printf '%s' "$want"; return; }
  for d in $(printf '%s' "$want" | tr ',' ' '); do
    case ",$base," in *",$d,"*) out="${out:+$out,}$d" ;; esac
  done
  # An empty intersection means the tier has nothing left to cut — treat it as the last day of the
  # baseline rather than as "no schedule", which is tier 4's job and needs its own warning.
  [ -n "$out" ] || out="${base%%,*}"
  printf '%s' "$out"
}

days_label() { # day list -> words
  case "$1" in
    "")            echo "every day" ;;
    "0,1,2,3,4,5,6") echo "every day" ;;
    "1,2,3,4,5")   echo "weekdays" ;;
    "1,4")         echo "Mondays and Thursdays" ;;
    "1")           echo "Mondays only" ;;
    *)             echo "on days $1" ;;
  esac
}
tier_label() {
  case "$1" in
    1|2|3) [ "$(baseline_days)" = "off" ] && echo "not scheduled" || days_label "$(tier_days "$1")" ;;
    *) echo "not scheduled" ;;
  esac
}

# Keep the time the user chose. Re-scheduling must never quietly move the hour as well as the days.
current_time() {
  local shown; shown="$(bash "$REPO/scripts/set-schedule.sh" --show 2>/dev/null | head -1)"
  case "$shown" in
    [0-2][0-9]:[0-5][0-9]*) printf '%s' "${shown%% *}" ;;
    *) printf '08:00' ;;
  esac
}

write_state() { # tier, warned_at (may be empty), armed_on, why
  mkdir -p "$REPO/data"
  cat > "$STATE.tmp" <<JSON
{
  "tier": $1,
  "warned_at": $( [ -n "$2" ] && printf '"%s"' "$2" || printf 'null' ),
  "armed_on": "$3",
  "changed_at": "$TODAY",
  "why": "$(printf '%s' "$4" | sed 's/"/\\"/g')"
}
JSON
  mv "$STATE.tmp" "$STATE"
}

read_field() { # key
  [ -r "$STATE" ] || { printf ''; return; }
  "$NODE_BIN" -e '
    const fs=require("fs");
    try{ const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const v=d[process.argv[2]]; process.stdout.write(v==null?"":String(v)); }
    catch{ process.stdout.write(""); }' "$STATE" "$1" 2>/dev/null
}

# The verdict comes from server/audit.mjs, which owns the definition of "reviewed" and "active".
# This script decides only what to DO about it.
ladder_json() {
  "$NODE_BIN" "$REPO/server/audit.mjs" --gaps "$TODAY" 2>/dev/null \
    | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{ process.stdout.write(JSON.stringify(JSON.parse(s).schedule_ladder||{})); }
        catch{ process.stdout.write("{}"); }})' 2>/dev/null || printf '{}'
}
field() { # json, key
  printf '%s' "$1" | "$NODE_BIN" -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{ const v=JSON.parse(s)[process.argv[1]]; process.stdout.write(v==null?"":String(v)); }
      catch{ process.stdout.write(""); }})' "$2" 2>/dev/null
}

case "${1:-}" in
  --reset)
    TIME="$(current_time)"
    BASE="$(tier_days 1)"
    if [ -n "$BASE" ]; then
      bash "$REPO/scripts/set-schedule.sh" "$TIME" "$BASE" >/dev/null 2>&1
    else
      bash "$REPO/scripts/set-schedule.sh" "$TIME" >/dev/null 2>&1
    fi
    write_state 1 "" "$TODAY" "Restored to $(days_label "$BASE") by the user"
    "$NODE_BIN" "$REPO/server/record.mjs" log schedule-ladder "Schedule restored to $(days_label "$BASE") (user)" >/dev/null 2>&1
    echo "restored: $(days_label "$BASE") at $TIME"
    exit 0 ;;
  --show)
    L="$(ladder_json)"
    echo "tier $(field "$L" tier) — $(field "$L" schedule)"
    echo "last reviewed roles: $(field "$L" last_curation)  (dry days: $(field "$L" dry_days))"
    echo "last activity:       $(field "$L" last_activity)  (idle days: $(field "$L" idle_days))"
    echo "next action:         $(field "$L" action) $(field "$L" why)"
    exit 0 ;;
esac

# ---- arm on first sight, and do nothing else that day -----------------------------------------
ARMED="$(read_field armed_on)"
if [ -z "$ARMED" ]; then
  write_state 1 "" "$TODAY" "Ladder armed; the clock starts today, not from earlier history"
  echo "schedule ladder armed on $TODAY (no change; history before today is never counted)"
  exit 0
fi

L="$(ladder_json)"
ACTION="$(field "$L" action)"
TIER="$(field "$L" tier)"; [ -n "$TIER" ] || TIER=1
NEXT="$(field "$L" next_tier)"
WHY="$(field "$L" why)"

case "$ACTION" in
  warn)
    # Record only. The dashboard reads .schedule-tier.json and shows the banner; acting this run
    # would mean the user's first sight of the warning is also the day it took effect.
    write_state "$TIER" "$TODAY" "$ARMED" "$WHY"
    echo "schedule ladder: WARNING issued — $WHY Next run drops to $(tier_label "${NEXT:-$TIER}") unless roles are reviewed."
    "$NODE_BIN" "$REPO/server/record.mjs" log schedule-ladder \
      "Warned: schedule drops to $(tier_label "${NEXT:-$TIER}") next run — $WHY" >/dev/null 2>&1
    command -v osascript >/dev/null 2>&1 && osascript -e \
      "display notification \"$WHY Next run drops to $(tier_label "${NEXT:-$TIER}").\" with title \"JobSeeker is slowing down\"" >/dev/null 2>&1
    ;;
  step)
    TIME="$(current_time)"
    DAYS="$(tier_days "$NEXT")"
    if [ -z "$DAYS" ] || [ "$NEXT" -ge 4 ] 2>/dev/null; then
      bash "$REPO/scripts/set-schedule.sh" --remove >/dev/null 2>&1
    else
      bash "$REPO/scripts/set-schedule.sh" "$TIME" "$DAYS" >/dev/null 2>&1
    fi
    # warned_at cleared, so the NEXT step needs its own warning. Otherwise one quiet fortnight
    # could walk an install from daily to off without a second word.
    write_state "$NEXT" "" "$ARMED" "$WHY"
    echo "schedule ladder: now $(tier_label "$NEXT") — $WHY"
    "$NODE_BIN" "$REPO/server/record.mjs" log schedule-ladder \
      "Schedule changed to $(tier_label "$NEXT") — $WHY" >/dev/null 2>&1
    command -v osascript >/dev/null 2>&1 && osascript -e \
      "display notification \"Now running $(tier_label "$NEXT"). Change it in Settings.\" with title \"JobSeeker schedule changed\"" >/dev/null 2>&1
    ;;
  offer-restore)
    echo "schedule ladder: reviewing has resumed — the dashboard is offering to restore the daily run"
    ;;
  *)
    echo "schedule ladder: no change (tier $TIER, $(field "$L" dry_days) days since roles were reviewed)"
    ;;
esac
exit 0
