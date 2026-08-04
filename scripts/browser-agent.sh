#!/bin/bash
# The browser broker: performs Chrome work on behalf of whoever asked, from a STABLE identity.
#
# Why this exists
#   macOS keys Automation permission to the "responsible process". For an interactive Claude Code
#   session that is ~/.local/share/claude/versions/<version>/claude -- a version-pinned binary with
#   no stable identity, so the consent dialog literally names the version ("2.1.221" wants access to
#   control "Google Chrome"). Every Claude Code update is therefore a NEW requester and prompts
#   again, forever. There is no way to pre-approve a version that does not exist yet.
#
#   A LaunchAgent's responsible process is its Program -- /bin/bash, Apple-signed, at a fixed path
#   that never changes. Granted once, it stays granted across Claude Code updates, macOS updates and
#   reboots. The scheduled 08:00 run has always worked for exactly this reason.
#
#   So all browser work is funnelled through here instead of being done in-process.
#
# Protocol (deliberately files, not a socket: no daemon to keep alive, and every request and result
# is inspectable after the fact)
#   request : data/.browser-request.json  {"id": "...", "action": "...", "args": ["..."]}
#   result  : data/.browser-result.json   {"id": "...", "ok": bool, "code": int, "output": "..."}
#
# Invoked on demand:  launchctl kickstart -k gui/$UID/com.jobseeker.browser

set -uo pipefail

# launchd gives a job a minimal PATH -- node is not on it, and every node call in this script failed
# silently until that was fixed. Prepend the usual install locations rather than assuming one.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$c" ] && NODE="$c" && break; done
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

REQ="$REPO/data/.browser-request.json"
RES="$REPO/data/.browser-result.json"
LOG="$REPO/data/.browser-agent.log"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

[ -f "$REQ" ] || { log "no request pending"; exit 0; }

if [ -z "$NODE" ]; then log "FATAL: node not found on PATH=$PATH"; exit 70; fi

ID="$("$NODE" -e 'try{process.stdout.write(String(require(process.argv[1]).id||""))}catch{}' "$REQ" 2>/dev/null)"
ACTION="$("$NODE" -e 'try{process.stdout.write(String(require(process.argv[1]).action||""))}catch{}' "$REQ" 2>/dev/null)"

# macOS ships bash 3.2, which has no `mapfile` -- using it meant ARGS was always empty and the
# action fell through to "unknown". Read line by line instead, which works on any bash.
ARGS=()
while IFS= read -r line; do ARGS+=("$line"); done < <("$NODE" -e '
  try { const a = require(process.argv[1]).args || []; for (const x of a) console.log(String(x)); } catch {}
' "$REQ" 2>/dev/null)

log "request $ID: $ACTION ${ARGS[*]:-}"

case "$ACTION" in
  probe)      OUT="$("$NODE" "$REPO/scripts/browser-probe.mjs" 2>&1)"; CODE=$? ;;
  chat-sweep) OUT="$("$NODE" "$REPO/scripts/chat-sweep.mjs" ${ARGS[@]+"${ARGS[@]}"} 2>&1)"; CODE=$? ;;
  # An allowlist, not a passthrough: this runs with a standing permission to drive the user's
  # logged-in browser, so it must never become "execute whatever the request file says".
  *)          OUT="unknown action: $ACTION (allowed: probe, chat-sweep)"; CODE=64 ;;
esac

"$NODE" -e '
  const fs = require("fs");
  const path = require("path");
  // node -e has NO script filename, so argv[1] is the FIRST user argument, not the script.
  // Destructuring as if it were `node file.js` shifted every field by one and wrote a result the
  // client could never match, so every request timed out despite the work succeeding.
  const [, res, id, code, out] = process.argv;
  // Refuse to write outside data/. When the argv indexing was wrong this wrote the result to a file
  // named after whatever landed in argv[1] -- creating junk like ./req_mse9ebo9 and ./manual_test in
  // the repo root, four of which reached a commit. A misindexed write should fail loudly, not
  // scatter files.
  const abs = path.resolve(res);
  const dataDir = path.resolve(process.cwd(), "data") + path.sep;
  if (!abs.startsWith(dataDir)) {
    console.error("refusing to write result outside data/: " + abs);
    process.exit(65);
  }
  fs.writeFileSync(abs, JSON.stringify({ id, ok: code === "0", code: Number(code), output: out }, null, 2));
' "$RES" "$ID" "$CODE" "$OUT"

rm -f "$REQ"
log "request $ID done (exit $CODE)"
exit 0
