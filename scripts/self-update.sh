#!/bin/bash
# Replace this install with a newer release, and reopen it.
#
#   node scripts/run.mjs self-update v0.7.0     the dashboard's Update button
#   node scripts/run.mjs self-update --check    download and verify only, change nothing
#
# THE ORDER IS THE DESIGN. Everything that can plausibly fail -- no network, a moved tag, a
# truncated download, a version that needs a newer Node -- happens BEFORE anything is stopped or
# replaced. So the ordinary failure is reported to a dashboard that is still running, with the
# install untouched and nothing to undo.
#
# What is replaced, and what is not:
#   data/ config/ templates/ .claude/  are MIXED -- the user's files live beside the project's. Only
#                                      the paths the download actually contains are replaced inside
#                                      them, which is exactly the project's own files: .gitignore
#                                      guarantees nothing of the user's is ever in the archive.
#   .git node_modules .env* .data      are left alone entirely.
#   everything else                    is replaced wholesale, so a file deleted upstream really goes.
#
# The swap is renames, not copies, staged beside the install so every move is on one filesystem and
# therefore atomic. Each one is recorded, so a failure half way through walks back out.
#
# Twin: scripts/win/self-update.ps1. Change both.

set -uo pipefail

# ---------------------------------------------------------------- stage 1: get out of the tree
# Bash reads a script in chunks as it runs it. This script is inside the directory it is about to
# overwrite, so left where it is, it would be rewritten under its own file descriptor and the shell
# would execute whatever bytes landed at the offset it had reached. Copy out, exec from there, and
# never read another file from the install until the swap is finished.
if [ "${JOBSEEKER_UPDATE_STAGE:-}" != "2" ]; then
  # Normally the install is the one this script lives in. JOBSEEKER_REPO overrides that, which is
  # what lets a NEWER copy of this script update an OLDER install that never shipped one --
  # see scripts/update-now.sh. Without the override a downloaded copy would update the throwaway
  # directory it was downloaded into and report success.
  REPO="${JOBSEEKER_REPO:-$(cd "$(dirname "$0")/.." && pwd)}" || exit 1
  [ -f "$REPO/package.json" ] || { echo "no JobSeeker install at $REPO" >&2; exit 1; }
  TMPSELF="$(mktemp -d "${TMPDIR:-/tmp}/jobseeker-updater.XXXXXX")" || exit 1
  cp "$0" "$TMPSELF/self-update.sh" || exit 1
  export JOBSEEKER_UPDATE_STAGE=2 JOBSEEKER_REPO="$REPO" JOBSEEKER_UPDATER_TMP="$TMPSELF"
  cd / || exit 1
  exec /bin/bash "$TMPSELF/self-update.sh" "$@"
fi

REPO="$JOBSEEKER_REPO"
DATA="$REPO/data"
WORK="$DATA/.setup"
STATUS="$WORK/update.json"
LOG="$WORK/update.log"
BROKEN="$WORK/update.broken"
LOCK="$WORK/update.lock"
SLUG="${JOBSEEKER_REPO_SLUG:-cventour/jobseeker}"

mkdir -p "$WORK" 2>/dev/null

TAG=""
CHECK_ONLY=0
for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;;
    v*) TAG="$a" ;;
  esac
done

say() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG" 2>/dev/null; }

