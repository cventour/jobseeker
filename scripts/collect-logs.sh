#!/usr/bin/env bash
# Gather everything needed to explain a failed run, into one file on the Desktop.
# Windows twin: scripts/win/collect-logs.ps1 — change both together.
#
#   npm run logs                     (from the JobSeeker folder)
#   bash ~/Downloads/collect-logs.sh (handed to a tester who has no terminal habits)
#
# It exists for the tester who cannot say more than "it did not work". Every question worth asking
# them — which version, was the CLI there, what did the log say, was the PDF a scan — is answerable
# from their machine without them. This asks all of them and writes one file to send back.
#
# It READS ONLY. It starts nothing, changes nothing, and sends nothing anywhere: the last thing it
# does is reveal the file in Finder so a person decides where it goes.
#
# What it deliberately does NOT collect: the CV itself, data/profile.md, the contents of any
# tracker table, the bridge token, the WhatsApp number. Names, phone numbers, keys and home
# directory paths are replaced on the way out. The result is meant to be readable by its owner
# before they send it, and short enough that they will.
set -uo pipefail

# ---- find the installation ---------------------------------------------------------------------
# The script may be run from inside the repo, or from Downloads after being emailed. Both have to
# work, because "cd to the folder first" is the instruction testers skip.
find_repo() {
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for c in "${JOBSEEKER_HOME:-}" "$here/.." "$here" "$PWD" \
           "$HOME/JobSeeker" "$HOME/jobseeker" "$HOME/Documents/JobSeeker" \
           "$HOME/Applications/JobSeeker" "/Applications/JobSeeker.app/Contents/Resources/app"; do
    [ -n "$c" ] || continue
    if [ -f "$c/package.json" ] && [ -f "$c/server/dashboard.mjs" ]; then (cd "$c" && pwd); return 0; fi
  done
  # Last resort: ask Spotlight. Slower, but it finds an install nobody remembers making.
  local found
  found="$(mdfind -name dashboard.mjs 2>/dev/null | grep -m1 '/server/dashboard.mjs$')"
  [ -n "$found" ] && { dirname "$(dirname "$found")"; return 0; }
  return 1
}

REPO="$(find_repo)" || {
  echo "Could not find the JobSeeker folder."
  echo "Run this again from inside it:   cd <your JobSeeker folder> && bash scripts/collect-logs.sh"
  exit 1
}
cd "$REPO" || exit 1
DATA="${JOBSEEKER_DATA_DIR:-$REPO/data}"

STAMP="$(date '+%Y-%m-%d_%H%M')"
# The Desktop, unless a caller names somewhere else. The dashboard's Report a problem does name
# somewhere else: it folds this report into a zip alongside the reporter's own words and, if they
# allowed one, a picture of the page — so it wants the text, not a second loose file on the Desktop
# and not a Finder window opening behind its dialog. JOBSEEKER_LOGS_OUT also suppresses the reveal
# below, because a caller that gave a path is not asking to be shown it.
if [ -n "${JOBSEEKER_LOGS_OUT:-}" ]; then
  OUT="$JOBSEEKER_LOGS_OUT"
  mkdir -p "$(dirname "$OUT")" 2>/dev/null || true
else
  OUT="$HOME/Desktop/jobseeker-logs_${STAMP}.txt"
  [ -d "$HOME/Desktop" ] || OUT="$HOME/jobseeker-logs_${STAMP}.txt"
fi

NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"

# ---- redaction ----------------------------------------------------------------------------------
# Applied to every line of every captured file, by the same filter the Windows twin uses. The home
# directory goes first: it carries the tester's real name, and it is in almost every path in almost
# every log. If node is missing there is nothing to redact WITH, and a half-redacted file is worse
# than an honest refusal — so that case stops the script rather than writing one.
# The script is meant to be handed to someone whose copy of JobSeeker may be older than this file,
# so it cannot assume the shared redactor is there. When it is not, a reduced one is written to a
# temp file — because the alternative, sending logs through unredacted, is not an option, and
# refusing to run at all wastes the round trip that this script exists to avoid.
REDACTOR="$REPO/server/redact.mjs"
if [ ! -f "$REDACTOR" ]; then
  REDACTOR="$(mktemp -t redact).mjs"
  cat > "$REDACTOR" <<'FALLBACK'
