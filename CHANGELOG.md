# What's new

Every release, in plain language. Newest first.

Technical detail lives in the commit history; this file is for deciding whether a release is worth
downloading.

---

## v0.4.0 — 30 August 2026

- **JobSeeker now tells you when a run only half worked.** Before, a run that could not reach Chrome
  would find no roles, read none of your messages, and still report success. It now says which part
  did not happen, and why.
- **Improved scheduling to reduce the cost of usage.** If you stop reviewing the roles it finds,
  JobSeeker slows itself down instead of searching every day for a list nobody is reading — daily,
  then twice a week, then weekly. It warns you in the dashboard before each change, and one button
  puts it back.
- **It stops entirely if you stop using it.** After two weeks with no activity at all, the daily run
  switches itself off and tells you it has, rather than quietly costing money.
- **A run that produced no summary is now reported as failed.** It used to count as a success.

## v0.3.0 — 27 August 2026

- **You no longer need a terminal to install it.** Download, unzip, double-click. A setup window
  checks your Mac and opens JobSeeker in its own window.
- **A setup wizard replaces the old command-line questionnaire.** Six questions, three of which you
  can skip — and each skip tells you exactly what you lose by skipping it.
- **Approve or reject messages from the dashboard.** Drafts used to be visible there but could only
  be approved elsewhere. Now you read the message and decide in the same place.
- **Run it on demand.** Buttons on Today for reading your channels, finding roles, or drafting
  follow-ups, without waiting for the morning run.
- **Choose which days it runs**, not just what time.
- **Change one thing later without redoing setup** — replacing your CV shows you what it is about to
  overwrite.
