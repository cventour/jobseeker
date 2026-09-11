Fill the application form for `$ARGUMENTS`, then stop. **You never submit it. The user does.**

This is the dashboard's Apply button. It runs unattended, so there is nobody to answer a question
mid-way — which is exactly why it stops at a filled form instead of trying to finish one.

1. **Resolve and check.**
   - `cat data/proposals/$ARGUMENTS.md`. If there is no such file, say so and stop.
   - It needs a `job_url`. Without one there is nothing to open — say so and stop.
   - `data/profile.md` must be parsed (not the "No CV parsed yet" placeholder) and a
     `templates/cv/*.pdf` must exist. If either is missing, stop and say which — filling a form from
     a placeholder profile produces a worse application than filling it by hand.
2. **Fill.** Invoke the **application-agent** in **Mode FILL** with the proposal id.
   It opens `job_url` in the user's own Chrome, fills what it can from `data/profile.md` and
   `templates/answers.md`, and attaches the CV.
   - **Tell it explicitly: do NOT create an approval record, and do NOT submit.** The approval in
     Mode FILL exists for the interactive `/jobseeker apply` flow, where a session is held open to finalise it.
     Here nothing is held open, so an approval would sit pending forever with nothing able to act on
     it. This run ends with a filled form and an open tab, nothing more.
   - **Leave the tab open.** It is the user's browser; the tab is the deliverable.
3. **Hand it back.** Add ONE task so the half-finished form cannot be forgotten
   (AGENT-RULES §11b — one action, one line, 200 characters):

   `node server/record.mjs add-task '{"type":"apply","who":"<Company>","related_id":"<proposal id>","due_date":"<today>","detail":"Review and submit the <Company> <Role> form — filled and open in Chrome"}'`

4. **Log what happened**, including the questions you could not answer, so the user knows what to
   look at before submitting:

   `node server/record.mjs log apply-fill "<Company> — <Role>: filled <n> fields, <m> left for the user (<the questions>)"`

5. **Report**: which fields you filled, which you left blank and why, and that the tab is open and
   waiting. Say plainly that nothing has been submitted.

Guardrails: never submit. Never enter payment details, never create a paid account, never accept
terms on the user's behalf — if the form demands any of those, stop, leave the tab, and say so.
Never invent an answer to a question the profile does not cover: leave it blank and name it in the
log, because a confidently wrong answer on an application is worse than an obvious gap.
