#!/bin/bash
# One step of the graphical setup, run as a detached child of JobSeeker.app.
# Windows twin: scripts/win/setup-step.ps1 — change both together.
#
#   bash scripts/setup-step.sh check-all      report the state of every prerequisite, change nothing
#   bash scripts/setup-step.sh node           install Node, then verify it
#   bash scripts/setup-step.sh claude         install Claude Code, then verify it
#   bash scripts/setup-step.sh chrome         install Google Chrome, then verify it
#   bash scripts/setup-step.sh configure      settings file, global agent, browser agent
#   bash scripts/setup-step.sh start          start the dashboard and wait for it to answer
#   bash scripts/setup-step.sh whatsapp <num> install the WhatsApp plugin and pair a phone
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
#   ::code  <XXXX-XXXX>                   a WhatsApp pairing code, to show large
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
wa_number() {
  [ -f "$WA_DIR/.env" ] || return 1
  sed -n 's/^WHATSAPP_PHONE_NUMBER=//p' "$WA_DIR/.env" | head -1
}
check_whatsapp() {
  wa_paired || return 1
  local n; n="$(wa_number 2>/dev/null)"
  if [ -n "$n" ]; then printf 'connected as +%s' "$n"; else printf 'connected'; fi
}
# Whether OUR JobSeeker is answering -- not merely whether something is. A dashboard left running
# from a different checkout answers a plain request exactly the same way, and handing the window
# over to it shows the user another build entirely, which reads as "the update did nothing".
check_start() {
  local port who
  port="$(dashboard_port)"
  who="$(curl -fsS --max-time 2 "http://localhost:$port/_whoami" 2>/dev/null)"
  if [ -z "$who" ]; then
    # Nothing there, or something too old to answer. Either way it is not a JobSeeker we can claim.
    curl -fsS -o /dev/null --max-time 2 "http://localhost:$port" 2>/dev/null || return 1
    printf 'something else is using port %s' "$port"
    return 1
  fi
  case "$who" in
    *"\"root\":\"$REPO\""*) printf 'answering on port %s' "$port" ;;
    *) printf 'a different JobSeeker is using port %s' "$port"; return 1 ;;
  esac
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
  for id in node claude chrome configure start whatsapp; do
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

  # If the port is taken by another JobSeeker, ours cannot bind and the failure would read as
  # "JobSeeker stopped while starting up". Name the real problem instead.
  if curl -fsS -o /dev/null --max-time 2 "http://localhost:$port" 2>/dev/null; then
    local other; other="$(curl -fsS --max-time 2 "http://localhost:$port/_whoami" 2>/dev/null \
                          | sed -n 's/.*"root":"\([^"]*\)".*/\1/p')"
    log "port $port is already in use by ${other:-an unknown server}"
    if [ -n "$other" ]; then
      detail start "Another JobSeeker is running from $other — quit it first."
    else
      detail start "Something else is already using port $port."
    fi
    step start fail; finish fail
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


# ---------------------------------------------------------------------------- whatsapp
# Everything here is OPTIONAL and only runs if the user asks for it on the WhatsApp screen.
#
# The plugin is a third party's (Rich627/whatsapp-claude-plugin) and JobSeeker neither ships nor
# maintains it, so this installs it by name, from its own marketplace, and the window links to the
# author's page. It also needs bun -- the plugin's MCP server is launched with `bun run`, not node
# -- which is why bun is installed here rather than as a JobSeeker prerequisite: nobody who skips
# WhatsApp should be made to install a second runtime.
# Overridable so this step can be exercised against a scratch directory without going near a
# real, working WhatsApp link.
WA_DIR="${JOBSEEKER_WA_DIR:-$HOME/.whatsapp-channel}"
WA_PLUGIN_REPO="Rich627/whatsapp-claude-plugin"
WA_MARKETPLACE="whatsapp-claude-plugin"
# The name the plugin had when this was written. It is a fallback, not the answer: the author
# renamed it (whatsapp-claude-channel -> whatsapp-channel) without changing the marketplace, and
# every install after that failed with "not found in marketplace". wa_plugin_name reads the name
# out of the marketplace once it has been cloned, so the next rename costs nothing.
WA_PLUGIN_FALLBACK="whatsapp-claude-channel"

