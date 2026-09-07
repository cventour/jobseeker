#!/bin/bash
# Build JobSeeker.app from installer/JobSeeker.js.
#
#   bash scripts/build-app.sh [destination-dir]     default: ~/Applications
#
# Everything used here ships with macOS -- osacompile, PlistBuddy, sips, iconutil, codesign -- so
# this runs on a machine with no developer tools, no Node and no Xcode. That is deliberate: the app
# is built ON the Mac it will run on, by install.sh, which is what makes it Gatekeeper-free. A
# bundle you compiled locally was never downloaded, so it carries no quarantine flag and macOS
# never asks anyone to override a security warning.
#
# osacompile ad-hoc signs its output for us. Renaming the executable below breaks that seal, so it
# is re-signed at the end -- ad-hoc again, which is all an unnotarised app can be.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/JobSeeker.app"
SRC="$REPO/installer/JobSeeker.js"
UI="$REPO/installer/ui.html"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; OFF=$'\033[0m'
[ -t 1 ] || { BOLD=""; DIM=""; RED=""; GRN=""; OFF=""; }
ok()  { printf "  ${GRN}ok${OFF}    %s\n" "$*"; }
bad() { printf "  ${RED}FAIL${OFF}  %s\n" "$*"; }

[ -f "$SRC" ] || { bad "missing $SRC"; exit 1; }
[ -f "$UI" ]  || { bad "missing $UI"; exit 1; }
mkdir -p "$DEST" || { bad "cannot create $DEST"; exit 1; }

# A running copy holds its own bundle open; replacing it underneath would produce an app that half
# works until the next launch.
#
# Signals, not AppleScript. The app's main loop never returns to the applet host, so it never
# answers an AppleEvent -- `tell application ... to quit` waits for a reply that cannot come and
# hangs this script forever. TERM reaches it regardless of what it is doing.
if pgrep -f "$APP/Contents/MacOS/JobSeeker" >/dev/null 2>&1; then
  pkill -TERM -f "$APP/Contents/MacOS/JobSeeker" >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$APP/Contents/MacOS/JobSeeker" >/dev/null 2>&1 || break
    sleep 0.3
  done
  pkill -KILL -f "$APP/Contents/MacOS/JobSeeker" >/dev/null 2>&1
fi

rm -rf "$APP"
if ! osacompile -l JavaScript -s -o "$APP" "$SRC" 2>&1 | sed 's/^/        /'; then
  bad "osacompile could not build the app"; exit 1
fi
ok "compiled $APP"

C="$APP/Contents"

