#!/bin/bash
# Stop this install's dashboard server.
#
#   node scripts/run.mjs stop
#
# On a Mac the app normally owns the server's life: quitting JobSeeker kills it, and the watchdog in
# scripts/setup-step.sh covers a crash. Both of those depend on the server having been started BY
# the app, and one thing has to work whether it was or not -- self-update, which cannot replace the
# code while the old code is still answering. That is what this script is for.
#
# The care taken below is about TWO failures, and they pull in opposite directions:
#
#   * A pid file outlives the process it names, the kernel hands that number to something else, and
#     stopping JobSeeker kills a stranger. So a pid is never trusted on its own -- it is only
#     signalled once the process it points at turns out to be a node running THIS repo's
#     server/dashboard.mjs.
#   * A dashboard started any other way -- `npm run dashboard`, a terminal, an older build, an app
#     instance that has since gone -- has no pid file at all, or a stale one. Trusting only the pid
#     file is how an update reached "the dashboard is still answering on port 4319" with a server it
#     had never once signalled. So when the pid file is unusable, the same test is run over every
#     process instead, which finds the dashboard however it was started.
#
# Exit 0 when nothing of ours is left running (including when nothing was). Exit 1 when a dashboard
# is up and would not go.
#
# Twin: scripts/win/stop.ps1. Change both.

set -uo pipefail

# JOBSEEKER_REPO lets a copy of this script running from somewhere else act on a named install --
# scripts/self-update.sh runs from a temp directory by design.
REPO="${JOBSEEKER_REPO:-$(cd "$(dirname "$0")/.." && pwd)}" || exit 1
PIDF="$REPO/data/.setup/server.pid"
TARGET="$REPO/server/dashboard.mjs"
# …and the same path with every symlink resolved. On a Mac /var IS /private/var, and an install
# reached through any symlinked parent has TWO true spellings: the one it was started with, on the
# server's command line, and the one this script was handed. Comparing only one of them is how a
# running dashboard looks like no dashboard at all.
REPO_REAL="$(cd "$REPO" 2>/dev/null && pwd -P)" || REPO_REAL="$REPO"
TARGET_REAL="$REPO_REAL/server/dashboard.mjs"

# The command line of one pid, or nothing at all if there is no such process.
proc_cmd() { ps -o command= -p "$1" 2>/dev/null | head -1; }

# Is this command line a node running OUR dashboard?
#
# Both halves matter. Without the path it would match another install's dashboard; without the
# executable check, `bash -c "... server/dashboard.mjs ..."`, an editor holding the file open or
# this script's own ancestry could all be mistaken for the server.
is_ours() {
  local cmd="$1" exe
  [ -n "$cmd" ] || return 1
  case "$cmd" in
    *"$TARGET"*) ;;
    *"$TARGET_REAL"*) ;;
    *) return 1 ;;
  esac
  exe="$(basename "${cmd%% *}")"
  case "$exe" in node|node.exe) return 0 ;; *) return 1 ;; esac
}

# Every pid whose process is this repo's dashboard, newest last. This is what catches a server
# started by an older build or by hand.
find_dashboards() {
  ps -A -o pid=,command= 2>/dev/null | while read -r p rest; do
    [ -n "$p" ] || continue
    [ "$p" = "$$" ] && continue
    is_ours "$rest" && printf '%s\n' "$p"
  done
}

# TERM, then KILL if it is still there. server/dashboard.mjs installs no signal handler, so TERM is
# already immediate; the wait and the KILL are for a process wedged in a syscall, not for a graceful
# shutdown that does not exist.
stop_one() {
  local p="$1"
  kill -TERM "$p" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$p" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -KILL "$p" 2>/dev/null
  for _ in 1 2 3 4; do
    kill -0 "$p" 2>/dev/null || return 0
    sleep 0.5
  done
  echo "could not stop JobSeeker (pid $p)" >&2
  return 1
}

STOPPED=""
SAID=0   # whether the pid-file branch already explained itself

if [ -f "$PIDF" ]; then
  RAW="$(tr -dc '0-9' < "$PIDF" 2>/dev/null)"
  if [ -n "$RAW" ]; then
    CMD="$(proc_cmd "$RAW")"
    if [ -z "$CMD" ]; then
      echo "JobSeeker was not running (the recorded process $RAW is gone)."
      SAID=1
    elif ! is_ours "$CMD"; then
      # The pid was reused. Leave whatever owns that number now completely alone.
      echo "JobSeeker was not running (process $RAW belongs to something else now)."
      SAID=1
    elif stop_one "$RAW"; then
      STOPPED="$RAW"
    fi
  else
    echo "The recorded process id is unreadable; looking for JobSeeker by hand."
  fi
  rm -f "$PIDF"
fi

# Always sweep, even after the pid file's process was stopped: only one dashboard can hold the port,
# but a second one that lost the race and stayed up is exactly the kind of leftover that makes the
# next update fail. (The Windows twin returns here; the sweep is cheap and the guarantee is better.)
FOUND="$(find_dashboards)"
if [ -z "$FOUND" ]; then
  if [ -n "$STOPPED" ]; then
    echo "Stopped JobSeeker (pid $STOPPED)."
  elif [ "$SAID" = "0" ]; then
    echo "JobSeeker was not running."
  fi
  exit 0
fi

LEFT=0
for p in $FOUND; do
  if stop_one "$p"; then
    STOPPED="${STOPPED:+$STOPPED, }$p"
  else
    LEFT=1
  fi
done

if [ "$LEFT" = "1" ]; then
  echo "JobSeeker is running but could not be stopped."
  exit 1
fi
echo "Stopped JobSeeker (pid $STOPPED)."
exit 0
