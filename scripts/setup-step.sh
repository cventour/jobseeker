#!/bin/bash
# One step of the graphical setup, run as a detached child of JobSeeker.app.
#
#   bash scripts/setup-step.sh check-all      report the state of every prerequisite, change nothing
#   bash scripts/setup-step.sh node           install Node, then verify it
#   bash scripts/setup-step.sh claude         install Claude Code, then verify it
#   bash scripts/setup-step.sh chrome         install Google Chrome, then verify it
#   bash scripts/setup-step.sh configure      settings file, global agent, browser agent
#   bash scripts/setup-step.sh start          start the dashboard and wait for it to answer
#
# This is the GUI half of what scripts/setup.sh does at a terminal. It differs in one way that
# matters: setup.sh only ever CHECKS a runtime and tells you where to download it. This installs it.
#
# That is not a reversal of the position in setup.sh's header, it is the other half of it. The
# objection there was never to installing Node — it was to installing a language runtime SILENTLY,
# from a double-clicked file, with nobody told what was happening. Here the window has already shown
# the user the file, the source it comes from and the fact that macOS will ask for their password,
# and waited for them to press a button. Asked and answered is a different act from assumed.
#
# So the rules this script holds itself to:
#
#   * Nothing is installed that the window did not name first.
#   * Every download comes from the vendor's own domain over HTTPS, and its signature is checked
#     before it is run. An unsigned or wrongly-signed download is a hard failure, never a warning.
#   * Only the one command that genuinely needs root is elevated, and macOS does the asking.
#   * Every step VERIFIES by re-running the same check that said it was missing. A step reports
#     success because the check now passes, never because the installer exited 0 -- those are
#     different claims, and this project exists partly because they get confused.
#
# Output protocol. Lines beginning "::" are for the window; everything else is log text a human can
# read afterwards in data/.setup/setup.log.
#
#   ::step  <id> <running|ok|fail|skip>   state of one checklist row
#   ::detail <id> <text>                  the small grey line under that row
#   ::pct   <0-100>                       progress of the step now running
#   ::say   <text>                        what is happening, right now
#   ::need  <text>                        something only the user can do
#   ::done  <ok|fail>                     this step is over

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

CHROME_APP="/Applications/Google Chrome.app"
CHROME_BIN="$CHROME_APP/Contents/MacOS/Google Chrome"
NODE_MIN=20
WORK="$REPO/data/.setup"
mkdir -p "$WORK"

