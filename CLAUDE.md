# JobSeeker — project instructions

This repo is a local, Markdown-based job-search assistant (agents + a tiny dashboard). **Local
Markdown in `data/` is the source of truth.** All agent behavior rules are in
[`.claude/AGENT-RULES.md`](.claude/AGENT-RULES.md) — follow them.

## The "@jobseeker" front door

The user runs their whole job search through one handle: **`jobseeker`** (they may write `@jobseeker`,
`jobseeker,` or just ask something job-search-related). When they do:

- **Delegate to the `jobseeker` agent** (`.claude/agents/jobseeker.md`) for any single job-seeking
  request — checking email/WhatsApp/LinkedIn, finding/curating roles, researching vendors, prepping/
  submitting an application, drafting a follow-up, reconciling tasks, adding a task, or answering
  "what's my pipeline / what's due".
- For the **full unattended daily pipeline**, run the **`/job-run`** command (it fans out the
  specialists in parallel — a subagent can't, so this stays a main-session command).

Natural request → what to run:

| User says | Do |
|---|---|
| "jobseeker, check my email / any updates" | jobseeker agent → inbox-tracker playbook |
| "jobseeker, check WhatsApp/LinkedIn" | jobseeker agent → chat-tracker playbook |
| "find me roles" / "curate" | jobseeker agent → role-scout (or `/curate`) |
| "research <market> vendors" | jobseeker agent → prioritization-agent (or `/markets`) |
| "apply to <proposal>" | `/apply <id>` (interactive, approval-gated) |
| "follow up with X" | `/followup` (draft → approve → send) |
| "what's my pipeline / status" | jobseeker agent → `server/audit.mjs` + summarize |
| "close what I've already done" | jobseeker agent → reconciler playbook |
| "add task …" (plain English) | jobseeker agent → `record.mjs add-task` (parse date/who/type, keep raw detail) |
| "run my morning routine" | `/job-run` |
| "set me up" / "parse my CV" | `/onboard`, `/parse-cv` — or point them at the dashboard wizard (`/welcome`), which writes the same files |

## Hard rules (see AGENT-RULES.md for the full list)

- **Never guess a person's name from an email/handle — keep contact identifiers raw.**
- **Lead vs Application:** a sent CV or a referral is a **lead**; only mark an **application** with
  confirmation evidence (ATS/"we received your application"). Tag `channel` + `referrer`.
- **All state writes go through `server/record.mjs`** — never hand-edit `data/` tables. It locks
  `data/` and writes atomically, so parallel agents are safe; hand-edits alongside a run are not.
- **Chrome is a serial resource** — only ever one Chrome-driving agent at a time (AGENT-RULES §13).
- **Never send a message or submit an application without an approved approval.** Scheduled runs queue
  approvals; they never auto-apply or auto-send.
- **Personal settings live in `config/job-seeker.config.md` (gitignored), not in code or rules.**
  `company_aliases` folds an employer's alternate names into one canonical entry; `ignored_chats`
  lists group chats that must never be logged. Both are read automatically — never hardcode either.

## Dashboard

`npm run dashboard` → http://localhost:4319 (single Node file, no framework). View/edit only; agent
actions are the commands above.
