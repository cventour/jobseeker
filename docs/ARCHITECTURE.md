# JobSeeker — how it works

The technical companion to [`README.md`](../README.md). That covers what JobSeeker is and how to run
it; this covers how it is built and *why it is built that way*. Most of the design here exists
because something went wrong first, so the reasoning is kept alongside the decision.

**Related documents, each with a distinct job:**

| Document | Answers |
|---|---|
| [`README.md`](../README.md) | What is this, and how do I run it? |
| **This file** | How does it work, and why is it shaped like this? |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | What must it do, and what is out of scope? |
| [`PERMISSIONS.md`](PERMISSIONS.md) | What macOS permissions are needed, how Chrome is reached on Windows, and how do I fix either? |
| [`SCHEDULER.md`](SCHEDULER.md) | How does the unattended daily run work? |
| [`boards.md`](boards.md) | Quirks of specific careers sites |
| [`.claude/AGENT-RULES.md`](../.claude/AGENT-RULES.md) | The normative rules every agent follows |

---

## Design principles

**Local Markdown is the source of truth.** Every record is a Markdown file with YAML frontmatter, or
a Markdown table. Human-readable, diffable, recoverable by hand. No opaque store.

**Fail loudly, never silently.** The dominant failure of an automation like this is *quiet* success —
a run reporting `ok` having read nothing. So coverage is recorded as data rather than prose, and a
sweep that extracts zero conversations is treated as a **failure** (a drifted selector), never as an
empty inbox. It refuses to advance its watermark.

**Measure capability; never infer it.** Nothing may conclude "there's no browser" from context. A
probe writes a machine-readable verdict, and everything downstream reads that.

**No dependencies.** `package.json` has no `dependencies` and no `devDependencies`. Everything runs
on Node built-ins and shell, so there is no supply chain to audit, nothing to install, and nothing to
rot. This is a tool for one person's laptop; it should still run in five years.

**Approval-gated by construction.** The unattended pipeline has no ability to submit or send. Those
paths are separate, interactive, and require an approval record.

## Architecture

```
Claude Code agents  ──►  server/record.mjs  ──►  data/*.md      (single writer, locked, atomic)
   (parallel)                    ▲                  │
                                 │                  ▼
scripts/chat-sweep.mjs  ─┐
   (WhatsApp/LinkedIn)   ├─► scripts/browser.mjs   server/dashboard.mjs  (localhost:4319)
scripts/board-sweep.mjs ─┘    (Apple Events on      server/audit.mjs      (read-only report)
   (careers boards)            macOS; the Bridge
                               extension on Windows)
   (careers boards)
```

| Component | Role |
|---|---|
| `.claude/agents/*` | Specialists: inbox, chats, scouting, prioritisation, reconciliation, supervision |
| `.claude/AGENT-RULES.md` | Normative behaviour rules every agent follows |
| `server/record.mjs` | The **only** writer. Cross-process lock + atomic writes |
| `server/lock.mjs` | Advisory mutex with stale-breaking; backs the data and browser locks |
| `server/audit.mjs` | Read-only coordination report (duplicates, overdue, browser debt) |
| `server/dashboard.mjs` | Single-file, dependency-free web UI |
| `server/platform.mjs` | The **only** OS-aware module: which script twin to run, how to schedule, how to open a URL |
| `server/bridge.mjs` | Loopback bridge the Chrome extension long-polls for work (Windows) |
| `scripts/browser.mjs` | Reads the live Chrome — a facade over `browser/applescript.mjs` (macOS) and `browser/extension.mjs` (Windows) |
| `scripts/chat-sweep.mjs` | Unattended WhatsApp / LinkedIn sweep |
| `scripts/board-sweep.mjs` | Unattended careers-board sweep: opens boards that refuse scripts, caches the text for role-scout |
| `scripts/job-run.sh` | Scheduler entry point: guards, probe, retries, status. `scripts/win/job-run.ps1` is its Windows twin |

## How browser access works — and why it is unusual

Reading WhatsApp Web and LinkedIn needs a real, logged-in browser. The obvious approach is Chrome's
DevTools Protocol, and it is the wrong one here:

- **Chrome 136+ refuses `--remote-debugging-port` when the profile directory is the default one**
  (verified on Chrome 150). Getting a port means relaunching Chrome against a *different* profile —
  which means WhatsApp shows a QR code and the linked device is gone.
- **An open debugging port is a standing security hole.** Any local process could then drive the
  browser with the user's full authenticated identity, with no per-site gate.

So JobSeeker drives the **already-running** Chrome, through **Apple Events** on macOS and through a
**Chrome extension** on Windows. Both transports share the same guarantees:

- No restart, no debugging port, no profile copied or created.
- If Chrome is closed it is started with **no command-line flags at all** — `open -g -a` on macOS,
  `chrome.exe` on Windows — because flags are what would risk landing on a different profile.
- Chrome is never quit or restarted.
- One driver at a time, enforced by a lock.
- The API exposes navigation and extraction only. There is no typing, no form submission and no
  general clicking on either transport.

`scripts/browser.mjs` is a facade over the two drivers — `scripts/browser/applescript.mjs` and
`scripts/browser/extension.mjs` — and the site-agnostic composites in `scripts/browser/snippets.mjs`
run on whichever one is picked. Callers import from the facade and never see the difference.

### On Windows

Windows has no Apple Events, and the CDP objection above is unchanged, so the transport is the
**JobSeeker Bridge** extension: an ordinary MV3 extension loaded unpacked from this repository's
`extension/` folder. There is no way to connect *into* an MV3 service worker, so the direction is
inverted — the extension long-polls `server/bridge.mjs` over loopback HTTP for work, runs it in the
user's tabs, and posts the result back.