# What the marketplace calls its WhatsApp plugin, right now. Read from the clone rather than
# remembered here: the marketplace kept its name and version while the plugin inside it was
# renamed, so a hardcoded name is a promise about somebody else's repository they never made.
wa_plugin_name() {
  local m="$HOME/.claude/plugins/marketplaces/$WA_MARKETPLACE/.claude-plugin/marketplace.json"
  local n=""
  if [ -f "$m" ]; then
    n="$(node -e '
      const fs = require("fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const p = (j.plugins || []).find((x) => x && typeof x.name === "string" && x.name.includes("whatsapp"));
        if (p) process.stdout.write(p.name);
      } catch {}
    ' "$m" 2>/dev/null)"
  fi
  if [ -n "$n" ]; then
    [ "$n" = "$WA_PLUGIN_FALLBACK" ] || log "the marketplace now calls the plugin '$n'"
    printf '%s' "$n"
  else
    printf '%s' "$WA_PLUGIN_FALLBACK"
  fi
}

# Linked, as opposed to half-way through linking.
#
# `registered` alone is not proof: Baileys sets it when the pairing code is REQUESTED, before the
# phone has confirmed anything. A run that asked for a code and was then abandoned leaves a file
# that says registered, and the next run believed it -- reporting "connected as +971..." to someone
# who had never received a code, let alone typed one. `me.id` is written only once the phone has
# actually completed the link, so both are required.
wa_paired() {
  local creds="$WA_DIR/.baileys_auth/creds.json"
  [ -f "$creds" ] || return 1
  local n; n="$(node_bin)" || return 1
  "$n" -e 'try{const c=require(process.argv[1]);process.exit(c.registered&&c.me&&c.me.id?0:1)}catch{process.exit(1)}' \
    "$creds" 2>/dev/null
}