# Written at every phase change so the page has something to read, and so the NEXT launch can say
# what happened if this process dies without finishing. Atomic, because a half-written status file
# read by the dashboard is a crash in the dashboard.
FROM_V="$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo "")"
EXT_FROM="$(node -p "require('$REPO/extension/manifest.json').version" 2>/dev/null || echo "")"
status() { # phase, pct, [error]
  cat > "$STATUS.tmp" 2>/dev/null <<JSON
{
  "phase": "$1",
  "pct": ${2:-0},
  "from": "$FROM_V",
  "to": "${TAG#v}",
  "tag": "$TAG",
  "ok": $( [ "$1" = "done" ] && printf 'true' || printf 'false' ),
  "rolledBack": ${ROLLED_BACK:-false},
  "error": "$(printf '%s' "${3:-}" | sed 's/"/\\"/g' | tr -d '\n')",
  "extFrom": "$EXT_FROM",
  "updatedAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
JSON
  mv "$STATUS.tmp" "$STATUS" 2>/dev/null
}
ROLLED_BACK=false

die() { say "FAILED: $*"; status failed "${PCT:-0}" "$*"; exit 1; }
PCT=0

# ---------------------------------------------------------------- one at a time
if [ -e "$LOCK" ]; then
  OTHER="$(cat "$LOCK" 2>/dev/null)"
  if [ -n "$OTHER" ] && kill -0 "$OTHER" 2>/dev/null; then
    say "another update ($OTHER) is already running"
    exit 3
  fi
fi
printf '%s' "$$" > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

say "--- self-update ${TAG:-latest} (from ${FROM_V:-unknown}) ---"
status preparing 2

# ---------------------------------------------------------------- a developer's checkout
# Replacing the tree would throw away uncommitted work, and on the Windows twin it would delete the
# repository outright. Refuse, unless someone testing this has explicitly said otherwise.
if [ -e "$REPO/.git" ] && [ "${JOBSEEKER_UPDATE_FORCE:-}" != "1" ]; then
  say "refused: $REPO is a git checkout"
  status refused 0 "This copy is a git checkout — update it with git pull."
  exit 2
fi
[ -e "$REPO/.git" ] && say "WARNING: updating a git checkout because JOBSEEKER_UPDATE_FORCE=1"

# ---------------------------------------------------------------- which release
if [ -z "$TAG" ]; then
  say "asking github for the latest release"
  TAG="$(curl -fsSL --max-time 20 "https://api.github.com/repos/$SLUG/releases/latest" 2>/dev/null \
        | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
fi
# The tag becomes part of a URL and a path. Validate its SHAPE before it is used for anything,
# because it arrived over the network.
printf '%s' "$TAG" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$' || die "no usable release tag (got '${TAG:-nothing}')"
NEW_V="${TAG#v}"
say "target $TAG"

if [ -n "$FROM_V" ] && [ "$FROM_V" = "$NEW_V" ] && [ "${JOBSEEKER_UPDATE_FORCE:-}" != "1" ]; then
  die "already on $NEW_V"
fi

# ---------------------------------------------------------------- fetch and check, changing nothing
STAGE="$(mktemp -d "$(dirname "$REPO")/.jobseeker-update.XXXXXX")" || die "could not create a staging folder"
# $STAGE/old holds the ONLY copy of whatever has been moved out. While the swap is unfinished --
# which is exactly when this process is most likely to be killed -- deleting it would turn an
# interrupted update into an unrecoverable one.
cleanup() {
  rm -f "$LOCK"
  if [ -e "$BROKEN" ]; then
    say "leaving $STAGE in place: the swap did not finish"
  else
    rm -rf "$STAGE"
  fi
  rm -rf "$JOBSEEKER_UPDATER_TMP"
}
trap cleanup EXIT

PCT=15; status downloading 15
URL="${JOBSEEKER_URL:-https://codeload.github.com/$SLUG/tar.gz/refs/tags/$TAG}"
say "downloading $URL"
# https only for the real thing; a local archive (tests) is copied rather than fetched.
case "$URL" in
  file://*) cp "${URL#file://}" "$STAGE/src.tar.gz" 2>/dev/null || die "no archive at ${URL#file://}" ;;
  https://*) curl -fsSL --proto '=https' --tlsv1.2 --max-time 300 "$URL" -o "$STAGE/src.tar.gz" 2>/dev/null \
    || die "could not download $TAG — check your internet connection" ;;
  *) die "refusing to download over anything but https" ;;
esac

SIZE="$(stat -f%z "$STAGE/src.tar.gz" 2>/dev/null || stat -c%s "$STAGE/src.tar.gz" 2>/dev/null || echo 0)"
[ "$SIZE" -gt 50000 ] 2>/dev/null || die "the download looks wrong (${SIZE} bytes)"
say "downloaded $((SIZE / 1024)) KB"

PCT=30; status verifying 30
mkdir -p "$STAGE/src"
tar xzf "$STAGE/src.tar.gz" -C "$STAGE/src" --strip-components=1 2>/dev/null || die "could not unpack the download"

for must in server/dashboard.mjs package.json installer/JobSeeker.js installer/ui.html scripts public; do
  [ -e "$STAGE/src/$must" ] || die "the download is missing $must"
done
COUNT="$(find "$STAGE/src" -type f | wc -l | tr -d ' ')"
[ "$COUNT" -ge 120 ] 2>/dev/null || die "the download has only $COUNT files — it looks truncated"

GOT_V="$(node -p "require('$STAGE/src/package.json').version" 2>/dev/null || echo "")"
[ "$GOT_V" = "$NEW_V" ] || die "$TAG contains version ${GOT_V:-nothing}, not $NEW_V"
node --check "$STAGE/src/server/dashboard.mjs" 2>/dev/null || die "the new dashboard does not parse"

