---
description: The full daily job-search pipeline — track channels, refresh priorities, curate roles, reconcile finished tasks, supervise, and send you a digest. Queues (does not auto-execute) anything needing approval. This is the scheduler entrypoint. Add "deep" for the thorough weekly pass.
argument-hint: "[deep]"
---

Run my full daily job-search pipeline. Arguments: `$ARGUMENTS`

**Depth.** Default (no arguments) is the **daily** pass — keep it fast, skip fresh markets, and do
the vendor-careers-site sweep only for tier-1 gaps. If `$ARGUMENTS` contains **`deep`**, run the
**weekly thorough** pass instead: refresh **every** market regardless of `stale`, run the vendor
careers-site sweep across **all** tiers, and re-validate **every** stored proposal URL
(`node scripts/check-urls.mjs --all`, including dismissed/applied). Everything else below is
identical — same guardrails, same approval queuing. This is designed to run unattended (from the local
scheduler) and leave a curated, prioritized queue waiting for me — **without applying to anything
or sending any message on its own.** Anything that needs my go-ahead is QUEUED as an approval, not
executed.

## 0. Log that the run started — do this FIRST, before anything else

```
node server/record.mjs log run-start "$([ -n "$JOBRUN_SOURCE" ] && echo scheduled || echo manual) run started $(date '+%H:%M')"
```

`scripts/job-run.sh` exports `JOBRUN_SOURCE=scheduled`, so this distinguishes the 08:00 run from one
you kicked off yourself. The row is highlighted in the Activity tab as a **run boundary** — without
it the log is a flat wall of writes with no way to tell where one run ended and the next began. Also
capture this timestamp for the digest header.

## Concurrency model — read this before launching anything

The phases below are **not** four barriers. Only stage 4 (supervise) genuinely needs everything
else finished. Specifically:

- **NEVER more than 3 subagents in flight at once (AGENT-RULES §13).** This is a hard cap and it
  overrides every "fan out" instruction below. A 7-way fan-out on 2026-07-29 put the laptop into a
  jetsam kill — three stray `claude` processes reached 15.9/12.0/6.1 GB. Queue the surplus and
  start the next agent as one reports back; do not launch a fourth to "save a minute".
- **Per-market work is an independent chain, not a phase.** Cybersecurity's curation does not need
  Fintech's prioritization to finish. For each market, run `prioritization-agent` → `role-scout` as
  its **own chain**, and run the chains **concurrently with each other**. Do not wait for all
  markets to be prioritized before curating any of them — that wastes the whole slowest-market gap.
- **Reconciliation runs alongside curation.** It only depends on the trackers (stage 1), not on
  proposals, so launch it as soon as stage 1 is done rather than after stage 3.
- **At most ONE Chrome-driving agent at a time.** `chat-tracker` and `role-scout`'s LinkedIn pass
  both drive the same single logged-in browser; two at once fight over tabs and burn LinkedIn rate
  limits. Anything using `mcp__claude-in-chrome__*` must be serialized. Stateless web work
  (WebFetch/WebSearch against vendor careers sites) has no such limit — fan that out freely.
- Concurrent `record.mjs` writes are safe: it takes a lock on `data/` and writes atomically, so
  parallel agents cannot lose each other's rows.

## 1. Track (parallel, but Chrome is serial)

Two agents — within the 3-agent cap, so they go together.

- Launch **inbox-tracker** (Gmail + Calendar).
- Launch **chat-tracker** (WhatsApp Web + LinkedIn) **only if `data/.browser-status.json` says
  `capabilities.read_page_content` is true.** `scripts/job-run.sh` writes that file by measuring,
  before this run starts. If it is false, skip chat-tracker and copy the `blockers` array verbatim
  into the digest's Coverage section — those strings are already written as the specific one-time
  fix, so passing them through is more useful than paraphrasing them.
- These two do not contend (one uses Gmail MCP, the other Chrome), so run them together.

## 2. Prioritize → curate, one concurrent chain per market

