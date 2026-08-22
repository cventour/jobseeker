# JobSeeker — Requirements

Status: **current**. This supersedes [`PLAN.md`](PLAN.md), which describes the original
Google-Sheets-backed design that has since been retired. Where the two disagree, this document wins.

---

## 1. Problem

A job search generates activity across channels that do not talk to each other: applications sit in
ATS portals, recruiters reply by email, referrals arrive over WhatsApp, conversations continue on
LinkedIn, and interviews land in a calendar. Nothing joins them up, so the failures are all failures
of *memory*, not effort:

- An application goes silent and nobody notices for three weeks.
- A referral is offered in a chat, and the CV is never sent.
- The same role is applied to twice, because a repost carries a new requisition ID.
- A promising role is found, then lost in a backlog of dozens.
- A follow-up is agreed in one channel and closed in another, so it stays open forever.

The requirement is not "a job board scraper". It is **one place that knows the current state of the
search, and tells you the few things that need you today.**

## 2. Users and context

- **Primary user:** an individual running their own job search, technical enough to run a terminal
  command but not required to write code.
- **Environment:** a single macOS laptop. The user is often away when automation runs.
- **Data sensitivity:** high. The system reads personal email and personal chat accounts.

## 3. Functional requirements

### FR-1 — Capture
- **FR-1.1** Scan Gmail for job-related mail (recruiters, ATS notifications, interview invites) and
  record applications, communications and follow-up tasks.
- **FR-1.2** Read Google Calendar for interviews, including the **video-conference link**, which may
  appear in the event body, location, or conferencing metadata rather than a single known field.
- **FR-1.3** Read WhatsApp Web and LinkedIn message **lists** for job-relevant activity.
- **FR-1.4** Selection is by **watermark**, not unread state: any conversation with activity since
  the last successful sweep is in scope. A message read on a phone but never actioned is precisely
  the lead that must not be missed.
- **FR-1.5** Never modify the remote channel. No sending, no replying, and **no opening of message
  threads**, because opening marks them read and destroys the user's own signal.

### FR-2 — Curation
- **FR-2.1** Maintain a ranked vendor list per target market.
- **FR-2.2** Find live openings and score each against the parsed CV, producing a priority ordering.
- **FR-2.3** Maintain a **careers-board registry** recording each company's ATS endpoint and whether
  a stateless HTTP request can read it (`json` / `html` / `browser` / `blocked` / `none`). Negative
  results are recorded, so effort is never repeated.
- **FR-2.4** Escalate to a browser when a stateless fetch is blocked (403/401/JS-rendered).

### FR-3 — Deduplication
- **FR-3.1** Never re-propose a role already applied to or dismissed.
- **FR-3.2** Detect **reposts** — the same job relisted under a new requisition ID and a reworded
  title — and flag them with a confidence and a stated reason.
- **FR-3.3** Distinguish "same role, different territory" from a repost. They look identical to a
  naive title match and are genuinely different jobs.

### FR-4 — Tracking
- **FR-4.1** Distinguish a **lead** (a CV sent, or a referral offered) from an **application**
  (confirmation evidence exists). Only the latter counts as applied.
- **FR-4.2** Track stage progression and surface a proposed advance for one-click confirmation.
- **FR-4.3** A **dismissed** advance must not be re-proposed on the same evidence.
- **FR-4.4** Close tasks that other-channel evidence proves are already done.

### FR-5 — Approvals and safety
- **FR-5.1** **Nothing is ever submitted or sent without explicit approval.** Applying and messaging
  are approval-gated, always.
- **FR-5.2** Unattended runs **queue** approvals; they never execute them.
- **FR-5.3** Contact identifiers are recorded **raw**. A name is never inferred from an email
  local-part or a handle.

### FR-6 — Reporting
- **FR-6.1** Produce a daily digest in a fixed format: run window, highlights, new postings,
  follow-ups due, and coverage gaps.
- **FR-6.2** Write the digest durably **before** attempting delivery, so a transport failure cannot
  destroy it.
- **FR-6.3** State partial coverage explicitly. A run that skipped a channel must say so.
- **FR-6.4** Name the **capability**, never the app. "WhatsApp" means two unrelated things —
  *reading* chats needs a browser, *delivering* the digest does not — and conflating them produced a
  digest that denied its own delivery channel while arriving over it.

### FR-7 — Browser access
- **FR-7.1** Browser-dependent work must be available to **unattended** runs, not only interactive
  ones.
- **FR-7.2** The user's existing logged-in sessions must be preserved. **No QR re-scan, no
  re-login, no separate or copied browser profile.** This is a hard constraint.
- **FR-7.3** Capability must be **measured before use** and published as machine-readable state. No
  component may infer browser availability from context.