const home = process.argv[2] || "";
const DATEISH = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?|\d{2}:\d{2}:\d{2}/g;
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", () => {
  const parked = [];
  let s = buf.replace(DATEISH, (m) => "\u00abD" + (parked.push(m) - 1) + "\u00bb");
  if (home) s = s.split(home).join("~");
  s = s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted-email>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<redacted-token>")
    .replace(/(token|secret|key|password|authorization)("?\s*[:=]\s*"?)[^\s",}]+/gi, "$1$2<redacted>")
    .replace(/(^|[^\w./])(\+?\d[\d\s()-]{7,}\d)(?![\w./])/g, (m, pre, num) =>
      num.replace(/\D/g, "").length >= 9 ? pre + "<redacted-phone>" : m);
  process.stdout.write(s.replace(/\u00abD(\d+)\u00bb/g, (_, i) => parked[Number(i)]));
});
FALLBACK
fi
# $DATA and the config are what let the redactor mask the names in this user's own tracker — the
# companies they are chasing and the people they are talking to. No pattern can recognise those; a
# list read from data/ can. Harmless when they do not exist (a tester running an emailed copy): the
# redactor falls back to the shape rules alone.
redact() { "$NODE_BIN" "$REDACTOR" "$HOME" "$DATA" "$REPO/config/job-seeker.config.md"; }

if ! "$NODE_BIN" --version >/dev/null 2>&1; then
  echo "Node is not installed on this Mac, and this script needs it to strip personal details out"
  echo "of the logs. Install Node (https://nodejs.org) and run this again."
  exit 1
fi

# The home directory is swapped out HERE rather than at each call site, because it only takes one
# forgotten call site to put the tester's real name in a file that promises it is not there — which
# is exactly what happened to the two lines naming where claude is installed. File contents go
# through the full redactor separately; this is the one rule that also has to cover lines we compose
# ourselves, and doing it in say() is what makes it impossible to forget in a line added later.
say()  { printf '%s\n' "${*//$HOME/~}" >> "$OUT"; }
head2() { say ""; say "=============================================================================="; say "$*"; say "=============================================================================="; }

# Tail a file, redacted, or say plainly that it is not there. "(absent)" is an answer; silence
# is not — a missing log and an empty log mean different things.
show() { # label, file, lines
  local label="$1" file="$2" n="${3:-80}"
  say ""
  say "--- $label  [${file#$REPO/}] ---"
  if [ ! -e "$file" ]; then say "(absent — this step has never run on this machine)"; return; fi
  if [ ! -r "$file" ]; then say "(present but not readable)"; return; fi
  local total; total="$(grep -ac '' "$file" 2>/dev/null || echo ?)"
  say "($total lines; last $n)"
  tail -n "$n" "$file" | redact >> "$OUT"
}

# The run logs are mostly prose: whole digests, with the names of real recruiters and real
# companies in them. None of that helps diagnose a crash, and all of it is the tester's private
# business. So these logs are reduced to their skeleton — the run banners and any line that
# announces a failure — and the narrative in between is dropped rather than redacted.
skeleton() { # label, file, lines
  local label="$1" file="$2" n="${3:-40}"
  say ""
  say "--- $label  [${file#$REPO/}]  (run banners and errors only — the digests are left out) ---"
  if [ ! -e "$file" ]; then say "(absent — this step has never run on this machine)"; return; fi
  grep -aE '^=+ |ERROR|Error:|error:|failed|FAILED|not found|NOT FOUND|Unknown command|blocker:|exit [0-9]|refus|timeout|EADDRINUSE|ENOENT|spend' "$file" 2>/dev/null \
    | tail -n "$n" | redact >> "$OUT" || say "(no banner or error lines)"
}

