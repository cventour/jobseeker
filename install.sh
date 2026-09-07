#!/bin/bash
# JobSeeker installer.  curl -fsSL https://myjobseeker.ai/install.sh | bash
#
# Read this before you run it. It is short on purpose, and this is the file you are trusting.
#
# What it does:
#   1. Downloads the JobSeeker source from github.com/cventour/jobseeker into ~/JobSeeker
#   2. Builds JobSeeker.app from it, on this Mac, using tools macOS already has
#   3. Opens that app, which walks you through the rest in a window
#
# What it does NOT do:
#   * Ask for your password. It never runs anything as root. The app may later ask macOS for
#     permission to install Node, and macOS does that asking -- this script never sees a password.
#   * Install Node, Chrome or Claude Code. The app does that, after showing you what and from where.
#   * Touch anything outside ~/JobSeeker and ~/Applications.
#
# Why an install command and not a download:
#   macOS quarantines files downloaded by a BROWSER, and then refuses to open them until you go to
#   System Settings and override a security warning. Nothing here is downloaded by a browser, and
#   the app is compiled on your own Mac, so there is nothing to quarantine and no warning to
#   override. This is not a way around macOS security -- it is simply not the path that triggers it.
#
# Re-running this is safe. It updates in place and keeps your data.

set -uo pipefail

# Overridable so a fork, a release tag, or a local tarball can be installed the same way:
#   JOBSEEKER_URL=file:///path/to/src.tar.gz bash install.sh
REPO_URL="${JOBSEEKER_URL:-https://codeload.github.com/cventour/jobseeker/tar.gz/refs/heads/main}"
HOME_DIR="${JOBSEEKER_HOME:-$HOME/JobSeeker}"
APPS_DIR="${JOBSEEKER_APPS:-$HOME/Applications}"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; OFF=$'\033[0m'
[ -t 1 ] || { BOLD=""; DIM=""; RED=""; GRN=""; OFF=""; }
step() { printf "  ${DIM}→${OFF} %s\n" "$*"; }
ok()   { printf "  ${GRN}✓${OFF} %s\n" "$*"; }
die()  { printf "\n  ${RED}✗${OFF} %s\n\n" "$*" >&2; exit 1; }

printf "\n  ${BOLD}JobSeeker${OFF}\n\n"

# ---------------------------------------------------------------- 1. can this Mac run it?
[ "$(uname -s)" = "Darwin" ] || die "JobSeeker is macOS only (this is $(uname -s))."
command -v osacompile >/dev/null 2>&1 || die "osacompile is missing — that should not happen on macOS."
command -v curl >/dev/null 2>&1 || die "curl is missing — that should not happen on macOS."

# ---------------------------------------------------------------- 2. fetch the source
TMP="$(mktemp -d)" || die "could not create a temporary folder"
trap 'rm -rf "$TMP"' EXIT

step "Downloading JobSeeker"
curl -fsSL --max-time 300 "$REPO_URL" -o "$TMP/src.tar.gz" \
  || die "could not download JobSeeker. Check your internet connection and try again."
SIZE="$(stat -f%z "$TMP/src.tar.gz" 2>/dev/null || echo 0)"
[ "$SIZE" -gt 10000 ] 2>/dev/null || die "the download looks wrong (${SIZE} bytes)."
ok "downloaded $(( SIZE / 1024 )) KB"

step "Unpacking"
mkdir -p "$TMP/src"
tar xzf "$TMP/src.tar.gz" -C "$TMP/src" --strip-components=1 \
  || die "could not unpack the download."
[ -f "$TMP/src/server/dashboard.mjs" ] || die "the download is missing files it should have."

# ---------------------------------------------------------------- 3. install the source
# data/ and config/ are the user's, not ours. An update replaces code and leaves those alone --
# this is a job search someone may have been running for months.
if [ -d "$HOME_DIR" ]; then
  step "Updating the copy already in $HOME_DIR"
  for keep in data config templates; do
    [ -d "$HOME_DIR/$keep" ] && rm -rf "$TMP/src/$keep"
  done
  # Anything not preserved above is replaced wholesale, so a deleted file upstream really goes.
  ( cd "$TMP/src" && find . -type d -exec mkdir -p "$HOME_DIR/{}" \; ) 2>/dev/null
  ( cd "$TMP/src" && find . -type f -exec cp -f "{}" "$HOME_DIR/{}" \; ) 2>/dev/null
  ok "updated (your data and settings were left alone)"
else
  step "Installing to $HOME_DIR"
  mkdir -p "$(dirname "$HOME_DIR")"
  cp -R "$TMP/src" "$HOME_DIR" || die "could not write to $HOME_DIR"
  ok "installed to $HOME_DIR"
fi
chmod +x "$HOME_DIR"/scripts/*.sh 2>/dev/null

# ---------------------------------------------------------------- 4. build the app
step "Building JobSeeker.app"
if ! bash "$HOME_DIR/scripts/build-app.sh" "$APPS_DIR" >"$TMP/build.log" 2>&1; then
  sed 's/^/      /' "$TMP/build.log" >&2
  die "could not build the app. The output above says why."
fi
APP="$APPS_DIR/JobSeeker.app"
[ -d "$APP" ] || die "the app was not built."
ok "built $APP"

# The claim this whole approach rests on. Check it rather than assert it.
if [ -n "$(xattr -p com.apple.quarantine "$APP" 2>/dev/null)" ]; then
  die "the app came out quarantined, which should be impossible for a local build. Stopping rather
  than sending you to System Settings."
fi
ok "not quarantined — it will open without a security warning"

# ---------------------------------------------------------------- 5. hand over
step "Opening JobSeeker"
open "$APP" || die "could not open $APP"

printf "\n  ${BOLD}Setup has taken over in its own window.${OFF}\n"
printf "  ${DIM}You can close Terminal — JobSeeker does not need it.${OFF}\n\n"
printf "  ${DIM}Your files:  %s${OFF}\n" "$HOME_DIR"
printf "  ${DIM}The app:     %s${OFF}\n\n" "$APP"