# ---------------------------------------------------------------- identity
# Out of osacompile the bundle calls itself "applet": that is what the Dock, the menu bar and the
# force-quit list would show, and what a crash report would name.
mv "$C/MacOS/applet" "$C/MacOS/JobSeeker"
P="$C/Info.plist"
set_plist() { # key type value
  /usr/libexec/PlistBuddy -c "Set :$1 $3" "$P" >/dev/null 2>&1 ||
  /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$P" >/dev/null 2>&1
}
set_plist CFBundleExecutable   string  JobSeeker
set_plist CFBundleName         string  JobSeeker
set_plist CFBundleDisplayName  string  JobSeeker
set_plist CFBundleIdentifier   string  ai.myjobseeker.app
set_plist CFBundleIconFile     string  JobSeeker
set_plist NSHumanReadableCopyright string "JobSeeker"
VERSION="$(sed -n 's/^  *"version": *"\([^"]*\)".*/\1/p' "$REPO/package.json" | head -1)"
set_plist CFBundleShortVersionString string "${VERSION:-0.1.0}"
set_plist CFBundleVersion      string  "${VERSION:-0.1.0}"
# The setup window is the app's only window and it is not a document; without this the applet
# advertises itself as able to open dropped files.
/usr/libexec/PlistBuddy -c "Delete :CFBundleDocumentTypes" "$P" >/dev/null 2>&1
ok "identity set (ai.myjobseeker.app)"

# ---------------------------------------------------------------- resources
cp "$UI" "$C/Resources/ui.html"
# The welcome screen shows the real mark, so it has to travel with the page. Prefer the brand
# master: public/logo-128.webp is matted onto black, which reads as a black tile on the light
# scheme. The master has a transparent ground, so it sits on either background.
WELCOME_LOGO=""
for logo in "$REPO/assets/brand/jobseeker-master.webp" "$REPO/public/logo-128.webp" \
            "$REPO/public/logo.png"; do
  [ -f "$logo" ] && { WELCOME_LOGO="$logo"; break; }
done
if [ -n "$WELCOME_LOGO" ]; then
  sips -s format png -Z 320 "$WELCOME_LOGO" --out "$C/Resources/logo-128.png" >/dev/null 2>&1 \
    || cp "$WELCOME_LOGO" "$C/Resources/logo-128.png"
fi
# The one thing the app cannot work out for itself: which checkout it belongs to. Launched from the
# Dock it has no working directory, and there may be more than one copy of the repo on the Mac.
printf '%s' "$REPO" > "$C/Resources/repo-path.txt"
ok "bound to $REPO"

# ---------------------------------------------------------------- icon
# sips and iconutil are both stock, so the release icon is generated rather than committed as a
# binary blob nobody can diff.
# Biggest source first. The Dock asks for 512@2x = 1024px, so anything smaller than that gets
# upscaled: public/logo-mark.png is 256px, which is a 4x blow-up and looks soft next to every other
# icon in the Dock. assets/brand holds a real 1024 master -- sips reads .webp, so use it.
SRC_PNG=""
for c in "$REPO/assets/brand/jobseeker-master.webp" "$REPO/public/logo-mark.png" \
         "$REPO/public/logo.png" "$REPO/public/apple-touch-icon.png"; do
  [ -f "$c" ] || continue
  W="$(sips -g pixelWidth "$c" 2>/dev/null | awk '/pixelWidth/{print $2}')"
  [ -n "$W" ] || continue
  SRC_PNG="$c"; SRC_W="$W"
  [ "$W" -ge 1024 ] 2>/dev/null && break     # good enough; stop looking
done
if [ -n "$SRC_PNG" ]; then
  ICONSET="$(mktemp -d)/JobSeeker.iconset"
  mkdir -p "$ICONSET"
  # sips writes PNG regardless of the input container, so a .webp master needs no conversion step.
  # These ten files are exactly what iconutil expects; a missing one makes it refuse the whole set.
  for sz in 16 32 128 256 512; do
    sips -s format png -z $sz $sz "$SRC_PNG" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null 2>&1
    sips -s format png -z $((sz*2)) $((sz*2)) "$SRC_PNG" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1
  done
  if iconutil -c icns "$ICONSET" -o "$C/Resources/JobSeeker.icns" >/dev/null 2>&1; then
    rm -f "$C/Resources/applet.icns"
    if [ "${SRC_W:-0}" -lt 1024 ] 2>/dev/null; then
      ok "icon built from $(basename "$SRC_PNG") (${SRC_W}px — upscaled for the Dock)"
    else
      ok "icon built from $(basename "$SRC_PNG") (${SRC_W}px, all sizes to 1024)"
    fi
  else
    set_plist CFBundleIconFile string applet
    printf "  ${DIM}note  icon could not be built; using the default${OFF}\n"
  fi
  rm -rf "$(dirname "$ICONSET")"
else
  set_plist CFBundleIconFile string applet
fi

# ---------------------------------------------------------------- seal
# Renaming the executable invalidated osacompile's signature. Re-sign ad-hoc; there is no Developer
# ID here and that is the point -- see docs/INSTALL.md.
if codesign -f -s - --deep "$APP" >/dev/null 2>&1; then
  ok "ad-hoc signed"
else
  bad "could not sign the bundle"
fi

# LaunchServices caches bundles by path; without this the Dock can keep showing the old icon and
# the old name until logout.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" >/dev/null 2>&1
touch "$APP"

if [ -n "$(xattr -p com.apple.quarantine "$APP" 2>/dev/null)" ]; then
  bad "the built app is quarantined — it should not be; it was built locally"
else
  ok "not quarantined — opens with no security prompt"
fi

printf "\n  ${BOLD}%s${OFF}\n\n" "$APP"
