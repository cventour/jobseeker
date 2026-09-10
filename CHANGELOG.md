# What's new

Every release, in plain language. Newest first.

---

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
