---
description: Update the job tracker from Gmail, Calendar, and your WhatsApp Web + LinkedIn messages (runs inbox-tracker and chat-tracker in parallel).
---

Update my job-search tracker from all my channels.

Run these two subagents **in parallel** (launch both in a single message, two Agent tool calls):

1. **inbox-tracker** — scan Gmail + Calendar and update `data/` (applications, communications,
   interviews, follow-up tasks).
2. **chat-tracker** — read my personal WhatsApp Web + LinkedIn messages via my logged-in Chrome
   (read-only, job-related only) and update `data/` (conversations, follow-up flags). This needs
   Chrome open and logged in; if it isn't, it'll tell me and skip.

These two are safe to run together: one uses the Gmail MCP and the other uses Chrome, so they don't
contend for the browser (AGENT-RULES §13 — Chrome is a serial resource, only ever one agent on it).
Both write only through `server/record.mjs`, which locks `data/` and writes atomically, so their
concurrent writes cannot clobber each other. When both finish, give me a short combined summary:

- new / updated applications and any status changes
- interviews found or scheduled
- follow-ups that now need my attention (who + channel + why)
- anything needing a decision (an offer, a rejection, an interview to schedule)

Do not send any messages or take any outward action — this is read-and-record only. If either
channel isn't available (Chrome not logged into WhatsApp/LinkedIn, or Gmail MCP not connected),
note it briefly and continue with the other.