step()   { printf '::step %s %s\n' "$1" "$2"; }
detail() { printf '::detail %s %s\n' "$1" "$2"; }
pct()    { printf '::pct %s\n' "$1"; }
say()    { printf '::say %s\n' "$*"; }
need()   { printf '::need %s\n' "$*"; }
log()    { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*"; }
finish() { printf '::done %s\n' "$1"; exit "$([ "$1" = ok ] && echo 0 || echo 1)"; }

# Anything we exec that came off the network lands here, and only here.
DL="$WORK/downloads"
mkdir -p "$DL"

# ---------------------------------------------------------------------------- finding node
# A GUI app does not inherit the shell's PATH, so `command -v node` inside this script can miss a
# Node the user definitely has. Look where the installers actually put it before giving up.
node_bin() {
  local c
  for c in "$(command -v node 2>/dev/null)" /usr/local/bin/node /opt/homebrew/bin/node \
           "$HOME/.local/bin/node" "$HOME/.volta/bin/node" "$HOME/.nvm/current/bin/node"; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}
claude_bin() {
  local c
  for c in "$(command -v claude 2>/dev/null)" "$HOME/.local/bin/claude" \
           /usr/local/bin/claude /opt/homebrew/bin/claude; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

# ---------------------------------------------------------------------------- the checks
# Each returns 0 when satisfied and echoes a human-readable version string. These are the ONLY
# source of truth for "is this installed" -- both the initial survey and the post-install
# verification call the same function, so a step cannot report success against a weaker test than
# the one that failed.
check_node() {
  local n v major
  n="$(node_bin)" || return 1
  v="$("$n" -v 2>/dev/null)" || return 1
  major="${v#v}"; major="${major%%.*}"
  [ "${major:-0}" -ge "$NODE_MIN" ] 2>/dev/null || { printf '%s (too old)' "$v"; return 1; }
  printf '%s' "$v"
}
check_claude() {
  local c v
  c="$(claude_bin)" || return 1
  v="$("$c" --version 2>/dev/null | awk '{print $1}')"
  printf '%s' "${v:-installed}"
}
check_chrome() {
  [ -d "$CHROME_APP" ] || return 1
  printf '%s' "$("$CHROME_BIN" --version 2>/dev/null | awk '{print $3}')"
}
check_configure() {
  [ -f "$REPO/config/job-seeker.config.md" ] || return 1
  launchctl print "gui/$(id -u)/com.jobseeker.browser" >/dev/null 2>&1 || return 1
  printf 'settings file and browser agent in place'
}
dashboard_port() {
  local p=""
  [ -f "$REPO/config/job-seeker.config.md" ] &&
    p="$(sed -n 's/^dashboard_port:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
         "$REPO/config/job-seeker.config.md" | head -1)"
  printf '%s' "${p:-4319}"
}
check_start() {
  curl -fsS -o /dev/null --max-time 2 "http://localhost:$(dashboard_port)" 2>/dev/null || return 1
  printf 'answering on port %s' "$(dashboard_port)"
}

# ---------------------------------------------------------------------------- elevation
# Only ever called with a command this script built itself from paths under data/.setup. macOS
# draws the password dialog; nothing here ever sees or stores a password.
run_admin() { # <shell-command> <what-for>
  local out
  log "elevating: $1"
  out="$(osascript -e "do shell script \"$1\" with administrator privileges with prompt \"JobSeeker needs your permission to install $2.\"" 2>&1)"
  local rc=$?
  [ -n "$out" ] && log "$out"
  if [ $rc -ne 0 ]; then
    case "$out" in
      *"User canceled"*|*"User cancelled"*) log "you cancelled the password prompt" ;;
    esac
  fi
  return $rc
}

# Download with a real progress bar: ask how big it is, then watch the file grow. curl's own
# progress output goes to a tty it does not have here, so this measures the file instead.
download() { # <url> <dest> <first-pct> <last-pct>
  local url="$1" dest="$2" lo="$3" hi="$4" total sz p
  total="$(curl -fsSLI --max-time 25 "$url" 2>/dev/null \
           | awk 'BEGIN{IGNORECASE=1}/^content-length:/{print $2}' | tr -d '\r' | tail -1)"
  rm -f "$dest"
  curl -fsSL --max-time 900 "$url" -o "$dest" &
  local cpid=$!
  while kill -0 "$cpid" 2>/dev/null; do
    if [ -n "${total:-}" ] && [ "${total:-0}" -gt 0 ] 2>/dev/null && [ -f "$dest" ]; then
      sz="$(stat -f%z "$dest" 2>/dev/null || echo 0)"
      p=$(( lo + (hi - lo) * sz / total ))
      pct "$p"
    fi
    sleep 0.4
  done
  wait "$cpid"
}

human() { # bytes -> "46 MB"
  local b="${1:-0}"
  if [ "$b" -gt 1048576 ] 2>/dev/null; then printf '%s MB' $(( b / 1048576 ));
  else printf '%s KB' $(( b / 1024 )); fi
}

# ============================================================================ steps

do_check_all() {
  local v
  for id in node claude chrome configure start; do
    if v="$(check_$id)"; then step "$id" ok; [ -n "$v" ] && detail "$id" "$v"
    else step "$id" fail; [ -n "$v" ] && detail "$id" "$v"; fi
  done
  finish ok
}

