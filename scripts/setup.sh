#!/bin/bash
# First-run setup. Gets a fresh Mac to a VERIFIED working state, one line per step.
#
#   npm run setup                 interactive first run
#   npm run setup -- --dry-run    report only, change nothing
#   npm run setup -- --yes        accept the scheduler prompt (scripted installs)
#   npm run setup -- --verbose    show the underlying commands
#
# Two things it deliberately does NOT do:
#
#   * Install dependencies. There are none -- package.json declares no dependencies and no
#     devDependencies, so `npm install` is a genuine no-op. Runtime prerequisites (Node, Chrome) are
#     CHECKED and reported; installing a runtime or a browser behind a setup script is out of
#     proportion to the problem.
#   * Grant permissions. macOS forbids it: tccutil only RESETS grants, and pre-authorising would need
#     an MDM-signed profile keyed to a binary identity that changes on every Claude Code update. What
#     this script can do is trigger each prompt at a controlled moment and then VERIFY the result.
#
# The verification is the point. A setup script that accepts "I did it" on trust and prints "Ready"
# reproduces the exact silent-success failure this project exists to prevent.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

DRY=0; ASSUME_YES=0; VERBOSE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    --verbose) VERBOSE=1 ;;
    --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'
[ -t 1 ] || { BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; OFF=""; }

ok()   { printf "  ${GRN}[ok]${OFF}    %s\n" "$*"; }
done_(){ printf "  ${GRN}[done]${OFF}  %s\n" "$*"; }
warn() { printf "  ${YEL}[warn]${OFF}  %s\n" "$*"; }
fail() { printf "  ${RED}[FAIL]${OFF}  %s\n" "$*"; }
skip() { printf "  ${DIM}[skip]${OFF}  %s\n" "$*"; }
say()  { printf "%s\n" "$*"; }
run()  { [ "$VERBOSE" = 1 ] && printf "  ${DIM}\$ %s${OFF}\n" "$*"; [ "$DRY" = 1 ] || eval "$@"; }

# Is there a human at the keyboard? Prompts read from /dev/tty so that piped stdin cannot silently
# answer them -- but that also means a non-interactive run (ssh, CI, a pipeline) would BLOCK FOREVER
# on the first question. So detect it once and take the safe default instead of hanging.
INTERACTIVE=0
if [ -t 0 ] && [ -r /dev/tty ]; then INTERACTIVE=1; fi

# ask <prompt> <default: y|n> -> 0 for yes, 1 for no
ask() {
  local prompt="$1" default="$2" reply=""
  if [ "$ASSUME_YES" = 1 ]; then return 0; fi
  if [ "$INTERACTIVE" = 0 ]; then
    printf "  %s %s\n" "$prompt" "${DIM}(no terminal — assuming ${default})${OFF}"
    [ "$default" = "y" ]; return $?
  fi
  printf "  %s " "$prompt"
  read -r reply </dev/tty || reply=""
  [ -z "$reply" ] && reply="$default"
  case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
}

GAPS=()          # things the user still has to do
HARD_FAIL=0      # a missing prerequisite; nothing else can proceed
BROWSER_OK=0

printf "\n${BOLD}JobSeeker setup${OFF} — checking this machine\n\n"
[ "$DRY" = 1 ] && say "  ${DIM}(dry run: nothing will be changed)${OFF}" && say ""

# ---------------------------------------------------------------- 1. prerequisites (check only)

[ "$(uname -s)" = "Darwin" ] || { fail "this tool is macOS only (found $(uname -s))"; exit 1; }
ok "macOS $(sw_vers -productVersion)"

