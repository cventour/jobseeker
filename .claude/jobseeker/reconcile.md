Close the open tasks I have already done. Arguments: `$ARGUMENTS` (none expected)

Launch the **reconciler** agent (one Agent tool call; do not pass `model`). It reads every open task
in `data/tasks.md` and all of `data/communications.md`, and closes a task only when evidence on some
channel proves it is done: a WhatsApp referral fulfilled by a sent email, an interview confirmed by a
calendar invite, and so on. Do not do this inline yourself. It is a large read and belongs in its
own context (AGENT-RULES §9).

Its evidence is only as fresh as `data/communications.md`, which `/jobseeker track` fills. Do not run
a track pass yourself. If the newest row there is more than a day old, say so in one line and
suggest `/jobseeker track` first.

When it returns, give me its report as it stands:

- **Closed**: each task id, with the evidence that closed it (channel, date, who)
- **Uncertain**: tasks with partial evidence, and what would settle each one
- **No trace**: open tasks with nothing on any channel (these stay open)

Nothing is sent and nothing outside `data/tasks.md` changes. The reconciler writes only through
`server/record.mjs complete-task`.