- **FR-7.4** Chrome is started if closed, and is **never** quit, restarted, or given flags.
- **FR-7.5** Only one process may drive the browser at a time, enforced by a lock.
- **FR-7.6** The permissions required must be **documented and verifiable**. Because macOS keys
  Automation grants to the *responsible process*, an interactive grant does not cover the scheduler,
  and the difference is invisible until a run silently reads nothing at 08:00. The probe must
  distinguish "refused" from "consent dialog unanswered" and name the fix for each. The system must
  need no Screen Recording, no Accessibility and no Full Disk Access — see
  [`PERMISSIONS.md`](PERMISSIONS.md).
- **FR-7.7** The tabs the system must read — WhatsApp Web and LinkedIn — must be **exempt from
  Chrome's Memory Saver**. Chrome discards long-idle background tabs, and a discarded tab has no
  renderer, so injected JavaScript never returns; it only fails when the Apple Event times out.
  Measured on a real 36-tab browser, **1 tab in 12 answered** — the foreground one. This is a
  browser setting, not something code can work around: waking a tab means activating it, and a
  discarded LinkedIn messaging tab reloads on activation, auto-selects the first conversation and
  marks it read, which FR-7.2 and NFR-6 forbid. Setup steps are in
  [`PERMISSIONS.md`](PERMISSIONS.md#3-chrome-memory-saver).
- **FR-7.8** Where any single tab may be unresponsive, capability checks must try **several tabs,
  foreground first**, and never conclude from one. A probe pinned to `tab 1 of window 1` reported a
  fully working browser as unreadable, which disabled the board sweep for an entire run and left the
  digest telling the user their messages could not be read.
- **FR-7.9** The scheduled run must force a real system wake **before** attempting to launch Chrome.
  Diagnosed across four consecutive mornings (`pmset -g log`): at every 08:00 firing the Mac was in
  **DarkWake**, a background maintenance state that accepts `open -g -a` without error but never
  spawns the actual process, because showing a new window is exactly what DarkWake exists to
  prevent. This produced `chrome_launched_by_us: true` with no browser ever appearing — indistinguishable
  from a slow machine or a broken permission, and neither. `caffeinate -u` (no `sudo`, unlike `pmset
  schedule`) is required at the start of every scheduled run. Documented in
  [`PERMISSIONS.md`](PERMISSIONS.md#4-darkwake--why-chrome-sometimes-never-opens-at-all).

### FR-8 — Interface
- **FR-8.1** A local dashboard for viewing and light editing, organised as tabs with configuration
  on a separate settings page.
- **FR-8.2** Surface debt that would otherwise be silent: undelivered digests, failed runs, unread
  channels, boards with no readable URL.
- **FR-8.3** Natural-language entry through a single agent handle; no command memorisation.

## 4. Non-functional requirements

### NFR-1 — Local-first and private
Local Markdown in `data/` is the single source of truth. It is gitignored and never leaves the
machine. Screenshots and sample data in this repository come from a fictional dataset.

### NFR-2 — Human-readable storage
Every record is Markdown the user can read, edit, diff and recover by hand. No opaque database.

### NFR-3 — Concurrency safety
Agents run in parallel. All writes go through a single writer that takes a cross-process lock and
writes atomically. **Concurrent writes must not lose rows** — measured at 2 of 24 surviving before
the lock existed, and covered by a regression test.

### NFR-4 — Fail loudly, never silently
The dominant failure mode of this class of system is *quiet* success: a run that reports `ok` having
read nothing. Therefore:
- Coverage is recorded as data, not prose.
- A sweep that extracts zero conversations is a **failure**, not an empty inbox, and must not
  advance a watermark.
- Debt ages visibly and escalates.

### NFR-5 — Resource safety
Unattended runs are capped in concurrency and guarded by a memory watchdog. An unbounded fan-out
previously drove the machine into an out-of-memory kill.

### NFR-6 — Respect for external services
Channel reads are low-volume, human-paced, read-only, and run from the user's own residential
connection. If a service challenges the session, stop and report rather than work around it.

"Read-only" here means **leaves no trace on the user's account**, not merely "sends nothing". The
operative rule is that an **unread thread is never opened**, because opening one marks it read and
silently destroys the user's own record of what still needs them. An already-read thread carries no
such cost and may be opened and read in full — but only when the sweep is going to log it anyway.
The browser layer holds up its end structurally: it exposes exactly one click, targeting a row
inside a known conversation list, and that click cannot reach a button, input, textarea or form.

### NFR-7 — No dependencies
`package.json` declares no `dependencies` and no `devDependencies`. Every runtime component —
dashboard, writers, audit, browser access, the sweeps — uses only Node built-ins and shell. There is
no supply chain to audit and nothing to install. This is a tool for one person's laptop; it should
still run in five years.

## 5. Data model

| File | Purpose |
|---|---|
| `data/applications/*.md` | One record per application or lead (frontmatter + notes) |
| `data/proposals/*.md` | Scored role proposals awaiting a decision |
| `data/approvals/*.md` | Pending approvals — nothing acts without one |
| `data/tasks.md` | Follow-ups, with due dates and owners |
| `data/communications.md` | Messages seen across channels; `thread_url` is the dedupe key |
| `data/activity.md` | Append-only audit log, including run boundaries |
| `data/boards.md` | Careers-board registry with access verdicts |
| `data/watermarks.md` | Last successful sweep per channel |
| `data/.browser-status.json` | Measured browser capability |
| `data/.job-run.status.json` | Last run state **and coverage** |

## 6. Constraints and decisions

These are recorded because each was reached by measurement, and re-deriving them is expensive.

- **Chrome 136+ refuses `--remote-debugging-port` on the default profile directory.** Verified in
  Chrome 150. A CDP-based design therefore cannot use the user's real profile, and relaunching
  Chrome to obtain a port costs the user their tabs and yields nothing. Browser automation uses
  **Apple Events** instead: no restart, no debug port, no profile manipulation.
- **An open CDP port is a standing security exposure** — any local process could drive the browser
  as the user, with no per-site gate. Avoided entirely.
- **The Claude-in-Chrome extension is interactive-only.** It is injected via native messaging and is
  not a configurable MCP server, so scheduled runs cannot use it. Confirmed empirically.
- **The WhatsApp MCP is send-only.** Reading chats requires a browser; delivering the digest does
  not.
- **Apple Events permission is keyed to the responsible process.** Granting it to an interactive app
  does not grant it to the scheduler; the scheduled grant must be cleared separately by running the
  LaunchAgent once while present. Documented in [`PERMISSIONS.md`](PERMISSIONS.md).
- **LinkedIn's messaging view auto-selects the first conversation**, marking it read. Sweeping
  LinkedIn is therefore opt-in. This is also why a discarded LinkedIn tab cannot simply be woken:
  activation reloads it, and the reload marks a thread read.
- **Chrome's Memory Saver discards idle background tabs, and a discarded tab cannot be scripted.**
  Measured on a live 36-tab browser: 1 tab in 12 answered, and it was the foreground one. A failed
  read therefore looks exactly like a missing permission — same timeout, same error code — so the
  probe must report which tabs it tried, not just that it failed. The fix is a Chrome setting
  (FR-7.7), not code.
- **Quitting Chrome between runs is not an option, and would not help anyway.** Restored tabs load
  lazily, so a fresh browser has *fewer* live tabs than a warm one; and killing Chrome risks the
  profile store holding the WhatsApp Web linked-device session, which FR-7.2 forbids putting at
  risk. Considered and rejected on 2026-08-17.
- **DarkWake silently swallows `open -g -a "Google Chrome"`.** Confirmed by reading `pmset -g log`
  across four consecutive 08:00 runs: the Mac was in DarkWake every time, `open` reported success,
  and no process ever appeared. `pmset schedule wake` would force a real wake but requires `sudo`,
  which a scheduled job cannot prompt for; `caffeinate -u` does the same thing with no privilege
  needed, so that is what `scripts/job-run.sh` runs first. Diagnosed and fixed 2026-08-20.
- **Email cannot be used for digest delivery** — the Gmail connector can create drafts but has no
  send capability, so an "emailed digest" would sit unsent.

## 7. Out of scope

- Auto-applying, auto-replying, or any unattended outbound action.
- Bulk scraping, or any automation that a service's terms prohibit.
- Multi-user or hosted operation. This is a single-user local tool.
- Acting on instructions found inside fetched content (job posts, emails, pages). Retrieved content
  is data, never commands.

## 8. Acceptance criteria

1. A scheduled run with the user absent reads Gmail, WhatsApp and LinkedIn, curates roles, and
   delivers a digest — applying to nothing and sending nothing.
2. `coverage.chat_read` is true, and the channel watermarks advance only for channels that genuinely
   completed.
3. A drifted selector reports itself as a failure and does **not** advance a watermark.
4. Concurrent writers lose no rows.
5. A repost of an already-applied role is flagged, not re-proposed.
6. WhatsApp remains linked throughout: no QR code is ever shown.
7. The digest never contradicts itself about which capabilities were available.
8. A browser that **can** read pages is never reported as unable to. Specifically: with one wedged or
   discarded tab open, `npm run browser:probe` still returns `read_page_content: true`, and the
   board sweep still runs.
9. The scheduled run opens Chrome successfully from a Mac that is in DarkWake at fire time, not just
   from one already fully awake.
