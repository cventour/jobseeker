# What's new

Every release, in plain language. Newest first.

---

## Unreleased

- One command for everything: `/jobseeker` followed by what you want. `/markets Fintech` is now `/jobseeker markets Fintech`, `/curate` is `/jobseeker curate`, `/job-run` is `/jobseeker job-run`, and so on for track, apply, apply-fill, followup, send-approval, onboard and parse-cv. The old names are gone. `/jobseeker` on its own lists them all and shows where your search stands.
- Each part of JobSeeker now runs on the model it is set to, however you reach it. Reading your mail and chats, researching markets, closing finished tasks and checking the tracker use Claude Sonnet. Scoring roles, filling applications and writing messages in your voice use Claude Opus. Before, asking "jobseeker" to research a market ran it on whatever model your session was using.
- "jobseeker" in plain English still answers what is due, adds tasks and marks things done. For anything bigger it now tells you which `/jobseeker` command to run instead of doing the work itself.

---

## v0.7.6 — 11 September 2026

- A run no longer fills Chrome with tabs. Reading forty careers pages opened forty tabs; it now opens one, moves that one from page to page, and closes it at the end. Looking through LinkedIn jobs and filling in an application work the same way: one tab, reused, closed when it is finished with.
- Tabs you opened yourself stay yours. A WhatsApp Web or LinkedIn tab that is already open is read where it sits and never sent anywhere else — moving that tab is what would cost you your WhatsApp session — and JobSeeker's Chrome extension now refuses to steer or close any tab it did not open itself.
- On Windows, reload the JobSeeker Bridge extension (it is now version 0.3.0) to get this. Until you do, everything still works exactly as before, one tab per page.
- Fixed: researching a market could run, cost money and save nothing. When JobSeeker ran Claude Code in the background, Claude Code was refused permission to search the web or save a file — and still reported success. Background runs are now allowed exactly the things they need and nothing more: they can read your mail and prepare drafts, but sending anything still waits for your approval.
- Fixed: the daily run could stop partway through and never write its digest. Claude Code gives up on work still running after about ten minutes; the daily run now waits for its own 45-minute limit, and the dashboard's buttons get thirty minutes.
- Fixed: a list of markets pasted with semicolons — "Economic Development; Exporting; Trade" — was saved as one market with a long name. It is now three separate markets, and a list already saved that way is split up the first time this version starts.
- Added a Problems filter to Activity. When a run, a market search, reading your CV or sending an approved message fails, it now says so there in plain words — what went wrong and what to do about it — instead of reporting "ok" and leaving the page empty.
- Researching a market is now only called finished when the list actually has companies in it. A run that ends with nothing saved says so, and is recorded in your spending as a failed run rather than a successful one.
- Market research now uses Claude Sonnet rather than the most expensive model. It is search-and-summarise work, and one run had spent its whole $5 budget in three steps.

---

## v0.7.5 — 10 September 2026

- Not now on the new-version dialog is an answer again. Yesterday it became Later and came back the next day; being asked the same question every morning is how an offer turns into noise, so a version you have said no to stays said no to. A newer release still asks, because that is a different question — and the offer is never lost by declining it: Settings carries it, with the same Update button.
- Fixed: an old Windows script left over from before JobSeeker could update itself would have installed 0.6.0 over a newer version. It fetched a development branch instead of a release and never checked what version it was about to write. It is gone — the Update button and `npm run update` are the ways to update.

---

## v0.7.4 — 10 September 2026

- Fixed: a run could report "finished" and leave every page empty. The daily run already knew it had produced nothing — it records that for itself — but the "Run now" line beside the button read only whether the run had crashed, and a run that finishes empty does not crash. It now says what the run itself concluded, so "finished" means finished.
- A run that failed now lists what it could not do, in the same words as a run that only partly worked, and stops repeating the Chrome message underneath itself.
- A run you started by hand is no longer described as a scheduled one.
- Fixed: **Research this market now** could do nothing at all, silently. It looked for Claude Code only on the bare list of places a program inherits when JobSeeker is opened as an app — which is not where Claude Code installs itself — and then stopped before spending anything. Everything else here already looked in the right places; this one button did not.
- Researching a market now reports how it ended, on the Companies page: still running, finished, refused because something else was running, or failed and why. Until now the page promised the companies would appear on reload and then never mentioned it again.
- Researching a market now waits its turn instead of starting on top of a run already in progress. Two of them in the same Chrome read each other's tabs.
- Fixed: the CV step could say "That file could not be read" about a CV it had read perfectly well. A CV parsed any other way — `/parse-cv` in chat, for instance — left the earlier failure sitting there, and it was the failure that got shown.
- The CV step now shows what was actually read out of your CV — the titles, seniority and domains it found. That box has been empty since it was added.
- Problem reports now include the market research log, which was the one log they left out.
- Fixed: updating could stop with "the dashboard is still answering on port 4319 — nothing was changed" and leave you on the old version. JobSeeker only knew how to stop a dashboard it had started itself, so one you had started any other way was never asked to quit.
- The update log now says whether JobSeeker was actually running, what was stopped, and — if something is still holding the port — which program it is.
- Fixed: on Windows, the check that JobSeeker had really stopped never recognised your own install, so an update could replace the files while it was still running. It now checks properly, and stops what is holding the connection first.
- Fixed: **Not now** on the new-version dialog silenced that version for good, so an install told once could sit several releases behind and never be asked again. It is now **Later**, and it means later — the offer comes back the next day, and a newer version always asks.
- **Check for updates** in Settings now shows you the new version and what is in it, instead of a message telling you to find a button on a page it was not on. The dialog appears on Settings as well as on Today.
- A dashboard left open now notices a new version by itself, rather than waiting for you to reload the page.
- Release notes inside the update dialog no longer show their raw formatting marks, and are sorted into New, Changed and Fixed by what they say rather than by the punctuation they start with.
- Fixed: on Windows, two of JobSeeker's own scripts were missing a marker PowerShell needs to read them as UTF-8, so dashes and accented characters in their output came out as gibberish.

