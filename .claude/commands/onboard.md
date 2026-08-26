---
description: First-run setup for the job-seeker agents — a short questionnaire that captures your target markets, roles, locations, application answers, and preferences, then writes them where the agents read them. Run this once before /markets, /curate, /track.
---

You are the onboarding guide. Interview me and then write my answers into the files the agents
read.

**There is now a wizard that does this in the dashboard** (`npm run dashboard`, which opens on
`/welcome` for a machine that has never been set up). It asks the same questions and writes the same
files, so the two are interchangeable and neither is authoritative over the other. If I have not
said I prefer the terminal, mention it once — then carry on here if I want to. Be efficient — **batch questions** (don't ask them one at a time), confirm sensible defaults
rather than interrogating, and skip anything I've clearly already set.

## 0. Check current state (read-only first)
- `cat data/criteria.md config/job-seeker.config.md 2>/dev/null` and `ls templates/cv/*.pdf 2>/dev/null`
  and check whether `data/profile.md` is still the "No CV parsed yet" placeholder.
- If criteria/config already look customized, tell me what's set and ask if I want to update or keep.

## 1. Ask me (group these; use multiple-choice where it helps, free-text otherwise)

**Targeting** (→ `data/criteria.md`):
- **Markets / industries** I'm targeting (e.g. Cybersecurity, Fintech) — comma list.
- **Target roles** (e.g. Product Management, Solution Architect) — comma list.
- **Locations** (e.g. Dubai/UAE, Remote) — comma list.
- **Seniority** (e.g. Senior, Principal, Director).
- Ranking weights — offer the defaults (market 0.4 / role 0.35 / CV 0.25) and only change if I ask.

**Application answers** (→ `templates/answers.md`; reused when filling forms):
- Work authorization / visa status
- Notice period
- Salary expectation (or "open / discuss")
- Years of experience (or "derive from CV")
- Willing to relocate? (and where)
- "How did you hear about us" default (e.g. LinkedIn)
- A 2–3 sentence elevator pitch (offer to draft it from my CV after /parse-cv if I'd rather)

**Personal settings** (→ `config/job-seeker.config.md`; gitignored, so these never reach a public
repo — that is exactly why they are configured rather than hardcoded):
- **Chats to ignore** (`ignored_chats`) — group communities, family threads, anything the chat sweep
  must never log. Comma list, matched as a case-insensitive prefix on the chat name. Ask for these
  explicitly: the sweep reads a PERSONAL WhatsApp, and this is the user's control over what it may
  record.
- **Company aliases** (`company_aliases`) — `from=Canonical` pairs, so one employer known by two
  names (an acquisition, a rebrand, an agency trading name) does not become two records.
  e.g. `acquiredco=Parent Company`.

**Preferences** (→ `config/job-seeker.config.md`):
- Approval channels — WhatsApp, chat, or both (default both).
- WhatsApp owner number/JID for approvals + the daily digest (optional; can leave blank).
- Apply stop-points — confirm the default (`unknown_question, submit`) or adjust
  (options: each_section, file_upload, unknown_question, submit).
- Daily run time for the scheduler (default 08:00).
- Enable LinkedIn tracking? (default yes; needs the local cookie set up separately.)

## 2. Write the files

**`data/criteria.md`** (overwrite, exact shape; put my free notes under `# Notes`):
```
---
markets: <csv>
roles: <csv>
locations: <csv>
seniority: <csv>
weight_market: 0.4
weight_role: 0.35
weight_cv: 0.25
---

# Notes

<anything I said about what I'm looking for>
```

**`config/job-seeker.config.md`** — `cat` it first, then rewrite it updating only these keys and
preserving the rest: `approval_channels`, `whatsapp_owner_jid`, `apply_stop_before`,
`linkedin_enabled`.

**Do NOT write a `schedule_job_run` key.** It used to exist and nothing read it — the real
schedule lives in the launchd plist. Set the time with `scripts/set-schedule.sh HH:MM`, or point me
at the dashboard's Setup page, which does the same thing.

**`templates/answers.md`** (overwrite; this file is gitignored):
```
# Application answer library

| question_pattern | answer |
|------------------|--------|
| work authorization / visa | <ans> |
| notice period | <ans> |
| salary expectation | <ans> |
| years of experience | <ans> |
| willing to relocate | <ans> |
| how did you hear about us | <ans> |

<elevator pitch paragraph>
```

Then log it: `node server/record.mjs log onboard "Onboarding complete: markets=[…] roles=[…]"`.

## 3. Browser access — confirm setup was run

Gmail and Calendar work over MCP with no setup. **Reading WhatsApp Web and LinkedIn needs Chrome**,
and that is handled entirely by `npm run setup` — do not restate its steps here, or the two will
drift.

- Ask whether they have run `npm run setup`. If not, tell them to run it in a terminal now; it
  installs the browser agent and walks through the permissions.
- Then verify for yourself rather than taking their word for it:

```
npm run browser:probe
```

Expect `read-pages=apple-events` with no blockers. If a blocker is listed, relay it **verbatim** —
each one is written as the exact fix. Full reference: `docs/PERMISSIONS.md`.

## 4. CV
- If no `templates/cv/*.pdf` exists: tell me to open the dashboard (`npm run dashboard`), go to the
  **CV** section, and upload my PDF — then come back and run `/parse-cv`.
- If a PDF exists but `data/profile.md` is the placeholder: offer to run `/parse-cv` now.

## 5. Wrap up
Confirm what you wrote (markets, roles, locations, stop-points, channels), and give me the exact
next steps in order: **upload+`/parse-cv` → `/markets` → `/curate` → `/track`**, and that `/job-run`
does the whole loop. Note that applying and sending always ask me first.

Rules: only write the three files above (and the activity log). Don't invent answers — if I skip a
field, leave it blank/default and say so. Confirm before overwriting anything already customized.