cmd() { # label, command...
  local label="$1"; shift
  say ""
  say "--- $label ---"
  { "$@" 2>&1 || echo "(exit $?)"; } | head -40 | redact >> "$OUT"
}

: > "$OUT"

head2 "JobSeeker logs — $(date '+%Y-%m-%d %H:%M:%S %Z')"
say "Collected by scripts/collect-logs.sh. Read-only."
say ""
say "macOS        $(sw_vers -productVersion 2>/dev/null) ($(uname -m))"
say "node         $("$NODE_BIN" --version 2>/dev/null || echo 'NOT FOUND') at $NODE_BIN"
say "repo         ${REPO/#$HOME/~}"
say "data         ${DATA/#$HOME/~}"
say "version      $("$NODE_BIN" -p "require('$REPO/package.json').version" 2>/dev/null || echo '?')"
say "commit       $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '(not a git checkout)')"
say "branch       $(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '-')"

# ---- the CLI the whole product depends on --------------------------------------------------------
# A parse that never reached Claude fails with exactly the same message as an unreadable PDF. These
# three lines are what separates them, so they come before anything else.
head2 "The Claude CLI"
CLAUDE_BIN="$(command -v claude || true)"
if [ -n "$CLAUDE_BIN" ]; then
  say "claude       $CLAUDE_BIN"
  cmd "claude --version" claude --version
else
  say "claude       NOT FOUND ON PATH"
  say ""
  say "Nothing that costs money can run without it."
fi
say ""
say "--- can the APP find it? ---"
# This script runs in Terminal, where the user's profile has already fixed PATH. The app does not:
# launched from the Dock it inherits launchd's PATH and hands that to every script it spawns. So
# the answer above is the wrong question, and this is the right one.
LAUNCHD_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
if env -i HOME="$HOME" PATH="$LAUNCHD_PATH" bash --noprofile --norc -c 'command -v claude' >/dev/null 2>&1; then
  say "yes — claude is on the bare PATH a GUI app gets ($LAUNCHD_PATH)"
else
  say "NO — with the PATH a GUI app gets ($LAUNCHD_PATH), claude is invisible."
  APP_FOUND=""
  for d in "$HOME/.local/bin" "$HOME/.claude/local" /opt/homebrew/bin /usr/local/bin \
           "$HOME/.bun/bin" "$HOME/.volta/bin" "$HOME/.npm-global/bin"; do
    [ -x "$d/claude" ] && { APP_FOUND="$d/claude"; break; }
  done
  if [ -n "$APP_FOUND" ]; then
    say "It is installed at $APP_FOUND. Current JobSeeker looks there; older copies did not, and"
    say "reported the CLI as missing from the PATH even though typing claude in Terminal works."
    say "If that is the message on screen, updating JobSeeker fixes it."
  else
    say "It is not in any of the usual install directories either — it may genuinely be missing,"
    say "or installed somewhere only the shell profile knows about."
  fi
fi
say ""
say "--- project commands the CLI needs to find ---"
if [ -d "$REPO/.claude/commands" ]; then
  say ".claude/commands: $(ls "$REPO/.claude/commands" 2>/dev/null | tr '\n' ' ')"
  [ -f "$REPO/.claude/commands/jobseeker.md" ] && say "jobseeker.md: present" || say "jobseeker.md: MISSING — every /jobseeker <subcommand> would fail as 'Unknown command'"
  [ -f "$REPO/.claude/jobseeker/parse-cv.md" ] && say "jobseeker/parse-cv.md: present" || say "jobseeker/parse-cv.md: MISSING — /jobseeker parse-cv would have no playbook to follow"