First, ask the audit which markets actually need refreshing instead of judging it yourself:

```
node server/audit.mjs "$(date +%F)" 
```

Its `markets` array gives each market's `last_reviewed`, `age_days`, and a `stale` boolean
(stale = never reviewed, or 7+ days old). Then, **for each market, as its own chain**:

- if `stale` → **prioritization-agent** for that market, then **role-scout** for that market;
- if not stale → skip straight to **role-scout** for that market.

Launch the chains concurrently **but never more than 3 agents at a time** — with 4+ markets that
means waves: start 3 chains, and as each one reports back start the next queued market. Reconcile
(stage 3) counts against the same budget of 3, so hold a slot for it rather than launching every
market first.

Remember the Chrome rule: run the LinkedIn pass **once**, serially
(it covers all markets at the same time via my saved preferences/recommendations); the per-market
vendor-careers-site passes are stateless and parallel.

Before scouting, give the scouts the dedupe set in one call rather than making each of them read
every proposal and application file:

```
node server/record.mjs list-keys
```

Anything with `skip: true` (dismissed by me, or already applied) must **not** be re-proposed.

Also tell the scouts to open with the board registry rather than hunting careers sites:

```
node server/record.mjs list-boards
```

That gives each company's known ATS endpoint and an `access` verdict. When `data/.browser-status.json` reports
`read_page_content: false`, anything marked `browser` or `blocked` is unreachable — the scouts should skip those
and report them as uncovered rather than burning calls, and must `upsert-board` whatever they learn
(AGENT-RULES §14).

Also re-validate the links on proposals I have not actioned, so the digest never shows me a dead
posting:

```
node scripts/check-urls.mjs
```

Hand its `needs_attention` list to a scout to re-derive live URLs (or drop the roles), per
AGENT-RULES §7. Note that `resolves` only means the link loads — it is not verification.

## 3. Reconcile across channels (concurrent with stage 2)

Launch the **reconciler** agent. It reads all open tasks and all of `data/communications.md` and
closes the ones that other-channel evidence proves are already done (a WhatsApp referral fulfilled
by a sent email, etc.), conservatively. Do not do this inline yourself — it is a large read and it
belongs in its own context.

## 4. Supervise (barrier — everything above must be finished)

Run the **supervisor** for the duplicate/overlap/attention audit. It goes last so its counts
reflect the tasks the reconciler just closed and the proposals the scouts just wrote.

## 5. Digest

**Record the run window.** Capture `date '+%H:%M'` as the FIRST thing you do in this run (before
stage 1) and again when composing the digest.

**The digest format is fixed. Use it exactly, for both WhatsApp and chat:**

```
Update of <D Mon YYYY> Completed at <HH:MM>
Started <HH:MM> · <N>m · <ok | partial | failed>   ← take this from the audit's `run_gaps.state_hint`, never from the status file

Highlights
- <the decision-worthy items, most urgent first — 3 to 6 bullets, one line each>

New Job Postings
<Company name> - <Job posting>
<job_url on its own line, so it is tappable on a phone>
<… best matches first, MAXIMUM 5. If none were found this run, write "None found today.">

Follow ups for Today
- <Who> - <the ask, in a few words>
<… most urgent first, up to 6, then "+N more" if there are others>

Coverage
- <only what was NOT covered, and why. Omit the section entirely if coverage was complete.>

System
- <only when something the USER must fix is broken — browser, permissions, delivery. Omit if healthy.>
```

Rules for the content:

- **New Job Postings means NEW — roles this run actually found**, ranked best-match first, capped at
  5. Not the standing proposal queue. Say "None found today." rather than padding it with older
  proposals; a quiet day is information. **Exclude anything flagged `repost_of`** — a job already
  applied to is not a new posting; if it matters, it goes in Highlights instead.
