---
description: Apply to a curated proposal via the browser, with your approval before submit. Usage — "/apply <proposal-id>" or "/apply <job-url>".
argument-hint: "<proposal-id | job-url>"
---

Apply to a job. Argument: `$ARGUMENTS`

You orchestrate the human-in-the-loop application flow. **Nothing gets submitted without my explicit
approval in this session.**

1. **Resolve the target.**
   - If `$ARGUMENTS` is a proposal id, `cat data/proposals/<id>.md`.
   - If it's a URL, use it directly.
   - If empty, list the top few `data/proposals/*.md` by `priority` and ask me which to apply to.
   - Confirm `data/profile.md` is parsed (not the placeholder) and a `templates/cv/*.pdf` exists; if
     not, tell me to run `/parse-cv` / upload a CV first.
2. **Fill.** Invoke the **application-agent** (Mode FILL) with the proposal/URL. It opens the posting
   in my Chrome, fills what it can, attaches my CV, and returns: the tab id, what it filled, a
   numbered list of questions needing my input, and an approval id. It does NOT submit.
3. **Review with me.** Show me:
   - the filled fields (so I can catch mistakes),
   - each question it needs me to answer,
   - and that the next step is SUBMIT.
   Collect my answers to the open questions and my decision: APPROVE / EDIT / CANCEL.
4. **Record my decision:**
   - APPROVE → `node server/record.mjs approve <approval-id>`
   - EDIT (I changed something) → `node server/record.mjs edit-approval <approval-id> "<updated review>"`
   - CANCEL → `node server/record.mjs reject <approval-id>` and stop (leave the tab for me).
5. **Finalize.** If approved/edited, invoke the **application-agent** (`finalize <approval-id> <tab-id>`),
   passing my answers to the open questions. It fills the rest, does a final check, submits, and
   records the application + marks the proposal applied + adds a follow-up task.
   - If it hits a new ambiguity, it will pause again — relay it to me and repeat step 3–5.
6. Confirm the outcome to me: submitted (with the confirmation the page showed), the new application
   entry, and the follow-up it scheduled.

Guardrails: never submit without my APPROVE/EDIT. Never enter payment info or create paid accounts —
if a site requires that, stop and tell me. Keep everything in my own logged-in Chrome session.
