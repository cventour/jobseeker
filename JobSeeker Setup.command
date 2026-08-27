#!/bin/bash
# The double-clickable entry point. This is the first thing a new user touches, so it is written to
# be readable by the person who just downloaded it — not only by whoever maintains it.
#
# What it does, in order: check this Mac can run JobSeeker, install the one thing it can legitimately
# install, start the local dashboard, and open it in a window with no address bar. From there the
# welcome wizard takes over.
#
# What it deliberately does NOT do is install Node or Chrome behind your back. scripts/setup.sh has
# refused to do that since it was written, for a good reason: silently installing a language runtime
# or a browser is out of proportion to the problem, and doing it from a double-clicked file — which
# is exactly the shape of a thing people are told never to trust — is worse. If either is missing,
# this opens a page that tells you what to get and where from, and gets out of the way.
#
# Closing this Terminal window stops JobSeeker. That is the whole quit story.

set -uo pipefail

# Finder runs a .command from the user's home directory, not from where the file lives, so every
# path here is derived from the script itself.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO" || exit 1

CHROME="/Applications/Google Chrome.app"
CHROME_BIN="$CHROME/Contents/MacOS/Google Chrome"
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; OFF=$'\033[0m'
[ -t 1 ] || { BOLD=""; DIM=""; RED=""; GRN=""; OFF=""; }

say()  { printf '%s\n' "$*"; }
# Hold the window open so the message above is readable. Finder always gives a tty; a piped or
# scripted run does not, and there is nobody there to press Return anyway.
pause() { ( read -r -p "Press Return to close. " _ </dev/tty ) 2>/dev/null || true; }
ok()   { printf "  ${GRN}✓${OFF}  %s\n" "$*"; }
bad()  { printf "  ${RED}✗${OFF}  %s\n" "$*"; }

