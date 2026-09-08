# What's new

Every release, in plain language. Newest first.

---

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