if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v)"; NODE_MAJOR="${NODE_V#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then ok "Node $NODE_V            (need >= 20)"
  else fail "Node $NODE_V is too old — need 20 or newer. Install from https://nodejs.org"; HARD_FAIL=1; fi
else
  fail "Node not found — install from https://nodejs.org"; HARD_FAIL=1
fi

CHROME_APP="/Applications/Google Chrome.app"
if [ -d "$CHROME_APP" ]; then
  ok "Google Chrome $("$CHROME_APP/Contents/MacOS/Google Chrome" --version 2>/dev/null | awk '{print $3}')"
else
  fail "Google Chrome not found in /Applications — install from https://google.com/chrome"; HARD_FAIL=1
fi

if command -v claude >/dev/null 2>&1; then ok "claude CLI              $(command -v claude)"
else warn "claude CLI not found    — dashboard works; the agents need it (https://claude.com/claude-code)"; fi

for b in launchctl osascript pgrep plutil; do
  command -v "$b" >/dev/null 2>&1 || { fail "$b missing — this should not happen on macOS"; HARD_FAIL=1; }
done

if [ "$HARD_FAIL" = 1 ]; then
  say ""; say "${RED}Cannot continue until the items above are installed.${OFF}"; say ""
  exit 1
fi

# ---------------------------------------------------------------- 2. changes we may legitimately make

CFG="config/job-seeker.config.md"
if [ -f "$CFG" ]; then
  ok "$CFG already exists (left untouched)"
elif [ "$DRY" = 1 ]; then
  # Say what WOULD happen. Reporting "created" while creating nothing is the same class of lie as a
  # run that reports ok having read nothing.
  skip "$CFG would be created from the example"
else
  cp "config/job-seeker.config.md.example" "$CFG"
  done_ "$CFG created from the example"
fi

if launchctl print "gui/$(id -u)/com.jobseeker.browser" >/dev/null 2>&1; then
  ok "browser agent already installed (com.jobseeker.browser)"
else
  if [ "$DRY" = 1 ]; then skip "browser agent would be installed"
  else
    if bash "$REPO/scripts/install-browser-agent.sh" >/dev/null 2>&1; then
      done_ "browser agent installed (com.jobseeker.browser)"
    else
      fail "could not install the browser agent — run: npm run browser:install-agent"
      GAPS+=("browser agent not installed — run: npm run browser:install-agent")
    fi
  fi
fi

# The scheduler is opt-in: quietly scheduling a daily job that reads someone's mail and messages is a
# surprising thing for a setup script to do.
SCHED_LABEL="com.jobseeker.jobrun"
SCHED_INSTALLED=0
if launchctl print "gui/$(id -u)/$SCHED_LABEL" >/dev/null 2>&1; then
  ok "08:00 daily run already scheduled ($SCHED_LABEL)"; SCHED_INSTALLED=1
elif [ "$DRY" = 1 ]; then
  skip "would ask whether to schedule the 08:00 daily run"
else
  say ""
  say "  The daily run reads your email and messages at 08:00 and sends you a summary."
  say "  It never applies to anything and never sends a message without your approval."
  if ask "Schedule it? [y/N]" n; then SCHED_ANSWER=y; else SCHED_ANSWER=n; fi
  say ""
  case "$SCHED_ANSWER" in
    y)
      # Delegate: scripts/set-schedule.sh owns plist authoring, linting and launchctl, so setup
      # and the dashboard cannot drift into two different behaviours.
      if bash "$REPO/scripts/set-schedule.sh" 08:00 >/dev/null 2>&1; then
        done_ "08:00 daily run scheduled ($SCHED_LABEL)"; SCHED_INSTALLED=1
      else
        fail "could not schedule the daily run — see docs/SCHEDULER.md"
      fi
      ;;
    *) skip "08:00 scheduler — declined (run npm run setup again to add it later)" ;;
  esac
fi

# ---------------------------------------------------------------- 3. permissions: trigger + verify

