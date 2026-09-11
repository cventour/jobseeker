Check my tracker for problems. Arguments: `$ARGUMENTS` (none expected)

Launch the **supervisor** agent (one Agent tool call; do not pass `model`). It runs
`node server/audit.mjs "$(date +%F)"` and turns the result into a short report: whether the last
scheduled run failed, duplicates and overlaps, pending approvals, overdue follow-ups and stale
markets. It is read-only and changes nothing.

When it returns, give me its report as it stands: run health first if the last run failed, then
health counts, what needs my decision, cleanups (with exact ids), and what is overdue.

Do not act on its recommendations yourself. For each one, name the command that does it
(`/jobseeker reconcile`, `/jobseeker markets <market>`, `/jobseeker followup <who>`, approving on the
dashboard) and let me choose.