else
  say ".claude/commands: MISSING ENTIRELY."
  say "Every slash command (/jobseeker parse-cv, /jobseeker job-run, /jobseeker curate) would fail as 'Unknown command', and the"
  say "CV step would report 'Nothing could be read' no matter how good the PDF is."
fi
[ -f "$REPO/CLAUDE.md" ] && say "CLAUDE.md: present" || say "CLAUDE.md: missing"

# ---- the CV step -----------------------------------------------------------------------------
head2 "The CV step"
say ""
say "--- templates/cv (names, sizes and dates only — no file is copied) ---"
if [ -d "$REPO/templates/cv" ]; then
  ls -lT "$REPO/templates/cv" 2>/dev/null | redact >> "$OUT"
else
  say "(the folder does not exist — nothing has ever been uploaded)"
fi
show "parse status" "$DATA/.cv-parse.status.json" 40
show "parse log (this is the one that says why)" "$DATA/.cv-parse.log" 200

say ""
if [ -f "$REPO/scripts/cv-probe.mjs" ]; then
  "$NODE_BIN" "$REPO/scripts/cv-probe.mjs" 2>&1 | redact >> "$OUT"
else
  say "--- CV file probe ---"
  say "(this copy of JobSeeker predates the file probe — update it and run this again if the log"
  say " above does not already say why the parse failed)"
fi

say ""
say "--- data/profile.md (shape only, never its contents) ---"
if [ -f "$DATA/profile.md" ]; then
  say "size $(wc -c < "$DATA/profile.md" | tr -d ' ') bytes, modified $(date -r "$DATA/profile.md" '+%Y-%m-%d %H:%M')"
  say "frontmatter keys present: $(grep -o '^[a-z_]\{1,\}:' "$DATA/profile.md" 2>/dev/null | tr -d ':' | tr '\n' ' ')"
  if grep -qi 'No CV parsed yet' "$DATA/profile.md" 2>/dev/null; then
    say "content: STILL THE PLACEHOLDER — no CV has ever been read into it."
  else
    say "content: looks like a real parsed profile."
  fi
else
  say "(absent)"
fi

# ---- the dashboard, which is what the tester was actually looking at -----------------------------
head2 "The dashboard"
PORT="$(grep -m1 '^dashboard_port:' "$REPO/config/job-seeker.config.md" 2>/dev/null | sed 's/[^0-9]//g')"
PORT="${PORT:-4319}"
say "configured port: $PORT"
for p in "$PORT" 4319 4320; do
  code="$(curl -s -o /dev/null -m 4 -w '%{http_code}' "http://127.0.0.1:$p/_whoami" 2>/dev/null)"
  say "127.0.0.1:$p/_whoami -> ${code:-no answer}"
done
cmd "who is listening" bash -c "lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null || echo '(nothing listening)'"
show "dashboard log" "$DATA/.dashboard.log" 80
show "dashboard errors" "$DATA/.dashboard.err.log" 80
show "detached jobs" "$DATA/.spawn.log" 60

# ---- everything else that fails quietly ----------------------------------------------------------
head2 "Other logs"
show "setup" "$DATA/.setup/setup.log" 60
show "setup step" "$DATA/.setup/step.log" 60
show "dashboard start (stdout)" "$DATA/.setup/server.log" 40
show "dashboard start (stderr)" "$DATA/.setup/server.err.log" 40
skeleton "run now" "$DATA/.run-now.log" 40
show "run now status" "$DATA/.run-now.status.json" 20
skeleton "job run" "$DATA/.job-run.log" 40
show "job run status" "$DATA/.job-run.status.json" 30
# Market research is spawned detached with its output discarded, so this log is the ONLY record
# that it ran at all -- and it was the one log this bundle did not collect. A report of "I asked it
# to research my markets and nothing happened" was unanswerable for exactly that reason.
skeleton "market research" "$DATA/.markets-run.log" 40
show "market research status" "$DATA/.markets-run.status.json" 20
show "browser status" "$DATA/.browser-status.json" 40
skeleton "bridge" "$DATA/.bridge.log" 40