# Reads the probe's own verdict rather than inventing a second source of truth.
browser_can_read() {
  node -e 'try{const b=require("./data/.browser-status.json");process.exit(b.capabilities?.read_page_content?0:1)}catch{process.exit(1)}' 2>/dev/null
}
browser_blockers() {
  node -e 'try{const b=require("./data/.browser-status.json");(b.blockers||[]).forEach(x=>console.log(x))}catch{}' 2>/dev/null
}
# The installed agent is bound to ONE checkout: its plist hardcodes that repo's browser-agent.sh, and
# that script reads and writes ITS OWN data/. Run setup from a second clone and the request lands in
# one directory while the agent answers in another, so they never meet -- browser-do then waits out
# its full 15-minute deadline. Detect the mismatch instead of hanging on it.
AGENT_PLIST="$HOME/Library/LaunchAgents/com.jobseeker.browser.plist"
agent_repo() {
  [ -f "$AGENT_PLIST" ] || return 1
  # plutil parses the plist properly rather than pattern-matching XML.
  local prog
  prog="$(plutil -extract ProgramArguments.1 raw -o - "$AGENT_PLIST" 2>/dev/null)"
  [ -n "$prog" ] || return 1
  printf '%s' "${prog%/scripts/browser-agent.sh}"
}

# macOS has no `timeout`, so bound the probe with a watchdog. A setup script must never be able to
# block for fifteen minutes on a health check.
probe() {
  node "$REPO/scripts/browser-do.mjs" probe >/dev/null 2>&1 &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 2; waited=$((waited + 2))
    if [ "$waited" -ge 90 ]; then kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 1; fi
  done
  wait "$pid" 2>/dev/null
}

chrome_toggle_steps() {
  say ""
  say "    1. Open Chrome"
  say "    2. Menu bar ▸ View ▸ Developer"
  say "    3. Click \"Allow JavaScript from Apple Events\""
  say ""
}

# Chrome discards long-idle background tabs to reclaim memory, and a discarded tab has no renderer,
# so a scripted read of it never returns. It fails with the SAME timeout a missing permission gives,
# which is why this is worth stating explicitly rather than leaving to a generic error. It bites
# hardest unattended: at 08:00 the WhatsApp and LinkedIn tabs have been idle all night.
memory_saver_steps() {
  say ""
  say "    1. Open Chrome ▸ Settings ▸ Performance"
  say "    2. Under \"Memory Saver\", click Add beside \"Always keep these sites active\""
  say "    3. Enter web.whatsapp.com and click Add"
  say "    4. Click Add again, enter linkedin.com, click Add"
  say ""
}

if [ "$DRY" = 1 ]; then
  skip "would trigger the macOS Automation prompt and verify browser access"