# Refusing here costs nothing. Discovering it after the swap leaves an install that will not start.
NEED="$(node -p "(require('$STAGE/src/package.json').engines||{}).node||''" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
HAVE="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [ -n "$NEED" ] && [ "$HAVE" -lt "$NEED" ] 2>/dev/null; then
  die "$TAG needs Node $NEED and this machine has $HAVE — run the installer instead"
fi
say "verified $TAG ($COUNT files)"

if [ "$CHECK_ONLY" = "1" ]; then
  say "--check: stopping before anything is changed"
  status checked 100
  exit 0
fi

# ---------------------------------------------------------------- stop what is running
PCT=45; status stopping 45
APP=""
for d in "${JOBSEEKER_APPS:-$HOME/Applications}" "$HOME/Applications" "/Applications"; do
  [ -f "$d/JobSeeker.app/Contents/Resources/repo-path.txt" ] || continue
  if [ "$(cat "$d/JobSeeker.app/Contents/Resources/repo-path.txt" 2>/dev/null)" = "$REPO" ]; then
    APP="$d/JobSeeker.app"; APPS_DIR="$d"; break
  fi
done
if [ -n "$APP" ]; then
  say "stopping $APP"
  pkill -TERM -f "$APP/Contents/MacOS/JobSeeker" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$APP/Contents/MacOS/JobSeeker" >/dev/null 2>&1 || break
    sleep 0.3
  done
  pkill -KILL -f "$APP/Contents/MacOS/JobSeeker" 2>/dev/null
else
  say "no app bundle points at this install; only the server will be stopped"
fi

# The app's watchdog takes the server with it, but not every install was started that way. Check the
# pid really is ours before signalling it -- pids get reused.
PIDF="$WORK/server.pid"
if [ -f "$PIDF" ]; then
  SPID="$(cat "$PIDF" 2>/dev/null)"
  if [ -n "$SPID" ] && kill -0 "$SPID" 2>/dev/null; then
    if ps -o command= -p "$SPID" 2>/dev/null | grep -q "$REPO/server/dashboard.mjs"; then
      say "stopping server $SPID"
      kill -TERM "$SPID" 2>/dev/null
      for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$SPID" 2>/dev/null || break; sleep 0.5; done
      kill -KILL "$SPID" 2>/dev/null
    fi
  fi
  rm -f "$PIDF"
fi

PORT="$(sed -n 's/^dashboard_port:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$REPO/config/job-seeker.config.md" 2>/dev/null | head -1)"
[ -n "$PORT" ] || PORT=4319
# "Still up" means OUR install is still answering. Another JobSeeker, or anything else, holding
# that port is not a reason to refuse — /_whoami names the root it is serving, which is the whole
# reason it exists.
ours_is_up() {
  curl -fsS --max-time 1 "http://127.0.0.1:$PORT/_whoami" 2>/dev/null | grep -q "\"root\":\"$REPO\""
}
for _ in 1 2 3 4 5 6 7 8 9 10; do
  ours_is_up || break
  sleep 1
done
if ours_is_up; then
  die "the dashboard is still answering on port $PORT — nothing was changed"
fi

# ---------------------------------------------------------------- the swap
PCT=60
touch "$BROKEN"
status swapping 60
OLD="$STAGE/old"
mkdir -p "$OLD"
MOVES="$STAGE/moves.txt"; : > "$MOVES"

KEEP_WHOLE=" .git node_modules .data .jobseeker.json .DS_Store "
KEEP_MIXED=" data config templates .claude "

record() { printf '%s\t%s\n' "$1" "$2" >> "$MOVES"; }
# macOS has `tail -r`, GNU has `tac`, and neither has both. Picking one INSIDE the pipeline is what
# matters: `tac f || tail -r f | while ...` binds the pipe to the fallback only, so on a machine
# that has tac the rollback would print the list and restore nothing.
reverse() { tail -r "$1" 2>/dev/null || tac "$1" 2>/dev/null; }
rollback() {
  say "rolling back"
  # Backwards, so a path moved out and then written over is restored in the right order.
  reverse "$MOVES" | while IFS="$(printf '\t')" read -r from to; do
    [ -n "$to" ] && [ -e "$to" ] && mv "$to" "$from" 2>/dev/null
  done
  ROLLED_BACK=true
  rm -f "$BROKEN"
}

