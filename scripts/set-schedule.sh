#!/bin/bash
# Set (or remove) the time the daily run fires.
#
# This exists because the schedule had a TRAP in it. config/job-seeker.config.md carried a
# `schedule_job_run` cron expression, /onboard wrote it, and NOTHING READ IT -- the real schedule is
# StartCalendarInterval in the launchd plist. A user who set 09:00 still got 08:00, with no warning.
# A settings form would make that worse, because a form looks authoritative in a way a config
# comment does not. So there is now exactly one way to change the schedule, and it edits the plist.
#
#   scripts/set-schedule.sh 09:15           install / move the run, every day
#   scripts/set-schedule.sh 09:15 1,2,3,4,5  weekdays only (0 = Sunday … 6 = Saturday)
#   scripts/set-schedule.sh --remove         unschedule it
#   scripts/set-schedule.sh --show           print the schedule, read back from the plist
#
# Days are optional and default to every day. launchd expresses "these days at this time" as an
# ARRAY of StartCalendarInterval dicts, one per weekday — there is no day-list field — so a
# five-day schedule is five entries that differ only in Weekday.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.jobseeker.jobrun"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$REPO/scripts/$LABEL.plist.example"
UID_NUM="$(id -u)"

# Prints "HH:MM" for an every-day schedule, or "HH:MM 1,2,3,4,5" when it runs on named days —
# the same shape this script accepts as input, so what it prints can be fed straight back in.
# Reads BOTH plist shapes: the single dict written before days existed, and the array written now.
show() {
  if [ ! -f "$PLIST" ]; then echo "not scheduled"; return 0; fi
  local h m days
  h="$(plutil -extract StartCalendarInterval.Hour raw -o - "$PLIST" 2>/dev/null)"
  if [ -n "$h" ]; then
    m="$(plutil -extract StartCalendarInterval.Minute raw -o - "$PLIST" 2>/dev/null)"
    printf '%02d:%02d\n' "$h" "${m:-0}"
    return 0
  fi
  h="$(plutil -extract StartCalendarInterval.0.Hour raw -o - "$PLIST" 2>/dev/null)"
  [ -n "$h" ] || { echo "scheduled (no time found in plist)"; return 0; }
  m="$(plutil -extract StartCalendarInterval.0.Minute raw -o - "$PLIST" 2>/dev/null)"
  days=""
  local i=0 d
  while d="$(plutil -extract StartCalendarInterval.$i.Weekday raw -o - "$PLIST" 2>/dev/null)"; do
    [ -n "$d" ] || break
    days="${days:+$days,}$d"
    i=$((i + 1))
  done
  if [ -n "$days" ]; then printf '%02d:%02d %s\n' "$h" "${m:-0}" "$days"
  else printf '%02d:%02d\n' "$h" "${m:-0}"; fi
}

remove() {
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null
  rm -f "$PLIST"
  echo "unscheduled"
}

case "${1:---show}" in
  --show) show; exit 0 ;;
  --remove) remove; exit 0 ;;
esac

TIME="$1"
# Accept HH:MM only. This runs from a web request, so the input is not trusted: anything else could
# end up interpolated into a plist.
if ! printf '%s' "$TIME" | grep -qE '^([01][0-9]|2[0-3]):[0-5][0-9]$'; then
  echo "invalid time '$TIME' — expected HH:MM in 24-hour form, e.g. 09:15" >&2
  exit 64
fi
HOUR="${TIME%%:*}"; MIN="${TIME##*:}"
HOUR=$((10#$HOUR)); MIN=$((10#$MIN))

# Days: 0-6, comma separated, Sunday first — the same numbering launchd and JavaScript both use, so
# nothing has to be translated between the browser and the plist. Empty means every day, which is
# what every existing caller passes and what the old single-dict plist meant.
DAYS="${2:-}"
if [ -n "$DAYS" ]; then
  if ! printf '%s' "$DAYS" | grep -qE '^[0-6](,[0-6])*$'; then
    echo "invalid days '$DAYS' — expected digits 0-6 separated by commas, e.g. 1,2,3,4,5" >&2
    exit 64
  fi
  # Duplicates would install the same run twice on one day.
  DAYS="$(printf '%s' "$DAYS" | tr ',' '\n' | sort -u | paste -sd, -)"
  [ "$DAYS" = "0,1,2,3,4,5,6" ] && DAYS=""   # every day is the plain schedule, not seven entries
fi

[ -f "$TEMPLATE" ] || { echo "missing template: $TEMPLATE" >&2; exit 66; }
chmod +x "$REPO/scripts/job-run.sh" 2>/dev/null

# '#' as the sed delimiter: repo paths contain '/'.
TMP="$(mktemp)"
sed -e "s#__REPO__#$REPO#g" -e "s#__PATH__#$PATH#g" "$TEMPLATE" > "$TMP"

# Rewrite the hour and minute properly rather than with sed, so the plist stays valid XML.
if [ -z "$DAYS" ]; then
  plutil -replace StartCalendarInterval.Hour -integer "$HOUR" "$TMP" 2>/dev/null
  plutil -replace StartCalendarInterval.Minute -integer "$MIN" "$TMP" 2>/dev/null
else
  # Replace the template's single dict with one entry per chosen day. Built as JSON and handed to
  # plutil, rather than assembled as XML by hand: the days come from a web request, and a plist
  # built by string concatenation is a plist an input can break.
  ENTRIES=""
  for d in $(printf '%s' "$DAYS" | tr ',' ' '); do
    ENTRIES="${ENTRIES:+$ENTRIES,}{\"Hour\":$HOUR,\"Minute\":$MIN,\"Weekday\":$d}"
  done
  plutil -replace StartCalendarInterval -json "[$ENTRIES]" "$TMP" 2>/dev/null
fi

# Never load a malformed plist: a broken one silently fails to schedule anything.
if ! plutil -lint "$TMP" >/dev/null 2>&1; then
  echo "generated plist is malformed — not installed" >&2
  rm -f "$TMP"; exit 65
fi

mv "$TMP" "$PLIST"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null
if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
  echo "run scheduled for $(show)"
else
  echo "plist written but launchctl bootstrap failed — see docs/SCHEDULER.md" >&2
  exit 70
fi
