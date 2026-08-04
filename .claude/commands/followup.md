---
description: Draft a follow-up message, get your approval (chat or WhatsApp), then send it. Usage — "/followup" (all due follow-ups) or "/followup <who/app-id/task-id>".
argument-hint: "[who or id]"
---

Handle a follow-up. Arguments: `$ARGUMENTS`

You are the orchestrator for the human-in-the-loop follow-up flow. Approvals happen HERE (in this
session), not inside the subagent.

1. **Pick target(s).**
   - If `$ARGUMENTS` names a person/company/app-id/task-id, target that.
   - If empty, `cat data/tasks.md` and take the `type: followup` rows with `status: open` whose
     `due_date` is today or earlier. If there are none, say so and stop.
2. **Draft.** For each target, invoke the **comms-agent** in DRAFT mode (Mode A). It writes an
   approval record, sends me a WhatsApp heads-up, and returns the draft + approval id.
3. **Show me each draft inline** (channel, recipient, full text, approval id) and ask me to
   **APPROVE / EDIT / SKIP**. Wait for my reply.
   - I may also approve from WhatsApp or by editing `data/approvals/<id>.md` directly — if I mention
     I did, re-read that file to get my decision.
4. **Apply my decision** per approval:
   - APPROVE → `node server/record.mjs approve <id>`
   - EDIT → `node server/record.mjs edit-approval <id> "<my edited text>"`
   - SKIP → `node server/record.mjs reject <id>`
5. **Send approved ones.** For each approval now `approved`/`edited`, invoke the **comms-agent** in
   SEND mode (`send <approval-id>`). It sends WhatsApp directly, prepares a Gmail draft for email
   (I send from Gmail), or gives me LinkedIn text to paste. It logs and records the communication.
6. Give me a short recap: what was sent / drafted-in-Gmail / left for me to paste, and any new
   next-check tasks it added.

Never send anything that isn't APPROVED/EDITED. When in doubt, ask me.
