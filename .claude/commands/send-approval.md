---
description: Send one message you have already approved. Usage — "/send-approval appr_xxxxxx". Refuses anything not already approved or edited.
argument-hint: "<approval-id>"
---

Send the approved message in `data/approvals/$ARGUMENTS.md`.

This command exists so the dashboard can finish what it started: you press Approve there, and this
is what actually delivers the message. It is normally invoked by `scripts/send-approval.sh`, never
by you directly.

1. `cat data/approvals/$ARGUMENTS.md`.
2. **Stop unless `status:` is `approved` or `edited`.** Say which status you found and stop. Do not
   ask the user to approve it now — a send that talks its way past the gate is the one failure this
   whole mechanism exists to prevent.
3. **Stop if `dispatch:` is already `sent` or `running`.** The message has gone (or is going). Say
   so and stop.
4. **Stop if `kind:` is `apply`.** An application is filled in a live browser session by
   `/apply`; there is nothing here to send.
5. Otherwise invoke the **comms-agent** in SEND mode: `send $ARGUMENTS`. If `status:` is `edited`,
   the edited preview body is the text to send — that is the user's wording, not the draft's.
6. Report in one line what happened: sent on WhatsApp / prepared as a Gmail draft / left for the
   user to paste into LinkedIn, and to whom.

The wrapper script records the outcome (`record.mjs approval-dispatch`), so do not set `dispatch:`
yourself. The comms-agent still logs the communication row, as it does on every send.
