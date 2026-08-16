#!/bin/bash
# Set (or remove) the time the daily run fires.
#
# This exists because the schedule had a TRAP in it. config/job-seeker.config.md carried a
# `schedule_job_run` cron expression, /onboard wrote it, and NOTHING READ IT -- the real schedule is
# StartCalendarInterval in the launchd plist. A user who set 09:00 still got 08:00, with no warning.
# A settings form would make that worse, because a form looks authoritative in a way a config
# comment does not. So there is now exactly one way to change the schedule, and it edits the plist.
#
#   scripts/set-schedule.sh 09:15     install / move the daily run
#   scripts/set-schedule.sh --remove  unschedule it
#   scripts/set-schedule.sh --show    print the configured time, read back from the plist

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.jobseeker.jobrun"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$REPO/scripts/$LABEL.plist.example"
UID_NUM="$(id -u)"

show() {
  if [ ! -f "$PLIST" ]; then echo "not scheduled"; return 0; fi
  local h m
  h="$(plutil -extract StartCalendarInterval.Hour raw -o - "$PLIST" 2>/dev/null)"
  m="$(plutil -extract StartCalendarInterval.Minute raw -o - "$PLIST" 2>/dev/null)"
  [ -n "$h" ] || { echo "scheduled (no time found in plist)"; return 0; }
  printf '%02d:%02d\n' "$h" "${m:-0}"
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

[ -f "$TEMPLATE" ] || { echo "missing template: $TEMPLATE" >&2; exit 66; }
chmod +x "$REPO/scripts/job-run.sh" 2>/dev/null

# '#' as the sed delimiter: repo paths contain '/'.
TMP="$(mktemp)"
sed -e "s#__REPO__#$REPO#g" -e "s#__PATH__#$PATH#g" "$TEMPLATE" > "$TMP"

# Rewrite the hour and minute properly rather than with sed, so the plist stays valid XML.
plutil -replace StartCalendarInterval.Hour -integer "$HOUR" "$TMP" 2>/dev/null
plutil -replace StartCalendarInterval.Minute -integer "$MIN" "$TMP" 2>/dev/null

# Never load a malformed plist: a broken one silently fails to schedule anything.
if ! plutil -lint "$TMP" >/dev/null 2>&1; then
  echo "generated plist is malformed — not installed" >&2
  rm -f "$TMP"; exit 65
fi

mv "$TMP" "$PLIST"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null
if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
  echo "daily run scheduled for $(show)"
else
  echo "plist written but launchctl bootstrap failed — see docs/SCHEDULER.md" >&2
  exit 70
fi