---

## v0.7.3 — 10 September 2026

- **Report a problem** is now a bug icon at the top right of every page, not a button buried in Settings. Write what went wrong and JobSeeker saves one file into your Downloads folder for you to email.
- A report can include a picture of the page you were on, if you tick the box and confirm you are happy with what is in it. The picture is drawn from the page itself, so it shows the tab, the filter and the theme you were actually looking at — and nothing outside the JobSeeker window.
- Reports carry the same log file `npm run logs` writes, so they answer the same questions: which Claude Code it found, what the updater did, whether the app was rebuilt.
- Company and contact names from your own tracker are now masked in those logs. Until now only things recognisable by shape, like an email address, were replaced — the companies you are chasing went out in the clear.
- Fixed: your computer's username was in every log report, in the line listing what is using the port, even though the file says your home folder name is replaced.
- Nothing is sent anywhere. The dialog gives you the file and the address to send it to; you attach it and send it yourself.
- Settings in the header is now a gear icon, matching the other two buttons beside it.
- Status pills in the Pipeline and Jobs tables are readable in the light theme again — they were dark text on a dark badge.

---

## v0.7.2 — 10 September 2026

- Added a Report a problem button to Settings. It writes one file to your Desktop with everything needed to explain what went wrong, and shows you the file. Your CV, your profile and your contacts are not in it.
- That report now also says what the updater did and whether the app was rebuilt — the two things that explain "I updated and nothing changed".

## v0.7.1 — 10 September 2026

- Fixed: "choose a file" and "Try another file" did nothing on the CV step when JobSeeker was opened as an app rather than in a browser. The window it draws in cannot show a file chooser, so JobSeeker now opens your Mac's own one instead. Dragging a CV onto the page always worked and still does.

## v0.7.0 — 10 September 2026

- JobSeeker now updates itself. When a new version is out it tells you, shows you what changed, and updates on your say-so. Your CV, your settings and your tracker are never touched.
- When your CV cannot be read, JobSeeker now says why. It used to blame the file every time — even when the real reason was an expired Claude login, no credit left, or no internet.
- Fixed: JobSeeker could not find Claude Code when it was opened from the app icon rather than from a terminal, and reported it as missing even though it was installed.
- Trying a second CV now visibly does something. The screen showed nothing at all while the new file was read, so it looked as though the link were broken.
- Settings now shows which version of JobSeeker you are on, in the corner of the page, with a Check for updates link beside it — so you do not have to wait for the twice-daily check.
- Added a way to update an older JobSeeker that has no Update button yet, without reinstalling and without losing anything. Run `npm run update` and it fetches the new updater and uses it.
- Added a way to send a bug report. Run `npm run logs` and JobSeeker writes one file to your Desktop with everything needed to explain what went wrong — your CV, your profile and your contacts are left out of it.

## v0.6.0 — 8 September 2026

- JobSeeker now runs on Windows 10 and 11, as well as on a Mac.
- Added a one-line install for Windows. Paste it into PowerShell and a setup window opens, the same way it does on a Mac.
- Setup on Windows installs Node, Git, Claude Code and, if you want it, Chrome — after showing you each one first.
- Added Start Menu and Desktop shortcuts on Windows, including one to quit JobSeeker.
- The daily run can now be scheduled on Windows. It wakes the PC at the time you set, as long as you are logged in.
- Added a small Chrome extension so JobSeeker can read your WhatsApp and LinkedIn tabs on Windows. You load it once and connect it with a six-digit code from Settings.
- Reading company careers pages on Windows is a separate permission you grant to the extension, so it only sees those pages if you say so.
- Nothing changes on a Mac.

## v0.5.0 — 7 September 2026

- Added a user friendly installer. One command, no download, no security warning to click through.
- Added a setup window that walks you through the install, instead of a Terminal script.
- Setup now installs Node, Claude Code and Chrome for you if you do not already have them.
- JobSeeker is now a Mac app. It sits in your Applications folder and quits like any other app.
- Added a light/dark mode switch, with autodetection of your Mac's setting.
- Added WhatsApp setup to the wizard, including the pairing code and the steps for your phone.
- Added a first-run tour of the dashboard.

## v0.4.0 — 30 August 2026

- Runs now report when part of the work did not happen. Before, a run could fail to read your messages and still report success.
- Improved scheduling to reduce the cost of usage. If you have not accessed the dashboard for a few days the automated runs will slow down. You will be warned when it happens on the dashboard.
- Automated runs stop completely after two weeks with no activity, and the dashboard tells you.
- A run that produces no daily summary is now reported as failed.

## v0.3.0 — 27 August 2026

- Install without a terminal. Download, unzip and double-click.
- A setup wizard replaces the old command-line questions. Six steps, three of them optional.
- Approve or reject messages on the dashboard, where you read them.
- Run a search, a channel check or your follow-ups on demand, instead of waiting for the morning run.
- Choose which days the automated run happens, not just the time.
- Replace your CV or change one setting later without repeating setup.