# A window, not a wall of text. Used only when something is missing and there is no dashboard yet to
# show it in — the point of a graphical installer is that its failures are graphical too.
show_page() { # title, body-html
  local f; f="$(mktemp -t jobseeker-setup).html"
  cat > "$f" <<HTML
<!doctype html><meta charset="utf-8"><title>JobSeeker Setup</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0f1220;color:#e7e9f3;
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  display:grid;place-items:center;min-height:100vh;padding:40px}
main{max-width:560px}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 14px}
p{color:#9aa0bd;margin:0 0 14px}
a.btn{display:inline-block;background:#6ea8fe;color:#0f1220;text-decoration:none;font-weight:600;
  padding:11px 18px;border-radius:9px;margin-top:6px}
code{background:#181c2f;border:1px solid #2a2f48;border-radius:5px;padding:2px 6px;font-size:13px}
ol{color:#9aa0bd;padding-left:20px}li{margin-bottom:7px}
.after{margin-top:26px;padding-top:18px;border-top:1px solid #2a2f48;font-size:13.5px;color:#9aa0bd}
</style>
<main><h1>$1</h1>$2
<p class="after">When you have done that, double-click <code>JobSeeker Setup.command</code> again.
You can close this window.</p></main>
HTML
  if [ -x "$CHROME_BIN" ]; then
    open -na "$CHROME" --args --app="file://$f" --window-size=760,620 2>/dev/null
  else
    open "$f" 2>/dev/null
  fi
}

printf "\n${BOLD}JobSeeker${OFF} — getting this Mac ready\n\n"

# ---------------------------------------------------------------- 1. can this Mac run it at all?
if [ "$(uname -s)" != "Darwin" ]; then
  bad "JobSeeker is macOS only (this is $(uname -s))."
  say ""; pause; exit 1
fi
ok "macOS $(sw_vers -productVersion)"

if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v)"; NODE_MAJOR="${NODE_V#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
else
  NODE_V=""; NODE_MAJOR=0
fi
if [ "${NODE_MAJOR:-0}" -lt 20 ] 2>/dev/null; then
  bad "Node 20 or newer is needed${NODE_V:+ (found $NODE_V)}."
  say "   Opening the download page…"
  show_page "JobSeeker needs Node first" \
    "<p>Node is the engine JobSeeker runs on. It is free, it is the standard install from the
     official site, and it takes about a minute.</p>
     <p><a class=\"btn\" href=\"https://nodejs.org\">Download Node (nodejs.org)</a></p>
     <p>Take the version marked <b>LTS</b>. The installer will ask for your Mac password, because it
     puts Node where every app can find it — that is the one password step, and it is Node's
     installer asking, not JobSeeker.</p>"
  say ""; pause; exit 1
fi
ok "Node $NODE_V"

if [ ! -d "$CHROME" ]; then
  bad "Google Chrome not found in /Applications."
  show_page "JobSeeker needs Google Chrome" \
    "<p>JobSeeker reads WhatsApp Web and LinkedIn in <b>your own Chrome</b>, already signed in as
     you. That is why it needs this particular browser and not another.</p>
     <p><a class=\"btn\" href=\"https://google.com/chrome\">Download Chrome</a></p>
     <p>Nothing is sent anywhere. It reads the pages you are already logged into, on this Mac.</p>"
  say ""; pause; exit 1
fi
ok "Google Chrome $("$CHROME_BIN" --version 2>/dev/null | awk '{print $3}')"

if command -v claude >/dev/null 2>&1; then
  ok "Claude Code $(claude --version 2>/dev/null | awk '{print $1}')"
  CLAUDE_OK=1
else
  # Not fatal. The dashboard, the wizard and everything you can read work without it; only the
  # agents that go and DO things need it. Saying so is better than refusing to start.
  bad "Claude Code not found — the dashboard will work, but nothing can run yet."
  CLAUDE_OK=0
fi

# ---------------------------------------------------------------- 2. the one thing we may install
if [ ! -f config/job-seeker.config.md ] && [ -f config/job-seeker.config.md.example ]; then
  cp config/job-seeker.config.md.example config/job-seeker.config.md
  ok "Created your settings file (config/job-seeker.config.md)"
fi

# The browser agent is ours, it lives under the user's own home, and it is the thing that lets a
# scheduled run drive Chrome after a Claude Code update. Installing it is in proportion; installing
# a browser is not.
if [ -x scripts/install-browser-agent.sh ] || [ -f scripts/install-browser-agent.sh ]; then
  if bash scripts/install-browser-agent.sh >/dev/null 2>&1; then
    ok "Browser agent installed"
  else
    bad "Browser agent did not install — WhatsApp and LinkedIn reading may not work."
  fi
fi

# ---------------------------------------------------------------- 3. start it, and open a window
PORT="$(node -e '
  const fs=require("fs");
  try{
    const t=fs.readFileSync("config/job-seeker.config.md","utf8");
    const m=/^dashboard_port:[ \t]*(\d+)/m.exec(t);
    process.stdout.write(m?m[1]:"4319");
  }catch{ process.stdout.write("4319"); }' 2>/dev/null)"
[ -n "$PORT" ] || PORT=4319
URL="http://localhost:$PORT"

# Already running? Then this is a second double-click, and the right response is to show you the
# window you already have rather than fail on a busy port.
if curl -fsS -o /dev/null --max-time 2 "$URL" 2>/dev/null; then
  ok "JobSeeker is already running on port $PORT"
  open -na "$CHROME" --args --app="$URL" --window-size=1180,900 2>/dev/null
  say ""
  say "  ${DIM}Opened the window. This one was already running, so closing this Terminal"
  say "  window will not stop it.${OFF}"
  say ""
  exit 0
fi

say ""
say "  Starting JobSeeker…"
node server/dashboard.mjs &
SERVER_PID=$!
# Stop the server when this window closes. Without it, quitting Terminal would leave a web server
# holding your job-search data with nothing on screen to say so.
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT INT TERM

# Wait for it to answer rather than guessing at a sleep — a slow first start would otherwise open a
# window on a connection error and look broken.
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null --max-time 1 "$URL" 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || { bad "JobSeeker stopped while starting up."; break; }
  sleep 0.2
done

if curl -fsS -o /dev/null --max-time 2 "$URL" 2>/dev/null; then
  ok "Running on $URL"
  # --app is what makes this feel like an application: no address bar, no tabs, no bookmarks.
  open -na "$CHROME" --args --app="$URL" --window-size=1180,900 2>/dev/null
  say ""
  say "  ${BOLD}JobSeeker is open in its own window.${OFF}"
  [ "$CLAUDE_OK" = 0 ] && say "  ${DIM}Install Claude Code (claude.com/claude-code) to let it actually run anything.${OFF}"
  say ""
  say "  ${DIM}Leave this Terminal window open while you use it."
  say "  Closing it — or pressing Ctrl-C — stops JobSeeker.${OFF}"
  say ""
  wait "$SERVER_PID"
else
  bad "JobSeeker could not start. The details are just above this line."
  say ""
  pause
  exit 1
fi