bun_bin() {
  local c
  for c in "$(command -v bun 2>/dev/null)" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun \
           /usr/local/bin/bun; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

do_whatsapp() {
  local phone="${2:-}"
  step whatsapp running
  pct 5

  # Already linked? Do not touch it. Re-pairing a working channel to show a nicer screen would be
  # the worst possible trade.
  if wa_paired; then
    local n; n="$(wa_number 2>/dev/null)"
    log "already paired - leaving the existing link alone"
    if [ -n "$n" ]; then detail whatsapp "connected as +$n"; else detail whatsapp "connected"; fi
    step whatsapp ok; pct 100; finish ok
  fi

  case "$phone" in
    ''|*[!0-9]*)
      log "refusing: '$phone' is not digits only"
      detail whatsapp "Enter your number in digits only, with the country code and no plus sign."
      step whatsapp fail; finish fail ;;
  esac

  # ---- bun ----
  pct 12
  local bun
  if bun="$(bun_bin)"; then
    log "bun $("$bun" --version 2>/dev/null) already installed"
  else
    say "Installing bun, which the WhatsApp plugin runs on"
    log "GET https://bun.sh/install | bash"
    curl -fsSL --max-time 300 https://bun.sh/install 2>/dev/null | bash 2>&1 | sed 's/^/    /'
    export PATH="$HOME/.bun/bin:$PATH"
    bun="$(bun_bin)" || {
      detail whatsapp "bun did not install — the WhatsApp plugin cannot run without it"
      step whatsapp fail; finish fail; }
    log "installed bun $("$bun" --version 2>/dev/null)"
  fi

  # ---- the plugin ----
  pct 30
  local claude; claude="$(claude_bin)" || {
    detail whatsapp "Claude Code is not installed, and the plugin lives inside it"
    step whatsapp fail; finish fail; }
  say "Adding the plugin marketplace"
  log "claude plugin marketplace add $WA_PLUGIN_REPO"
  "$claude" plugin marketplace add "$WA_PLUGIN_REPO" 2>&1 | sed 's/^/    /'
  pct 45
  local name ref
  name="$(wa_plugin_name)"
  ref="$name@$WA_MARKETPLACE"
  say "Installing the WhatsApp plugin"
  log "claude plugin install $ref"
  "$claude" plugin install "$ref" 2>&1 | sed 's/^/    /'
  if ! "$claude" plugin list 2>/dev/null | grep -qF "$name"; then
    detail whatsapp "The plugin did not install — see the log"
    step whatsapp fail; finish fail
  fi
  log "plugin installed"

  # ---- the number ----
  # This is all that /whatsapp-claude-channel:configure <number> does: one line in one file. No
  # Claude session is needed for it, so the window writes it directly.
  pct 55
  mkdir -p "$WA_DIR"
  chmod 700 "$WA_DIR" 2>/dev/null
  if [ -f "$WA_DIR/.env" ]; then
    grep -v '^WHATSAPP_PHONE_NUMBER=' "$WA_DIR/.env" > "$WA_DIR/.env.new" 2>/dev/null
    printf 'WHATSAPP_PHONE_NUMBER=%s\n' "$phone" >> "$WA_DIR/.env.new"
    mv "$WA_DIR/.env.new" "$WA_DIR/.env"
  else
    printf 'WHATSAPP_PHONE_NUMBER=%s\n' "$phone" > "$WA_DIR/.env"
  fi
  chmod 600 "$WA_DIR/.env" 2>/dev/null
  log "wrote the number to ~/.whatsapp-channel/.env"

  # ---- ask WhatsApp for a pairing code ----
  # Starting the plugin's server is what makes WhatsApp issue one; the server appends it to
  # pairing.log. Only lines written AFTER this moment count -- the file keeps old codes, and
  # showing a dead one would send someone to their phone to type a code that cannot work.
  pct 65
  local plugin_dir
  plugin_dir="$(find "$HOME/.claude/plugins/marketplaces" -maxdepth 2 -type d -name 'whatsapp-claude-plugin' 2>/dev/null | head -1)"
  [ -n "$plugin_dir" ] || {
    detail whatsapp "Cannot find the installed plugin"
    step whatsapp fail; finish fail; }

  # Another channel server -- usually a Claude Code session with the plugin loaded -- holds this
  # lock and the same auth files. Two of them racing to register a device is how you end up with a
  # half-written credential and no working link, so stop instead.
  if [ -f "$WA_DIR/.server.lock" ]; then
    local lock_pid; lock_pid="$(head -1 "$WA_DIR/.server.lock" 2>/dev/null | tr -d ' ')"
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      log "another WhatsApp channel server is running (pid $lock_pid)"
      detail whatsapp "Quit Claude Code first — it is already running the WhatsApp channel."
      step whatsapp fail; finish fail
    fi
    log "clearing a stale lock (pid ${lock_pid:-unknown} is gone)"
    rm -f "$WA_DIR/.server.lock"
  fi

  local before=0
  [ -f "$WA_DIR/pairing.log" ] && before="$(wc -l < "$WA_DIR/pairing.log" 2>/dev/null | tr -d ' ')"
  say "Asking WhatsApp for a pairing code"
  nohup "$bun" run --cwd "$plugin_dir" --shell=bun --silent start \
    >> "$WORK/whatsapp-server.log" 2>&1 < /dev/null &
  local server_pid=$!
  log "channel server pid $server_pid"

  local code="" i
  for i in $(seq 1 60); do
    if [ -f "$WA_DIR/pairing.log" ]; then
      code="$(tail -n +$((before + 1)) "$WA_DIR/pairing.log" 2>/dev/null \
              | sed -n 's/.*PAIRING CODE: \([A-Z0-9-]*\).*/\1/p' | tail -1)"
      [ -n "$code" ] && break
    fi
    kill -0 "$server_pid" 2>/dev/null || { log "the channel server exited early"; break; }
    pct $(( 65 + i / 4 )); sleep 1
  done

  if [ -z "$code" ]; then
    kill "$server_pid" 2>/dev/null
    log "no pairing code appeared within 60s"
    detail whatsapp "WhatsApp did not send a code. Check the number and try again."
    step whatsapp fail; finish fail
  fi
  log "pairing code issued"
  printf '::code %s\n' "$code"
  need "Open WhatsApp on your phone and enter this code. It expires in a couple of minutes."
  pct 85

  # ---- wait for the phone ----
  say "Waiting for your phone"
  for i in $(seq 1 150); do
    if wa_paired; then
      kill "$server_pid" 2>/dev/null
      log "paired"
      detail whatsapp "Connected"
      step whatsapp ok; pct 100; finish ok
    fi
    sleep 2
  done
  kill "$server_pid" 2>/dev/null
  log "gave up waiting for the phone"
  detail whatsapp "The code was not entered in time. You can try again."
  step whatsapp fail; finish fail
}

case "${1:-}" in
  check-all) do_check_all ;;
  node)      do_node ;;
  claude)    do_claude ;;
  chrome)    do_chrome ;;
  configure) do_configure ;;
  start)     do_start "$@" ;;   # "$@" so the app pid in $2 reaches the function
  whatsapp)  do_whatsapp "$@" ;;
  *) echo "usage: setup-step.sh <check-all|node|claude|chrome|configure|start>" >&2; exit 64 ;;
esac