else
  say ""
  AGENT_REPO="$(agent_repo || true)"
  if [ -n "$AGENT_REPO" ] && [ "$AGENT_REPO" != "$REPO" ]; then
    warn "browser agent points at a different checkout:"
    say  "          $AGENT_REPO"
    say  "          Re-point it at this one with: npm run browser:install-agent"
    GAPS+=("browser agent belongs to $AGENT_REPO — run: npm run browser:install-agent")
  fi
  say "  Checking browser access (a macOS prompt may appear — click Allow)…"
  probe
  if browser_can_read; then
    BROWSER_OK=1
  else
    # Only the Chrome-side toggle needs a human. Everything else the probe names for itself.
    if browser_blockers | grep -qi "Allow JavaScript from Apple Events"; then
      say ""
      say "  ${BOLD}One step needs you:${OFF}"
      chrome_toggle_steps
      say "  Automating this would need Accessibility permission — control of your entire UI."
      say "  JobSeeker never asks for that."
      say ""
      for attempt in 1 2 3; do
        if [ "$INTERACTIVE" = 0 ]; then
          say "  ${DIM}(no terminal — cannot wait for this step)${OFF}"; break
        fi
        printf "  Press Enter when done, or S to skip… "
        read -r ans </dev/tty || ans="s"
        case "$ans" in [sS]*) break ;; esac
        probe
        if browser_can_read; then BROWSER_OK=1; break; fi
        # Same steps again, deliberately not reworded — re-reading identical steps beats parsing a
        # fresh explanation.
        fail "still cannot read page content"
        browser_blockers | sed 's/^/          /'
        chrome_toggle_steps
      done
    fi
    # Every tab timed out rather than refusing: permission is granted, the tabs were just asleep.
    # Different problem, different fix — offering the Apple Events toggle here would send someone to
    # tick a box that is already ticked.
    if [ "$BROWSER_OK" != 1 ] && browser_blockers | grep -qi "no tab ran the page script"; then
      say ""
      say "  ${BOLD}Chrome put its tabs to sleep.${OFF} Permission is fine — a sleeping tab has nothing"
      say "  running to answer. Either click a tab to wake it, or stop Chrome sleeping these two:"
      memory_saver_steps
      if [ "$INTERACTIVE" = 1 ]; then
        printf "  Press Enter when done, or S to skip… "
        read -r ans </dev/tty || ans="s"
        case "$ans" in [sS]*) : ;; *) probe; browser_can_read && BROWSER_OK=1 ;; esac
      fi
    fi
  fi

  if [ "$BROWSER_OK" = 1 ]; then
    TABS="$(node -e 'try{process.stdout.write(String(require("./data/.browser-status.json").tabs_open))}catch{process.stdout.write("?")}' 2>/dev/null)"
    ok "browser verified — read-pages via apple-events, $TABS tabs"
    # Reading works NOW, at the keyboard, with the tabs awake. The unattended run is the one that
    # struggles, so recommend this while things look healthy rather than after a silent 08:00.
    say ""
    say "  ${BOLD}One more Chrome setting, so the 08:00 run works too:${OFF}"
    memory_saver_steps
    say "  Chrome puts idle background tabs to sleep, and a sleeping tab cannot be read. That is why"
    say "  a channel can read fine now and read nothing overnight. Keeping these two awake fixes it."
    say ""
  else
    fail "browser cannot read page content yet"
    browser_blockers | sed 's/^/          /'
    GAPS+=("browser cannot read WhatsApp Web or LinkedIn — see docs/PERMISSIONS.md")
  fi
fi

# The scheduled run is a SEPARATE macOS requester (/bin/bash under launchd), so it needs its own
# grant. Skipped entirely when there is no scheduler -- asking someone to change System Settings for
# a capability they declined is noise, and noise is what makes people skip the steps that matter.
if [ "$SCHED_INSTALLED" = 1 ] && [ "$DRY" = 0 ]; then
  say ""
  say "  The 08:00 run needs its own one-time approval. macOS ties permission to the program that"
  say "  asks, and the scheduled run asks as /bin/bash rather than as your terminal — a separate"
  say "  requester. Clearing it now avoids a prompt at 08:00 that nobody is there to click."
  say ""
  if ask "Trigger it now? [Y/n]" y; then
    launchctl kickstart -k "gui/$(id -u)/com.jobseeker.browser" >/dev/null 2>&1
    done_ "triggered — approve any prompt that appears"
  else
    skip "scheduler approval — do it later with: launchctl start $SCHED_LABEL"
  fi
fi

# ---------------------------------------------------------------- 4. summary

say ""
if [ "$DRY" = 1 ]; then
  say "${BOLD}Dry run complete.${OFF} Nothing was changed. Run without --dry-run to apply."
elif [ ${#GAPS[@]} -eq 0 ] && [ "$BROWSER_OK" = 1 ]; then
  say "${GRN}${BOLD}Ready.${OFF} Next: run ${BOLD}claude${OFF}, then ${BOLD}/onboard${OFF} to set your targets and CV."
else
  say "${YEL}${BOLD}Set up, with gaps:${OFF}"
  for g in "${GAPS[@]:-}"; do [ -n "$g" ] && say "  • $g"; done
  say ""
  say "  Everything else works. Re-run ${BOLD}npm run setup${OFF} once fixed, or check with:"
  say "    npm run browser:probe"
fi
say ""
exit 0
