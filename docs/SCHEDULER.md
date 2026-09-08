# Local scheduler — daily job-run

The daily pipeline runs **locally on your own machine** — launchd on a Mac, Task Scheduler on
Windows. It runs `/job-run` headless, which
**tracks → prioritizes → curates → supervises → sends you a digest**. It **queues** anything
needing approval — it never applies or sends on its own.

### What runs headless (verified)
- ✅ **Gmail + Calendar** (`inbox-tracker`) — your Claude connectors are available to the headless
  `claude` CLI, so email/interview tracking works unattended.
- ✅ **Prioritization + curation** (web research) and the **supervisor** audit — no session needed.
- ✅ **Digest** to the log (and WhatsApp if the channel is reachable).
- ❌ **`chat-tracker`** (WhatsApp Web + LinkedIn via Chrome) — needs your **visible, logged-in
  Chrome**, so it does **not** run headless. Read those with an interactive `/track` when you're at
  your machine.

### Failure handling (built into `scripts/job-run.sh`, and its twin `scripts/win/job-run.ps1`)

An unattended run that dies is invisible — you just notice the digest never arrived. So the
entrypoint:

- **times out** after 45 min (`JOBRUN_TIMEOUT_SECS`) rather than hanging indefinitely,
- **retries once** (`JOBRUN_ATTEMPTS`), since most failures here are transient (network, or MCP
  servers not yet awake after a boot),
- **caps spend** at $5 (`JOBRUN_MAX_BUDGET_USD`) via `claude --max-budget-usd`,
- **guards memory** with `scripts/rss-guard.sh` — `scripts/win/rss-guard.ps1` on Windows (see below),
- writes **`data/.job-run.status.json`** (`state`, `started`, `finished`, `attempts`), which
  `server/audit.mjs` reports as `last_scheduled_run` — so the **supervisor tells you in the next
  digest if the previous run failed**,
- raises a **macOS notification, or a Windows toast,** on final failure,
- clears a stale `data/.lock` left behind by a killed run (it also self-heals after 60s).

Override any of these in the launchd plist's `EnvironmentVariables` (macOS), e.g. a longer timeout:

```xml
<key>JOBRUN_TIMEOUT_SECS</key><string>3600</string>
```

Check the last run at any time:

```bash
cat data/.job-run.status.json
```

### Memory guard (`scripts/rss-guard.sh`, `scripts/win/rss-guard.ps1`)

On **2026-07-29** an interactive run fanned out 7 subagents at once. Three extra `claude` processes
appeared next to the session and grew at a steady **~14.5 MB/s each** while using essentially no
CPU — within 17 minutes they held **15.9 GB, 12.0 GB and 6.1 GB**. Machine-wide resident memory hit
**48.9 GB on a 16 GB M1**, WindowServer's watchdog timed out and the kernel's jetsam killer took the
laptop down. The session itself never exceeded 458 MB, and nothing in this repo leaks, so the guard
does not try to fix the leak — it makes sure it can never reach the desktop again.

Every attempt is watched. The guard walks the process tree under the `claude` child and:

- **SIGTERMs any single descendant over 4 GB** (`JOBRUN_GUARD_MAX_RSS_MB`), then SIGKILLs after 10s,
- **aborts the attempt** if the whole tree passes 12 GB (`JOBRUN_GUARD_TOTAL_RSS_MB`) — the retry
  then gets a clean run instead of the kernel choosing what to kill.

It only ever touches processes inside that tree, so your other Claude Code sessions are safe. Set
`JOBRUN_GUARD=0` to disable it. Anything it does is logged to `data/.job-run.log` as `[rss-guard]`.

For a **long interactive session** (which is where the crash actually happened), run it by hand
against that session's pid:

```bash
npm run guard -- $(pgrep -n claude)     # aborts the session if its tree passes 12 GB
GUARD_ABORT_ROOT=0 npm run guard -- <pid>   # log-and-kill-children only, never the session
```

The real protection, though, is the **3-subagent cap in AGENT-RULES §13** — the guard is a backstop
for when something leaks anyway.

## Prerequisites
- Claude Code CLI (`claude`) on your PATH. Check: `command -v claude`.
- You've run the dashboard once and have `data/` populated (`npm run dashboard`).
- Your Mac is awake at the scheduled time (or use `pmset`/wake schedules). On Windows the task is
  registered with **WakeToRun**, so it wakes the PC itself — but only if you are still logged in.
- **On macOS, the scheduled run has its own Automation grant.** This one catches people out, so it is
  worth doing deliberately — see below. On Windows there is no grant; the Chrome extension has to be
  paired instead ([`PERMISSIONS.md`](PERMISSIONS.md)).

### Grant the scheduled run permission to use Chrome (macOS)

macOS keys Automation permission to the **responsible process**, not to `node`. Interactively that is
Claude Code; under launchd it is `/bin/bash`. They are two independent grants, so approving the
prompt while you are sitting at the Mac does **not** cover the 08:00 run.

The consequence is a silent one: at 08:00 a consent dialog appears with nobody to click it, the Apple
Event times out, and WhatsApp and LinkedIn simply go unread. The run still reports `ok`.

