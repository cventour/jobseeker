---
description: The one JobSeeker command — "/jobseeker <subcommand> [args]". markets, curate, track, apply, apply-fill, followup, send-approval, reconcile, check, job-run, onboard, parse-cv. Each specialist runs on its own model. "/jobseeker" alone lists them and shows your pipeline.
argument-hint: "<subcommand> [args]"
---

JobSeeker command. Arguments: `$ARGUMENTS`

**Follow `.claude/AGENT-RULES.md` at all times.**

## 1. Route

The first word of the arguments is the **subcommand**; everything after it is the subcommand's own
arguments (call them *ARGS*, possibly empty).

| Subcommand | ARGS | What it does |
|---|---|---|
| `markets` | `[add] [market name]` | Build or refresh the ranked vendor list per market (prioritization-agent, one per market) |
| `curate` | `[market name]` | Find live openings at the prioritized companies and write ranked proposals (role-scout, one per market) |
| `track` | | Update the tracker from Gmail, Calendar, WhatsApp Web and LinkedIn (inbox-tracker + chat-tracker) |
| `apply` | `<proposal-id \| job-url>` | Apply to a proposal in Chrome, approval before submit (application-agent) |
| `apply-fill` | `<proposal-id>` | Fill an application form and STOP; you review and submit (application-agent) |
| `followup` | `[who or id]` | Draft a follow-up, get approval, then send (comms-agent) |
| `send-approval` | `<approval-id>` | Send one message you have already approved (comms-agent) |
| `reconcile` | | Close open tasks that another channel proves are already done (reconciler) |
| `check` | | Audit the tracker: failed runs, duplicates, pending approvals, overdue, stale markets (supervisor) |
| `job-run` | `[deep]` | The full daily pipeline; queues approvals, sends nothing |
| `onboard` | | First-run questionnaire: markets, roles, locations, answers, preferences |
| `parse-cv` | | Parse `templates/cv/*.pdf` into `data/profile.md` |

- **Known subcommand** → Read `.claude/jobseeker/<subcommand>.md` and follow it exactly. Wherever
  that playbook says `$ARGUMENTS`, it means *ARGS*, not the full argument string above.
- **Empty, `help`, or anything not in the table** → print the table above (one line per
  subcommand), then a short pipeline status: run `node server/audit.mjs "$(date +%F)"` and summarise
  applications vs leads, what is at interview, follow-ups due, and pending approvals. If the word was
  not empty and not `help`, say first that it is not a subcommand and suggest the closest one. Do
  nothing else.

## 2. Every specialist runs on its own model

This command exists so each specialist gets its own tier (AGENT-RULES §16). That only holds if the
work actually goes to the specialist:

- When a playbook names an agent (`prioritization-agent`, `role-scout`, `inbox-tracker`,
  `chat-tracker`, `reconciler`, `supervisor`, `comms-agent`, `application-agent`), **spawn it with the
  Agent tool**. Never read its agent file and do the work yourself in this context. That would run
  it on this session's model instead of its own.
- **Do not pass `model`** when spawning. Each agent's frontmatter declares its tier. The one
  exception is written into `job-run.md`: the `deep` pass raises `prioritization-agent` to `opus`.
- `onboard` and `parse-cv` name no agent; they run here, in this session.
