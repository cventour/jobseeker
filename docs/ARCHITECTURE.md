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
| [`PERMISSIONS.md`](PERMISSIONS.md) | What macOS permissions are needed, and how do I fix them? |
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
scripts/board-sweep.mjs ─┘    (Apple Events)       server/audit.mjs      (read-only report)
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
| `scripts/browser.mjs` | Reads the live Chrome over Apple Events |
| `scripts/chat-sweep.mjs` | Unattended WhatsApp / LinkedIn sweep |
| `scripts/board-sweep.mjs` | Unattended careers-board sweep: opens boards that refuse scripts, caches the text for role-scout |
| `scripts/job-run.sh` | Scheduler entry point: guards, probe, retries, status |

## How browser access works — and why it is unusual

Reading WhatsApp Web and LinkedIn needs a real, logged-in browser. The obvious approach is Chrome's
DevTools Protocol, and it is the wrong one here:

- **Chrome 136+ refuses `--remote-debugging-port` when the profile directory is the default one**
  (verified on Chrome 150). Getting a port means relaunching Chrome against a *different* profile —
  which means WhatsApp shows a QR code and the linked device is gone.
- **An open debugging port is a standing security hole.** Any local process could then drive the
  browser with the user's full authenticated identity, with no per-site gate.

So JobSeeker drives the **already-running** Chrome through **Apple Events** instead:

- No restart, no debugging port, no profile copied or created.
- If Chrome is closed it is started exactly as macOS starts it at login — `open -g -a`, **no flags** —
  because flags are what would risk landing on a different profile.
- Chrome is never quit or restarted.
- One driver at a time, enforced by a lock.

## Permissions it needs (and the ones it doesn't)

`npm run setup` handles all of this and verifies the result; what follows is what it is doing and why.

Two one-time approvals, both permanent:

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
port. Nothing is screenshotted, and no synthetic clicks or keystrokes are ever sent.

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
.claude/            agents, slash commands, and AGENT-RULES.md (the normative rules)
config/             personal settings — gitignored, with a committed .example
data/               the source of truth. Gitignored; data/.example/ ships as a sample
docs/               this file and its siblings
scripts/            setup, the browser layer, the daily run, and the test suites
server/             record.mjs (the only writer), dashboard.mjs, audit.mjs, lock.mjs, md.mjs
```

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
