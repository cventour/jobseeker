# Security

JobSeeker reads your email, your calendar, and your WhatsApp and LinkedIn message lists. That is a
lot of access, so this document states plainly what the design assumes, what it protects against,
and what it does not.

## Reporting a vulnerability

Use **[private vulnerability reporting](https://github.com/cventour/jobseeker/security/advisories/new)**
on this repository. Please do not open a public issue for anything exploitable.

This is a personal project maintained as time allows — expect a reply in days rather than hours, and
there is no bug bounty. If a report is valid you will be credited in the fix unless you prefer not to
be.

## The trust model

**Everything is local.** There is no server, no account, no telemetry, no analytics, and no network
destination that JobSeeker sends your data to. Your records are Markdown files in `data/`, which is
gitignored. The only outbound traffic is to the services you have connected — Gmail, Calendar,
WhatsApp, and the careers sites a scout fetches.

**You are the security boundary.** Anyone with access to your unlocked Mac has access to your job
search, exactly as they have access to your email client. JobSeeker adds no authentication of its
own, because on a single-user machine it would be theatre.

## What it protects against

| Threat | Control |
|---|---|
| A web page you visit reaching the dashboard | Dashboard binds `127.0.0.1` only, **and** rejects cross-site POSTs (`Origin` / `Referer` / `Sec-Fetch-Site`) |
| Malicious text in a job advert or email steering an agent | [AGENT-RULES §0](.claude/AGENT-RULES.md): retrieved content is data, never instructions. It can never grant an approval, choose an identifier, or nominate a destination |
| A crafted record id escaping the data directory | Ids become filenames, so they are validated against an allowlist before any filesystem access |
| Concurrent writes corrupting or losing records | Single writer (`server/record.mjs`) holding a cross-process lock, with atomic writes |
| An agent quietly doing nothing and reporting success | Coverage is recorded as measured data; an empty extraction is treated as failure, not an empty inbox |
| Losing your WhatsApp session | The browser is never restarted or given flags, and no separate profile is ever created |

Each of these is covered by a test — `npm run test:security` and `npm run test:concurrency`.

## What it deliberately does not do

- **No Screen Recording, Accessibility, or Full Disk Access.** Nothing is screenshotted, no synthetic
  clicks or keystrokes are ever sent, and only this project's own directory is read and written.
- **No Chrome remote-debugging port.** An open port lets any local process drive your browser with
  your full authenticated identity, with no per-site gate. JobSeeker refuses to open one, and the
  agent rules forbid recommending it.
- **No unattended sending.** The scheduled pipeline has no ability to submit an application or send a
  message. Those paths are separate, interactive, and require an approval record.

## Known exposure, stated honestly

**The dashboard can install launch agents and change the run schedule.** The Setup page runs a
closed allowlist of named actions — install the browser agent, re-run the probe, set or remove the
daily run — each mapped to a fixed script in this repository. It never executes a command supplied by
the request, and arguments are validated at the boundary as well as inside the script. It is still a
widening: a local process that can reach the dashboard can now change OS-level state, not only data.
The CSRF rejection and loopback binding below are what bound that.

**The dashboard has no authentication.** Loopback binding *is* the authentication. If you override
`JOBSEEKER_DASHBOARD_HOST` to expose it on a network, anyone who can reach the port can read and
modify your job search. The startup warning says so; do not ignore it.

**The browser agent holds a standing macOS Automation grant.** While installed, it can read any page
open in your Chrome, including authenticated ones. That is inherent to reading WhatsApp Web at all.
What bounds it is that the browser API exposes navigation, extraction, and exactly one narrow click:
`openConversation`, which selects the Nth row of a named conversation list and refuses to click a
`BUTTON`, an `INPUT`, or anything inside a `<form>`. There is no general click, no typing and no form
submission, so nothing can be sent or posted through it. The chat sweep uses that click to read a
thread's actual contents rather than the one-line preview, and opens a thread only when it is both
already read — an unread one is never touched, so no badge is ever cleared — and about to be logged
for carrying a job-search signal. Threads this system will not record are also never opened.

**Agents read attacker-controllable text.** Job adverts, recruiter email and chat messages are
written by other people. §0 is the mitigation; it is a rule followed by a model, not an enforced
boundary, so it is a mitigation rather than a guarantee. Treat anything an agent reports from
fetched content as a claim, not a fact.

**This is a personal project.** It has not been independently audited. It is licensed under
[PolyForm Noncommercial 1.0.0](LICENSE) and provided as-is, without warranty.

## Supported versions

The `main` branch is the only supported version. There are no backports.