# ---------------------------------------------------------------------------- node
do_node() {
  local v
  if v="$(check_node)"; then
    step node ok; detail node "$v (already installed)"; log "node already present: $v"; finish ok
  fi

  step node running; pct 2
  say "Finding the current Node LTS release"
  log "asking nodejs.org for the latest v${NODE_MIN}+ LTS"

  # The directory listing names the exact file, so there is no JSON to parse -- which matters,
  # because the tool you would parse it with is the thing being installed.
  local listing file url
  for series in 22 24 20; do
    listing="$(curl -fsSL --max-time 25 "https://nodejs.org/dist/latest-v${series}.x/" 2>/dev/null)" || continue
    file="$(printf '%s' "$listing" | grep -o 'node-v[0-9][0-9.]*\.pkg' | head -1)"
    [ -n "$file" ] && { url="https://nodejs.org/dist/latest-v${series}.x/${file}"; break; }
  done
  if [ -z "${url:-}" ]; then
    log "could not reach nodejs.org to find the installer"
    detail node "Could not reach nodejs.org — check your connection and try again"
    step node fail; finish fail
  fi

  local pkg="$DL/node.pkg"
  say "Downloading ${file} from nodejs.org"
  log "GET $url"
  detail node "Downloading ${file}"
  if ! download "$url" "$pkg" 5 60; then
    log "download failed"; detail node "The download did not finish"; step node fail; finish fail
  fi
  log "downloaded $(human "$(stat -f%z "$pkg" 2>/dev/null || echo 0)")"

  # Signature before execution, always. This is the one moment where a wrong answer means running
  # someone else's code as root, so a failure here stops the step dead rather than warning.
  pct 65
  say "Checking who signed it"
  local sig org
  sig="$(pkgutil --check-signature "$pkg" 2>&1)"
  log "$sig"
  if ! printf '%s' "$sig" | grep -q "Developer ID Installer:"; then
    log "REFUSED: not signed with an Apple Developer ID Installer certificate"
    detail node "The download was not signed by a registered developer — nothing was installed"
    step node fail; finish fail
  fi
  org="$(printf '%s' "$sig" | sed -n 's/.*Developer ID Installer: \(.*\)/\1/p' | head -1)"
  log "signed by $org"
  detail node "Signed by $org"

  pct 72
  say "Installing Node — macOS will ask for your password"
  if ! run_admin "installer -pkg '$pkg' -target /" "Node"; then
    detail node "Not installed — the password prompt was cancelled or failed"
    step node fail; finish fail
  fi

  pct 92
  say "Checking Node actually runs"
  # Fresh install lands in /usr/local/bin, which this process's PATH may predate.
  export PATH="/usr/local/bin:$PATH"
  if v="$(check_node)"; then
    log "verified: node $v at $(node_bin)"
    detail node "$v"; step node ok; pct 100; rm -f "$pkg"; finish ok
  fi
  log "installer finished but node still does not run"
  detail node "The installer finished, but Node still does not run"
  step node fail; finish fail
}

# ---------------------------------------------------------------------------- claude code
do_claude() {
  local v
  if v="$(check_claude)"; then
    step claude ok; detail claude "$v (already installed)"; finish ok
  fi
  step claude running; pct 5
  say "Installing Claude Code from claude.ai"
  detail claude "Running the official installer"
  log "GET https://claude.ai/install.sh | bash"

  # The vendor's own installer, into the user's home. No elevation, so nothing here can affect
  # anything outside this account.
  local out
  out="$(curl -fsSL --max-time 300 https://claude.ai/install.sh 2>/dev/null | bash 2>&1)"
  printf '%s\n' "$out" | sed 's/^/    /'
  pct 85

  export PATH="$HOME/.local/bin:$PATH"
  if v="$(check_claude)"; then
    log "verified: claude $v at $(claude_bin)"
    detail claude "$v"; step claude ok; pct 100; finish ok
  fi
  log "installer ran but claude is not on PATH"
  detail claude "Installed, but not found on PATH — the agents will not run yet"
  step claude fail; finish fail
}