- **Pairing is once, by hand.** The dashboard shows a six-digit code (Settings ▸ Browser ▸ Connect,
  or the setup wizard's Chrome step); the extension's options page takes it. The bridge mints a
  token into `data/.bridge.token` and pins the extension's `chrome-extension://` origin, so a web
  page that somehow learned the token still cannot poll for work.
- **The method allowlist is the boundary**, enforced on both sides: `ping`, `listTabs`, `runSnippet`,
  `openTab`, `navigateTab`, `closeTab`, `closeTabsByUrlPrefix`, `tabLoading`. Anything else is refused
  before it is queued. `navigateTab` and `closeTab` work only on tabs the extension itself opened —
  it remembers which those are — so a sweep can reuse one tab instead of opening one per page, and
  can never steer or close a tab of yours.
  `runSnippet` names one of the functions the extension ships in `extension/snippets.js`; there is no
  way to send it code. Manifest V3 would refuse to evaluate a string in a page in any case.
- **Two host-permission tiers.** WhatsApp Web and LinkedIn by default; reading careers pages needs
  the optional `<all_urls>` grant the user makes from the extension's options page.
- **Loopback only**, and the bridge rejects any connection whose remote address is not loopback.

The bridge runs inside the dashboard when the dashboard is up, on the same port, so one pairing
serves both. `npm run bridge` starts it standalone.

## Permissions it needs (and the ones it doesn't)

`npm run setup` handles all of this and verifies the result; what follows is what it is doing and why.

**On Windows there is nothing to approve.** There is no TCC and no Automation consent, so the
LaunchAgent reasoning below does not apply either — `scripts/browser-do.mjs` runs the work in-process,
which is the normal path there rather than a fallback. What replaces the grant is loading and pairing
the extension, and granting it careers-page access if you want board reads.

On macOS, two one-time approvals, both permanent:

1. **macOS Automation → Google Chrome** — System Settings ▸ Privacy & Security ▸ Automation.
   **System Events is not required**: liveness is checked with `pgrep`, which needs no permission and
   cannot fail for permission reasons.
2. **Chrome ▸ View ▸ Developer ▸ Allow JavaScript from Apple Events** — a Chrome setting, not a macOS
   one, and the only step that cannot be automated.

The grant is **not** attached to `node`. macOS keys it to the *responsible process*, and that is why
browser work is routed through a LaunchAgent: its identity is `/bin/bash` at a fixed path, so the
grant survives Claude Code updates. Driving Chrome in-process instead would attribute the grant to a
version-pinned binary and re-prompt after every update. The scheduled run is a **separate** requester
again, so it needs its own grant — `npm run setup` clears it while you are present.

It needs **no** Screen Recording, **no** Accessibility, **no** Full Disk Access and **no** debugging
port. Your screen is never captured, and no synthetic clicks or keystrokes are ever sent. The one
image the system can produce — the optional picture in a problem report — is drawn by the page from
its own DOM (`FEEDBACK_JS` in `server/dashboard.mjs`), never by an OS screen capture, which is
exactly why that feature added no permission.

`npm run browser:probe` reports exactly what works and names the fix for anything that does not.
Full detail: [`PERMISSIONS.md`](PERMISSIONS.md).

## Safety properties worth knowing

- **Concurrent writes do not lose rows.** Before the lock existed this was measured at *2 of 24
  surviving*, with no error raised anywhere. Covered by `npm run test:concurrency`.
- **A drifted selector cannot fake a successful sweep.** Covered by `npm run test:sweep`.
- **Reposts are detected** across reworded titles and new requisition IDs, and distinguished from
  the same role in a different territory.
- **Retrieved content is data, never instructions.** Job posts, recruiter email, chat messages and
  careers pages are all written by other people and can contain text aimed at the agent rather than
  the user. AGENT-RULES **§0** makes this the first rule: such text is quoted and surfaced, never
  obeyed, and it can never grant an approval, choose an identifier, or nominate a destination.
- **The dashboard rejects cross-site POSTs.** Loopback binding stops the network reaching it, but not
  a web page you are visiting from submitting a form to `localhost:4319` — a cross-origin form POST
  needs no CORS permission, and the write lands even though the attacker cannot read the reply. POSTs
  carrying a foreign `Origin`/`Referer`, or `Sec-Fetch-Site` other than same-origin, are refused with
  403. Requests with none of those headers are not browsers (curl, scripts, the tests) and are
  allowed — anything able to send one already has local code execution.

---

## Repository layout

```
.claude/            agents, the /jobseeker command + its playbooks (jobseeker/), and AGENT-RULES.md
config/             personal settings — gitignored, with a committed .example
data/               the source of truth. Gitignored; data/.example/ ships as a sample
docs/               this file and its siblings
extension/          the JobSeeker Bridge Chrome extension (Windows), loaded unpacked
installer/          the first-run window: JobSeeker.js (macOS), win/ (Windows)
scripts/            setup, the browser layer, the daily run, and the test suites
scripts/win/        PowerShell twins of the shell scripts, one for one
server/             record.mjs (the only writer), dashboard.mjs, audit.mjs, lock.mjs, md.mjs,
                    platform.mjs (the only OS-aware module), bridge.mjs
```

Nothing outside `server/platform.mjs` branches on `process.platform`. Run a script by name —
`npm run <script>` or `node scripts/run.mjs <name>` — and it resolves to `bash scripts/<name>.sh` on
macOS or `powershell -File scripts\win\<name>.ps1` on Windows.

## Tests

Every suite guards a bug that actually happened, and each is dependency-free:

| Command | Guards |
|---|---|
| `npm run test:concurrency` | Parallel writers losing rows — measured at 2 of 24 surviving before the lock existed |
| `npm run test:sweep` | A drifted selector faking a successful sweep and advancing a watermark |
| `npm run test:security` | Path traversal through a record id, and the dashboard binding beyond loopback |

## Contributing notes

- **All writes go through `server/record.mjs`.** It holds a cross-process lock and writes atomically.
  Hand-editing `data/` while a run is in flight will lose rows.
- **Record ids become filenames**, so they are validated against an allowlist. Do not bypass it.
- **The dashboard binds `127.0.0.1`.** There is no authentication, by design — loopback *is* the
  authentication.
- **Never hardcode personal values.** Company aliases and ignored chats live in
  `config/job-seeker.config.md`, which is gitignored.