Clear it once, while you are at the keyboard:

```bash
launchctl start com.jobseeker.jobrun
```

Click **Allow** when prompted (for both **Google Chrome** and **System Events**). The grant is then
permanent for the scheduler. Note this runs the full pipeline, not just a permission check.

Verify at any time:

```bash
npm run browser:probe     # expect: read-pages=apple-events, no blockers
```

If the probe reports `prompt-pending`, that is exactly this situation. Full detail, including what is
*not* required (no Screen Recording, Accessibility or Full Disk Access), is in
[`PERMISSIONS.md`](PERMISSIONS.md).

## Changing the time

```bash
npm run schedule -- 09:15        # move the daily run
npm run schedule -- 09:15 1,4    # only on the named days (0 = Sunday … 6 = Saturday)
npm run schedule -- --show       # what is actually configured, read back from the OS scheduler
npm run schedule -- --remove     # unschedule
```

That runs `scripts/set-schedule.sh` on a Mac and `scripts\win\set-schedule.ps1` on Windows —
`server/platform.mjs` picks the twin, and both take the same arguments and print the same lines
(`not scheduled`, `09:15`, or `09:15 1,4`). Do not call either script by name.

The dashboard's Setup page calls the same script. **The OS scheduler is the only source of truth for
the schedule** — the launchd plist on macOS, the Task Scheduler task on Windows. There was once a
`schedule_job_run` key in the config file that nothing read — setting it changed nothing and warned
about nothing. It has been removed rather than wired up, so there is one place to look.

## Option A — launchd (recommended on macOS)

> **`npm run setup` can do all of this for you**, including substituting the paths and clearing the
> separate Automation grant that the scheduled run needs. It asks first, because scheduling a daily
> job that reads your mail and messages should never be a silent side effect. The manual steps below
> remain the reference.

1. Make the entrypoint executable:
   ```bash
   chmod +x scripts/job-run.sh
   ```
2. Create your plist from the template, filling in the placeholders:
   ```bash
   REPO="$(pwd)"
   sed -e "s#__REPO__#$REPO#g" -e "s#__PATH__#$PATH#g" \
     scripts/com.jobseeker.jobrun.plist.example \
     > ~/Library/LaunchAgents/com.jobseeker.jobrun.plist
   ```
   (Adjust the `Hour`/`Minute` in that file for your preferred time — default 08:00.)
3. Load it:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.jobseeker.jobrun.plist
   ```
4. Test it immediately (doesn't wait for the schedule):
   ```bash
   launchctl start com.jobseeker.jobrun
   tail -f data/.job-run.log
   ```
5. To stop/remove:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.jobseeker.jobrun.plist
   ```

## Option B — cron
```bash
crontab -e
# add (runs 08:00 daily):
0 8 * * * /bin/bash /ABSOLUTE/PATH/TO/JobSeeker/scripts/job-run.sh
```

## Option C — Task Scheduler (Windows)

> **`npm run setup` can do this for you**, and so can the dashboard's Setup page. The detail below is
> the reference for what they register.

```powershell
npm run schedule -- 08:00        # every day at 08:00
npm run schedule -- 08:00 1,4    # Mondays and Thursdays only
npm run schedule -- --show
npm run schedule -- --remove
```

That registers one Task Scheduler task, **`\JobSeeker\JobRun`**. Its action is
`wscript.exe scripts\win\run-hidden.vbs scripts\win\job-run.ps1`, run from the repository — the
`.vbs` wrapper is there only so no console window flashes up.

Every day is a **Daily** trigger; named days become one **Weekly** trigger carrying a days-of-week
mask, so there is a single task either way, not one per weekday.

The task's settings:

- **WakeToRun** — the PC wakes from sleep for the run.
- **StartWhenAvailable** — a run missed while the machine was off happens at the next opportunity.
- **Interactive logon principal, limited run level** — so it runs **only while you are logged in**,
  the same limitation a macOS LaunchAgent has. It never runs at the login screen, and it never asks
  for administrator rights.
- One instance at a time (`IgnoreNew`), a two-hour execution limit, and it is allowed to start and
  continue on battery.

Inspect or delete the task by hand in **Task Scheduler** (`taskschd.msc`) under
*Task Scheduler Library ▸ JobSeeker*, or with `schtasks /Query /TN JobSeeker\JobRun`.

Task Scheduler cannot set per-task environment variables, so nothing is passed in: `job-run.ps1`
finds the repository from its own location and locates `node` and `claude` itself. Override the
tunables above by setting them in your user environment instead of in the task.

Logs are the same as on macOS: `data/.job-run.log` and `data/.job-run.status.json`.

## What you'll see each morning
- A WhatsApp + chat **digest**: new proposals, follow-ups due, pending approvals, anything needing a
  decision.
- On the dashboard (`npm run dashboard`): ranked proposals and due follow-ups waiting.
- Then you act when ready: `/apply <proposal-id>` and `/followup` (both ask before doing anything).

Logs: `data/.job-run.log` (and `data/.launchd.*.log` on macOS). All gitignored.