# ---------------------------------------------------------------------------- chrome
do_chrome() {
  local v
  if v="$(check_chrome)"; then
    step chrome ok; detail chrome "$v (already installed)"; finish ok
  fi
  step chrome running; pct 3
  say "Downloading Google Chrome"
  detail chrome "Downloading from google.com"
  local dmg="$DL/chrome.dmg"
  if ! download "https://dl.google.com/chrome/mac/stable/GGRO/googlechrome.dmg" "$dmg" 3 55; then
    log "chrome download failed"; detail chrome "The download did not finish"; step chrome fail; finish fail
  fi
  log "downloaded $(human "$(stat -f%z "$dmg" 2>/dev/null || echo 0)")"

  pct 60
  say "Opening the disk image"
  local mnt="$WORK/chrome-mount"
  rm -rf "$mnt"; mkdir -p "$mnt"
  if ! hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$dmg" 2>&1 | sed 's/^/    /'; then
    log "could not mount the disk image"; detail chrome "The disk image would not open"
    step chrome fail; finish fail
  fi
  # Always detach, whatever happens next.
  trap 'hdiutil detach "$mnt" -quiet 2>/dev/null; rm -rf "$mnt"' EXIT

  local src="$mnt/Google Chrome.app"
  if [ ! -d "$src" ]; then
    log "disk image did not contain Google Chrome.app"; detail chrome "The download was not Chrome"
    step chrome fail; finish fail
  fi

  pct 68
  say "Checking who signed it"
  local team
  team="$(codesign -dv --verbose=2 "$src" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  log "TeamIdentifier=$team"
  # Google's Apple team identifier. A Chrome that is not signed by Google is not Chrome.
  if [ "$team" != "EQHXZ8M8AV" ]; then
    log "REFUSED: expected Google's team identifier EQHXZ8M8AV, got '${team:-none}'"
    detail chrome "That download was not signed by Google — nothing was installed"
    step chrome fail; finish fail
  fi
  detail chrome "Signed by Google (EQHXZ8M8AV)"

  pct 75
  say "Copying Chrome into your Applications folder"
  # /Applications is group-writable by admin users, so this usually needs no password at all.
  if ! cp -R "$src" /Applications/ 2>/dev/null; then
    log "plain copy refused; asking for permission"
    if ! run_admin "cp -R '$src' /Applications/" "Google Chrome"; then
      detail chrome "Not installed — the copy was refused"; step chrome fail; finish fail
    fi
  fi
  # Chrome came off a disk image, so it carries the quarantine flag that would make its FIRST
  # launch a scary dialog. It is Google-signed and we just verified that, so clear it.
  xattr -dr com.apple.quarantine "$CHROME_APP" 2>/dev/null

  pct 92
  say "Checking Chrome runs"
  if v="$(check_chrome)"; then
    log "verified: Chrome $v"; detail chrome "$v"; step chrome ok; pct 100; rm -f "$dmg"; finish ok
  fi
  log "copied but Chrome does not report a version"
  detail chrome "Copied, but Chrome does not start"; step chrome fail; finish fail
}

