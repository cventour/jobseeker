#!/usr/bin/env bash
# Update a JobSeeker that is too old to update itself.
# Windows twin: scripts/win/update-now.ps1 — change both together.
#
#   bash update-now.sh              update the install this script can find
#   bash update-now.sh ~/JobSeeker  update a particular one
#   bash update-now.sh --check      say what would happen, change nothing
#
# It exists for the gap that only opens once. Self-updating arrived in v0.7.0, so every install
# older than that has no Update button and no scripts/self-update.sh to run — and the only advice
# left was "reinstall", which throws away data/, config/ and templates/ or forces someone to move
# them by hand. This is the bridge across that one version: it fetches the updater FROM the release
# and points it at the install that lacks it.
#
# It deliberately does NOT reimplement the update. Downloading, verifying, stopping the server,
# swapping the tree and walking back out of a failure are all difficult and all already written, in
# scripts/self-update.sh. Duplicating any of that here would mean two versions of the risky part,
# and the copy that ran on the oldest installs would be the one nobody ever tested again. So this
# script's whole job is: find the install, fetch the real updater, hand it over.
#
# Everything it uses ships with macOS: bash, curl, tar, and the node the install already needs.
set -uo pipefail

SLUG="${JOBSEEKER_REPO_SLUG:-cventour/jobseeker}"
CHECK=0
TARGET=""
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $a" >&2; exit 64 ;;
    *) TARGET="$a" ;;
  esac
done

die() { printf '\n%s\n' "$*" >&2; exit 1; }

# ---- find the install ---------------------------------------------------------------------------
# Same search as scripts/collect-logs.sh, for the same reason: the person running this was sent a
# file and told to run it, and "cd to the folder first" is the instruction that gets skipped.
find_repo() {
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for c in "${JOBSEEKER_HOME:-}" "$here/.." "$here" "$PWD" \
           "$HOME/JobSeeker" "$HOME/jobseeker" "$HOME/Documents/JobSeeker" \
           "$HOME/Applications/JobSeeker" "/Applications/JobSeeker.app/Contents/Resources/app"; do
    [ -n "$c" ] || continue
    if [ -f "$c/package.json" ] && [ -f "$c/server/dashboard.mjs" ]; then (cd "$c" && pwd); return 0; fi
  done
  local found
  found="$(mdfind -name dashboard.mjs 2>/dev/null | grep -m1 '/server/dashboard.mjs$')"
  [ -n "$found" ] && { dirname "$(dirname "$found")"; return 0; }
  return 1
}

if [ -n "$TARGET" ]; then
  [ -f "$TARGET/package.json" ] || die "No JobSeeker install at $TARGET"
  REPO="$(cd "$TARGET" && pwd)"
else
  REPO="$(find_repo)" || die "Could not find JobSeeker. Run this again with the folder:
  bash update-now.sh ~/JobSeeker"
fi

NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"
"$NODE_BIN" --version >/dev/null 2>&1 || die "Node is not installed. JobSeeker needs it — install it from https://nodejs.org and run this again."

HAVE="$("$NODE_BIN" -p "require('$REPO/package.json').version" 2>/dev/null || echo "")"
[ -n "$HAVE" ] || die "There is a folder at $REPO but its package.json cannot be read."

echo "JobSeeker at ${REPO/#$HOME/~}"
echo "installed:   $HAVE"

# ---- what is the newest release -------------------------------------------------------------
TAG="$(curl -fsSL --proto '=https' --tlsv1.2 --max-time 20 "https://api.github.com/repos/$SLUG/releases/latest" 2>/dev/null \
       | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$TAG" ] || die "Could not reach GitHub to find the newest version. Check the connection and try again."
echo "newest:      ${TAG#v}"

# Numeric compare — as text, 0.10.0 sorts below 0.9.0, and 0.10.0 is the release nobody would be
# offered. Same rule as compareVersions() in server/update.mjs.
newer() {
  "$NODE_BIN" -e '
    const p=(v)=>String(v||"").replace(/^v/,"").split(/[.\-+]/).map(x=>/^\d+$/.test(x)?Number(x):-1);
    const [a,b]=[p(process.argv[1]),p(process.argv[2])];
    for(let i=0;i<Math.max(a.length,b.length);i++){const x=a[i]??0,y=b[i]??0;if(x!==y)process.exit(x>y?0:1)}
    process.exit(1);' "$1" "$2"
}

if ! newer "$TAG" "$HAVE"; then
  echo ""
  echo "Already up to date. Nothing to do."
  exit 0
fi

if [ "$CHECK" = "1" ]; then
  echo ""
  echo "An update to ${TAG#v} is available. Run this again without --check to install it."
  exit 0
fi

# ---- hand over to the real updater --------------------------------------------------------------
# From the release, not from main: an install should only ever land on a version someone decided to
# publish. If the install already has its own updater, that one is used and this script is a no-op
# wrapper — which is the right outcome, because from v0.7.0 onwards the Update button in Settings
# does this without anyone running a script at all.
echo ""
if [ -f "$REPO/scripts/self-update.sh" ]; then
  echo "This install can already update itself — using its own updater."
  UPDATER="$REPO/scripts/self-update.sh"
  unset JOBSEEKER_REPO
else
  echo "Fetching the updater from $TAG…"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/jobseeker-bootstrap.XXXXXX")" || die "could not make a temp directory"
  trap 'rm -rf "$TMP"' EXIT
  URL="https://raw.githubusercontent.com/$SLUG/$TAG/scripts/self-update.sh"
  curl -fsSL --proto '=https' --tlsv1.2 --max-time 60 "$URL" -o "$TMP/self-update.sh" \
    || die "Could not download the updater from $URL"
  # It must be a shell script and it must be the one we asked for. A proxy or a captive portal that
  # answers every request with an HTML login page would otherwise be executed as bash.
  head -1 "$TMP/self-update.sh" | grep -q '^#!' || die "What came back from GitHub is not a script — check the connection and try again."
  grep -q 'JOBSEEKER_UPDATE_STAGE' "$TMP/self-update.sh" || die "The downloaded updater is not the one this script knows how to drive."
  chmod +x "$TMP/self-update.sh"
  UPDATER="$TMP/self-update.sh"
  export JOBSEEKER_REPO="$REPO"
fi

echo "Updating $HAVE → ${TAG#v}. Your CV, settings and tracker are left alone."
echo ""
/bin/bash "$UPDATER" "$TAG"
rc=$?

# self-update detaches and reports through data/.setup/update.json, so a zero here means "started
# cleanly", not "finished". Say that rather than implying more than was observed.
if [ $rc -ne 0 ]; then
  die "The updater exited $rc. See ${REPO/#$HOME/~}/data/.setup/update.log"
fi

echo "Update started. It takes a few seconds, and JobSeeker reopens itself when it is done."
echo "If anything goes wrong it is written to ${REPO/#$HOME/~}/data/.setup/update.log,"
echo "and the old version is put back."