- **Every posting carries its link, and the link comes from the data — never from you.** Get the rows
  with:

  ```
  node server/record.mjs list-proposals --since <this run's date> --limit 5
  ```

  Copy `job_url` **verbatim** onto its own line beneath the title. Never reconstruct, shorten,
  "clean" or guess a URL: the user taps these on a phone to apply, so a plausible-but-wrong link
  costs them a real opportunity and they may not notice it was wrong. Query strings are part of the
  address — `?gh_jid=` is Greenhouse's job id, not tracking, and removing it breaks the link.
  A URL on its own line also keeps WhatsApp from swallowing it into surrounding text.
- **Do not send a link you know is dead.** If `scripts/check-urls.mjs` put that posting in
  `needs_attention`, either omit it or mark it `(link unverified)` — never present a broken link as
  an opportunity. A posting with no `job_url` at all is listed without one rather than dropped.
- **Follow ups for Today = tasks due today**, not the overdue backlog (that is a Highlights line).
  Name the person or company, then the ask in a few words. Cap at 6 and add "+N more" so a heavy day
  does not produce an unreadable message.

- **Highlights is for things needing YOU, not statistics.** A silent employer past the chase point, a
  stage advance waiting on a click, an expiring referral window, a deadline, a decision. Lead with
  the most time-critical. Bare counts ("40 applications") belong in Highlights only when the number
  itself is the news.
- **Name the thing.** "Northwind silent 10 days since the final panel" beats "1 application needs
  follow-up".
- **Coverage is not optional when something was missed** — AGENT-RULES requires partial coverage be
  stated explicitly, so a run that skipped a channel or a market says so here. Drop the section only
  when nothing was skipped.
- **Name the capability, never just the app (AGENT-RULES §10).** "WhatsApp" means two different
  things here and conflating them makes the report contradict itself. A real digest said *"WhatsApp
  and LinkedIn not checked — no Chrome"* **in a message delivered over WhatsApp**. Write instead:

  > WhatsApp Web and LinkedIn messages were not READ — no Chrome in this run. (This digest still
  > reached you: delivery goes over the WhatsApp API, which needs no browser.)

  The parenthetical is required whenever Chrome was unavailable AND the digest was delivered —
  otherwise the message undermines its own credibility on your phone.
- **A broken browser is a SYSTEM item, and it goes in the digest — not just in a file.** If
  `capabilities.read_page_content` is false, the digest MUST carry a **System** section that states,
  in this order: that WhatsApp Web and LinkedIn were not read, the `blockers` strings **verbatim**,
  whether Chrome was auto-started (`chrome_launched_by_us`), and what the user has to do about it.
  This rule exists because a real run failed with nothing in the digest but a generic phrase, and
  the actual cause — a cold-started Chrome that never became scriptable — was only visible by
  reading a JSON file the user never sees. A fault the user cannot see is a fault that does not get
  fixed.
- **Escalate it into Highlights when it has persisted.** If `browser_debt.worst_days` is 2 or more,
  or `any_never_swept` is true, the browser problem is one of the most important things in the run
  and belongs at the top, not buried under Coverage.
- **Never propose enabling Chrome remote debugging, and never call Apple Events a fallback.**
  `cdp: down` is the intended state (AGENT-RULES §13). A run that reports it as a defect, or suggests
  restarting Chrome to "restore the faster path", is recommending the one action that would show a
  WhatsApp QR code and lose the linked device.
- **Report a permission problem as a permission problem.** `apple_events: "denied"` or
  `"prompt-pending"` means a macOS Automation grant needs a click; say exactly that and name
  System Settings > Privacy & Security > Automation. Do not describe it as "Chrome not working".
- **Never assert browser state from context — read `data/.browser-status.json`.** You do not know
  whether this run has a browser; the file does, because it measured. The assumption "interactive
  means Chrome is available" is empirically false (a 1 Aug interactive run reported no Chrome), and
  free-form guessing produced seven different unparseable phrasings of the same condition. Report
  `capabilities.read_mechanism` and the `blockers` array as given.