# ---- the updater ---------------------------------------------------------------------------
# "I updated and nothing changed" is unanswerable without these. The update writes its own log and
# status, and whether the Mac app was rebuilt turns on ONE condition: self-update.sh only stops,
# rebuilds and reopens the app when it finds a JobSeeker.app whose repo-path.txt equals this
# install's path exactly. When it does not match, the update still succeeds -- the tree is
# replaced -- but the old app and the old running server are left alone, and the person sees no
# change at all. So the comparison is made here rather than described.
head2 "The updater"
show "update status" "$DATA/.setup/update.json" 40
show "update log" "$DATA/.setup/update.log" 120

say ""
say "--- the Mac app bundle ---"
FOUND_APP=0
for d in "$HOME/Applications" "/Applications"; do
  APP="$d/JobSeeker.app"
  [ -d "$APP" ] || continue
  FOUND_APP=1
  say "${APP/#$HOME/~}"
  RP="$APP/Contents/Resources/repo-path.txt"
  if [ -f "$RP" ]; then
    POINTS="$(cat "$RP" 2>/dev/null)"
    say "  points at   ${POINTS/#$HOME/~}"
    if [ "$POINTS" = "$REPO" ]; then
      say "  MATCHES this install — an update would stop, rebuild and reopen it"
    else
      say "  DOES NOT MATCH this install (${REPO/#$HOME/~})."
      say "  An update would replace the files and then leave this app, and the server it started,"
      say "  running the old code. That is what 'I updated and nothing changed' looks like."
    fi
  else
    say "  no repo-path.txt — an update cannot tell this app belongs to this install, so it would"
    say "  not be rebuilt or reopened."
  fi
  BIN="$APP/Contents/MacOS/JobSeeker"
  [ -f "$BIN" ] && say "  built       $(date -r "$BIN" '+%Y-%m-%d %H:%M')"
  say "  bundle ver  $(defaults read "$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '(none set)')"
  if pgrep -f "$BIN" >/dev/null 2>&1; then say "  running     yes"; else say "  running     no"; fi
done
[ "$FOUND_APP" = "1" ] || say "(no JobSeeker.app in ~/Applications or /Applications — this install is run from a terminal)"

say ""
say "--- what the running server actually is ---"
# The version on disk and the version being served are different claims, and after an update that
# replaced the files without restarting anything they disagree. That disagreement IS the diagnosis.
WHO="$(curl -s -m 4 "http://127.0.0.1:$PORT/_whoami" 2>/dev/null)"
if [ -n "$WHO" ]; then
  say "$(printf '%s' "$WHO" | redact)"
  SERVED="$(printf '%s' "$WHO" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  ONDISK="$("$NODE_BIN" -p "require('$REPO/package.json').version" 2>/dev/null || echo '?')"
  if [ -n "$SERVED" ] && [ "$SERVED" != "$ONDISK" ]; then
    say ""
    say "MISMATCH: the files on disk are $ONDISK but the server answering is $SERVED."
    say "An update replaced the files and the old server is still running. Quit JobSeeker fully"
    say "and open it again."
  fi
else
  say "(nothing answering on port $PORT)"
fi

head2 "Settings (redacted)"
show "config" "$REPO/config/job-seeker.config.md" 100

head2 "End"

# ---- hand it over ---------------------------------------------------------------------------------
SIZE="$(du -h "$OUT" | cut -f1 | tr -d ' ')"
echo ""
echo "Wrote $OUT  ($SIZE)"
echo ""
echo "Email or message that one file back. It is plain text — open it first if you want to see"
echo "exactly what it says. Your CV, your profile and your contacts are not in it; email"
echo "addresses, phone numbers, keys and your home folder name are replaced."
echo ""
[ -n "${JOBSEEKER_LOGS_OUT:-}" ] || open -R "$OUT" 2>/dev/null || true