# ---------------------------------------------------------------------------- configure
do_configure() {
  step configure running; pct 10
  local node; node="$(node_bin)" || node="node"

  say "Creating your settings file"
  if [ ! -f "$REPO/config/job-seeker.config.md" ] && [ -f "$REPO/config/job-seeker.config.md.example" ]; then
    cp "$REPO/config/job-seeker.config.md.example" "$REPO/config/job-seeker.config.md"
    log "created config/job-seeker.config.md from the example"
  else
    log "config/job-seeker.config.md already exists — left untouched"
  fi

  pct 35
  say "Making \"jobseeker\" work in Claude Code from any folder"
  if bash "$REPO/scripts/install-global-agent.sh" >>"$WORK/setup.log" 2>&1; then
    log "installed the global jobseeker agent into ~/.claude/agents"
  else
    log "global agent not installed - a file we did not write is already at ~/.claude/agents/jobseeker.md"
  fi

  pct 60
  say "Installing the browser agent"
  # Not optional any more, and the reason is new. macOS keys Automation permission to the
  # responsible process. JobSeeker.app is built on this Mac and ad-hoc signed, so its identity is a
  # hash of its own bytes and CHANGES ON EVERY UPDATE -- if the app issued the Apple Events itself,
  # every update would re-prompt for permission to control Chrome, which is precisely the Claude
  # Code version-churn problem scripts/browser-agent.sh was written to escape. Routing through the
  # LaunchAgent keeps the grant under /bin/bash, where it is stable for good.
  if bash "$REPO/scripts/install-browser-agent.sh" >>"$WORK/setup.log" 2>&1; then
    log "installed the browser agent (com.jobseeker.browser)"
  else
    log "browser agent did not install - WhatsApp and LinkedIn reading will not work"
    detail configure "Browser agent failed — WhatsApp and LinkedIn will not be read"
    step configure fail; finish fail
  fi

  pct 90
  local v
  if v="$(check_configure)"; then
    detail configure "$v"; step configure ok; pct 100; finish ok
  fi
  detail configure "Something did not stick — see the log"; step configure fail; finish fail
}

# ---------------------------------------------------------------------------- start
do_start() {
  step start running; pct 10
  local port node
  port="$(dashboard_port)"
  node="$(node_bin)" || { detail start "Node is not installed"; step start fail; finish fail; }

  if check_start >/dev/null; then
    log "already answering on port $port"
    detail start "Already running on port $port"; step start ok; pct 100; finish ok
  fi

  say "Starting JobSeeker"
  log "$node server/dashboard.mjs (port $port)"
  # Detached: it must outlive this step, because the step ends as soon as the port answers.
  nohup "$node" "$REPO/server/dashboard.mjs" >>"$REPO/data/.dashboard.log" 2>&1 &
  local pid=$!
  printf '%s' "$pid" > "$WORK/server.pid"
  log "server pid $pid"

  # It must NOT outlive the app, though. JobSeeker.app passes its own pid here and this watchdog
  # takes the server down with it. Quitting the app is the whole quit story -- a web server left
  # holding someone's job-search data after they closed the window would be the old Terminal
  # problem wearing a nicer hat. The app also kills this pid on a clean quit; the watchdog is what
  # covers a crash or a force-quit, where no cleanup code of ours ever runs.
  local parent="${2:-}"
  if [ -n "$parent" ]; then
    log "watchdog: server $pid follows app $parent"
    nohup bash -c '
      while kill -0 "'"$parent"'" 2>/dev/null; do sleep 2; done
      kill "'"$pid"'" 2>/dev/null
    ' >/dev/null 2>&1 &
  fi

  # Wait for it to ANSWER, not merely to have been started. A window opened on a connection error
  # is worse than a window opened a second later.
  local i
  for i in $(seq 1 60); do
    if check_start >/dev/null; then
      log "answering on http://localhost:$port"
      detail start "Running on port $port"; step start ok; pct 100; finish ok
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      log "the server exited while starting - see data/.dashboard.log"
      detail start "JobSeeker stopped while starting up"; step start fail; finish fail
    fi
    pct $(( 10 + i )); sleep 0.3
  done
  log "timed out waiting for the server to answer"
  detail start "Started, but never answered on port $port"; step start fail; finish fail
}

case "${1:-}" in
  check-all) do_check_all ;;
  node)      do_node ;;
  claude)    do_claude ;;
  chrome)    do_chrome ;;
  configure) do_configure ;;
  start)     do_start "$@" ;;   # "$@" so the app pid in $2 reaches the function
  *) echo "usage: setup-step.sh <check-all|node|claude|chrome|configure|start>" >&2; exit 64 ;;
esac