- **`whatsapp.unread` is worth reporting even when you could not read the messages.** The probe gets
  the unread count from the tab title, which needs no permission. "11 unread on WhatsApp Web, not
  readable this run because <blocker>" is actionable; silence is not.
- **No emojis** anywhere in the digest.

**Always send it when a run completes**, including a partial or failed one — a run that produced
nothing still needs to report its window.

### Delivery — write it down first, then try to push it

Delivery has failed silently before: the WhatsApp MCP server is a **stdio** server, so every session
spawns its own instance, and a second instance cannot claim a device link an orphaned one is still
holding. Three scheduled runs in a row printed their digest into a log nobody reads. So:

1. **ALWAYS write the digest to `data/.last-digest.md` first**, before attempting any delivery. This
   is the durable copy; the dashboard surfaces it and it cannot be lost to a transport failure.
   Start the file with a delivery line: `delivered: whatsapp | not-delivered: <reason>`.
2. **Then try WhatsApp** (`reply` to `whatsapp_owner_jid` from `config/job-seeker.config.md`).
   If the tool is not available, do **not** treat that as "no digest today" — record
   `not-delivered: whatsapp MCP tool unavailable this session` on the delivery line.
3. **Never leave delivery failure buried in prose.** The status file and the log must both say it, so
   `scripts/job-run.sh` can raise a macOS notification and `audit.mjs` can report it next run.

Do NOT try to send the digest by email: the Gmail connector can create drafts but has **no send
tool**, so an "emailed digest" would sit unsent in Drafts. Verified, not assumed.


- Compose: `New proposals: N (top 3 with priority) · Follow-ups due today: M · Pending approvals:
  K · Needs decision: <offers/interviews/rejections> · Cleanups: <from supervisor> · Dead links:
  <from check-urls>`.
- The audit's **`browser_debt`** block reports how long WhatsApp/LinkedIn have gone unread and how
  many boards are queued behind a browser. If `any_never_swept` is true or `worst_days` is 2 or
  more, that belongs in **Highlights**, named with the number — an unread channel that stays unread
  for a week is exactly the kind of quiet failure this pipeline exists to surface.
- Read `previous_scheduled_run`, NEVER `last_scheduled_run`, when asking how the run before this
  one went. During your run `last_scheduled_run` describes **you**, and says `running` — a digest
  once reported its own status file as stuck because of exactly this.
- If `previous_scheduled_run` shows the previous run ended in state `failed` or `partial`, say so at
  the top of the digest — a silently-failed run is the one thing I would otherwise never notice.
- WhatsApp: send it with the `reply` tool to my owner chat (`whatsapp_owner_jid` from
  `config/job-seeker.config.md`; if blank, use my most recent WhatsApp `unreplied` sender or skip
  WhatsApp gracefully).
- Chat: print the same digest as your final message.
- `node server/record.mjs log job-run "digest: N proposals, M follow-ups due, K approvals pending"`.

## Hard rules for unattended runs

- **Do NOT apply** to anything (no application-agent here) and **do NOT send** follow-ups. Applying
  is `/apply` and sending is `/followup`, both with my approval, done when I'm present.
- **Stay inside the 3-agent cap.** Scheduled runs are guarded by `scripts/rss-guard.sh`, which
  kills any process over 4 GB and aborts the run past 12 GB — but the cap is what keeps you from
  getting there. If the log shows `[rss-guard] KILL`, say so in the digest: an agent was killed and
  its coverage is missing.
- If a channel isn't set up (LinkedIn cookie, Gmail MCP, WhatsApp), note it and continue.
- Keep it idempotent — the helpers dedupe, so a re-run won't double anything.
- **Report partial coverage explicitly.** If a market was skipped, a channel was unavailable, or a
  scout bailed, say which. A run that quietly covered half of what it claims is a failure.

End by telling me the three things waiting for me: **proposals to review**, **follow-ups due**, and
**approvals pending** — with the exact commands to act (`/apply <id>`, `/followup`).