swap_in() { # source entry, destination
  local src="$1" dst="$2"
  if [ -e "$dst" ]; then
    mkdir -p "$(dirname "$OLD/${dst#$REPO/}")" 2>/dev/null
    mv "$dst" "$OLD/${dst#$REPO/}" || return 1
    record "$dst" "$OLD/${dst#$REPO/}"
  fi
  mv "$src" "$dst" || return 1
  record "$src" "$dst"
  return 0
}

# What the archive holds at the top level, recorded BEFORE anything moves.
#
# This list has to be taken first. The move-in pass below moves entries OUT of $STAGE/src, so asking
# afterwards whether the archive contains a name answers "no" for every file just installed — and a
# deletion pass reading that would sweep the entire new version straight back out. (It did, once.)
ARCH="$STAGE/names.txt"; : > "$ARCH"
for entry in "$STAGE/src"/* "$STAGE/src"/.[!.]*; do
  [ -e "$entry" ] || continue
  basename "$entry" >> "$ARCH"
done

# Gone upstream: out first, while the list is still true.
for entry in "$REPO"/* "$REPO"/.[!.]*; do
  [ -e "$entry" ] || continue
  name="$(basename "$entry")"
  case "$KEEP_WHOLE$KEEP_MIXED" in *" $name "*) continue ;; esac
  grep -qxF "$name" "$ARCH" && continue
  mkdir -p "$(dirname "$OLD/$name")" 2>/dev/null
  mv "$entry" "$OLD/$name" 2>/dev/null && record "$entry" "$OLD/$name" && say "removed $name (gone upstream)"
done

# Then everything the archive carries.
for entry in "$STAGE/src"/* "$STAGE/src"/.[!.]*; do
  [ -e "$entry" ] || continue
  name="$(basename "$entry")"
  case "$KEEP_WHOLE$KEEP_MIXED" in *" $name "*) continue ;; esac
  swap_in "$entry" "$REPO/$name" || { rollback; die "could not replace $name"; }
done

# Mixed directories: replace only what the archive actually contains inside them. Everything the
# archive holds under data/ config/ templates/ .claude/ is the project's by construction -- .gitignore
# keeps the user's files out of it -- so this refreshes data/.example, the .example configs and the
# agent playbooks without ever touching a CV, a criteria file or someone's local Claude settings.
for k in data config templates .claude; do
  [ -d "$STAGE/src/$k" ] || continue
  mkdir -p "$REPO/$k" 2>/dev/null
  for entry in "$STAGE/src/$k"/* "$STAGE/src/$k"/.[!.]*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    swap_in "$entry" "$REPO/$k/$name" || { rollback; die "could not replace $k/$name"; }
  done
done

chmod +x "$REPO"/scripts/*.sh 2>/dev/null
rm -f "$BROKEN"
say "swapped in $TAG"

# ---------------------------------------------------------------- rebuild and reopen
if [ -n "$APP" ]; then
  PCT=75; status rebuilding 75
  say "rebuilding $APP"
  if ! bash "$REPO/scripts/build-app.sh" "$APPS_DIR" >>"$LOG" 2>&1; then
    rollback
    bash "$REPO/scripts/build-app.sh" "$APPS_DIR" >>"$LOG" 2>&1
    die "could not rebuild the app — put back $FROM_V"
  fi
fi

# Only if it is actually broken: the plist embeds this install's path, which has not changed, and
# bootout-then-bootstrap on a working agent risks uninstalling something that was fine.
if ! launchctl print "gui/$(id -u)/com.jobseeker.browser" >/dev/null 2>&1; then
  say "browser agent missing — reinstalling"
  bash "$REPO/scripts/install-browser-agent.sh" >>"$LOG" 2>&1
fi

PCT=90; status restarting 90
if [ -n "$APP" ] && [ "${JOBSEEKER_NO_LAUNCH:-}" != "1" ]; then
  say "reopening $APP"
  open "$APP" 2>/dev/null
fi

# The app reopening runs its own `start` step, which brings the dashboard back. Wait for it to say
# it is the new version -- that, not the absence of an error, is what "updated" means.
if [ "${JOBSEEKER_NO_LAUNCH:-}" != "1" ]; then
  for _ in $(seq 1 60); do
    OUT="$(curl -fsS --max-time 1 "http://127.0.0.1:$PORT/_whoami" 2>/dev/null)"
    case "$OUT" in *"\"version\":\"$NEW_V\""*) status done 100; say "updated to $NEW_V"; exit 0 ;; esac
    sleep 1
  done
  status failed 95 "updated to $NEW_V but the dashboard did not come back — open JobSeeker from your Applications folder"
  say "did not see the dashboard come back"
  exit 1
fi

status done 100
say "updated to $NEW_V (no relaunch: JOBSEEKER_NO_LAUNCH)"
exit 0
