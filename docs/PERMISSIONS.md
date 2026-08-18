# macOS permissions

**Short version: run `npm run setup` once.** It checks prerequisites, installs the browser agent,
triggers each permission prompt at the right moment, and — importantly — **verifies the result rather
than trusting it**. Everything below is the reference for when something needs fixing by hand.

```bash
npm run setup
```

The steps it cannot do for you are two Chrome settings. Both are one-time.

**Let JobSeeker read page content:**

1. Open Chrome
2. Menu bar ▸ View ▸ Developer
3. Click "Allow JavaScript from Apple Events"

**Stop Chrome putting your WhatsApp and LinkedIn tabs to sleep** (section 3 — without this, reading
works when you are at the machine and fails overnight):

1. Open Chrome ▸ Settings ▸ **Performance**
2. Under **Memory Saver**, click **Add** next to "Always keep these sites active"
3. Enter `web.whatsapp.com`, click **Add**
4. Repeat for `linkedin.com`

Check the current state at any time:

```bash
npm run browser:probe
```

---

## Why "forever" needs an agent

macOS keys Automation permission to the **responsible process**, and for an interactive Claude Code
session that is `~/.local/share/claude/versions/<version>/claude` — a version-pinned binary with no
stable identity. The consent dialog literally names the version:

> **"2.1.221" wants access to control "Google Chrome"**

Every Claude Code update is therefore a brand-new requester, and macOS asks again. Clicking Allow
*is* permanent — but only for that version, and you cannot pre-approve a version that does not exist
yet. Left alone, this repeats forever, and an unattended 08:00 run would eventually hang on a dialog
with nobody to click it.

A **LaunchAgent** does not have this problem: its responsible process is its `Program` — `/bin/bash`,
Apple-signed, at a path that never changes. Granted once, it stays granted across Claude Code
updates, macOS updates and reboots. This is why the scheduled run has always worked.

So all browser work is funnelled through `com.jobseeker.browser`:

```
caller ──► scripts/browser-do.mjs ──► launchctl kickstart ──► com.jobseeker.browser
                                                              (/bin/bash — stable identity)
                                                                     │
                                                                     ▼
                                                              Chrome, via Apple Events
```

`browser-do.mjs` falls back to running in-process if the agent is not installed, so nothing breaks
on a fresh clone — you just get prompted more often.

## The permissions are not granted to Node

This surprises people, and it is the thing to understand before the rest makes sense.

`scripts/browser.mjs` runs under `node`, but macOS does **not** attach the permission to `node`. TCC
(the privacy system) records the grant against the **responsible process** — roughly, the app that
started the chain. So:

| How JobSeeker runs | Responsible process | Where it appears in System Settings |
|---|---|---|
| Interactively, in Claude Code | **Claude** | Automation ▸ Claude |
| Scheduled, from the LaunchAgent | **`/bin/bash`** | Automation ▸ bash |

These are two independent grants. **Approving one does not approve the other** — which is exactly how
a setup that works perfectly while you watch it fails silently at 08:00.

---

## 1. Automation — macOS

**System Settings ▸ Privacy & Security ▸ Automation**

Under each requesting app, one target must be ticked:

- **Google Chrome** — read tabs, and read page content

**System Events is no longer required.** It used to be, for checking whether Chrome was running
without launching it. That check now uses `pgrep`, which needs no permission and cannot fail for
permission reasons — so there is one fewer grant to approve, and one fewer thing to re-approve after
a Claude Code update. If you already granted it, you can safely untick it.

macOS asks for this the first time it is needed, and remembers the answer. It survives reboots,
logouts and app restarts; there is nothing extra to make it permanent.

### Granting it for the scheduled run

You cannot click a consent dialog that appears at 08:00 while you are asleep — the Apple Event times
out and the sweep silently does nothing. So trigger the prompt yourself, once, while you are at the
keyboard:

```bash
launchctl start com.jobseeker.jobrun
```

Click **Allow**. From then on the scheduled run is covered permanently. (This runs the full daily
pipeline, not just a permission check.)

### What invalidates a grant

1. Revoking it in System Settings.
2. `tccutil reset AppleEvents`.
3. **The requesting app's code signature or path changing.** macOS then treats it as a different app
   and asks again.
4. macOS reinstall, a new user account, or Migration Assistant.

Point 3 is worth knowing, and it WILL happen: `/bin/bash` is an Apple-signed OS binary at a fixed
path, so the **scheduled** grant is stable and survives everything. The **interactive** grant is
keyed to a version-pinned Claude Code binary (`~/.local/share/claude/versions/<version>`), so
**every Claude Code update re-prompts** — observed going from 2.1.220 to 2.1.221.

There is no way to pre-approve a version that does not exist yet. Clicking Allow *is* permanent, for
that version. Treat the occasional prompt as normal: you are at the keyboard when it appears, and
the 08:00 scheduled run never depends on it.

---

## 2. Allow JavaScript from Apple Events — Chrome

**Chrome menu bar ▸ View ▸ Developer ▸ Allow JavaScript from Apple Events**

Without it, JobSeeker can still list tabs, titles and unread badges — so it can tell you *"11 unread
on WhatsApp Web"* — but it cannot read the messages themselves.

This is a Chrome profile preference (`browser.allow_javascript_apple_events`), written to disk and
synced with your Google account, so it survives restarts and follows the profile to other machines.
It is **not** a macOS setting and does not appear in System Settings.

There is no supported way to enable it from a script: doing so would need blanket **Accessibility**
access to drive Chrome's menus, which is a far broader permission than the checkbox is worth. Tick it
by hand.

---

## 3. Chrome Memory Saver

**Keep the WhatsApp and LinkedIn tabs active.**

Not a permission, but it belongs here: without it the permissions above are granted and reading
still fails.

Chrome discards long-idle **background** tabs to reclaim memory. A discarded tab has no renderer, so
injected JavaScript never returns — the Apple Event just hangs until it times out, which looks
identical to a broken permission. Measured on a real 36-tab browser: **1 tab in 12 answered**, and it
was the foreground one.

Add the two sites JobSeeker has to read:

1. Open **Chrome ▸ Settings** (or paste `chrome://settings/performance`).
2. Click **Performance**.
3. Under **Memory Saver**, click **Add** next to *Always keep these sites active*.
4. Enter `web.whatsapp.com` and click **Add**.
5. Click **Add** again, enter `linkedin.com`, and click **Add**.

Then confirm it took effect. Chrome records the allowlist in its own preferences, so this is
checkable rather than a matter of trusting that the clicks landed:

```bash
node -e 'const fs=require("fs"),os=require("os");
const dir=os.homedir()+"/Library/Application Support/Google/Chrome";
for (const p of fs.readdirSync(dir)) {
  const f=dir+"/"+p+"/Preferences"; if (!fs.existsSync(f)) continue;
  const ex=(JSON.parse(fs.readFileSync(f,"utf8")).performance_tuning||{}).tab_discarding||{};
  const sites=Object.keys(ex.exceptions_with_time||ex.exceptions||{});
  if (sites.length) console.log(p+":", sites.join(", "));
}'
```

Both `web.whatsapp.com` and `linkedin.com` should be listed. **Check every profile it prints** — the
active profile is often not `Default` (it may be `Profile 3` or similar), and the setting only
applies to the profile it was made in.

`npm run browser:probe` is the functional check: `js_from_apple_events` should be `on`, and
`js_probe_detail` names the tab that answered.

**What this does and does not cover.** It protects tabs that are already open — in particular *your*
WhatsApp Web tab, which the sweep must reuse rather than replace, because WhatsApp Web is
single-session and a second tab steals it. Tabs the sweep opens for itself arrive awake anyway, so
they were never the problem.

**Why this is not solved in code.** Waking a discarded tab means activating it, and activation
reloads it. A LinkedIn messaging reload auto-selects the first conversation and **marks it read** —
silently clearing one of your unread badges, which is exactly the harm the list-only sweep is built
to avoid. A browser setting costs nothing and carries no such risk.

**Do not "fix" this by quitting Chrome before each run.** Restored tabs load lazily, so a fresh
browser has *fewer* live tabs, not more — and killing Chrome risks corrupting the profile store that
holds your WhatsApp Web linked-device session, which would put you back at a QR code.

---

## What JobSeeker does NOT need

Worth stating, because these are the permissions people assume an automation like this wants:

| Not required | Why |
|---|---|
| **Screen Recording** | Nothing is ever screenshotted or captured. Page content is read from the DOM. |
| **Accessibility** | No synthetic clicks or keystrokes. The browser API here exposes navigation and extraction only — no click, type or submit. |
| **Full Disk Access** | Only this repository's `data/` directory is read and written. |
| **A Chrome debugging port** | Deliberately avoided — an open CDP port lets any local process drive your browser with your full logged-in identity. See the README. |
| **Google OAuth / `credentials.json`** | Gmail and Calendar run over MCP. The OAuth flow was part of the retired TypeScript layer and has been removed. |

---

## Troubleshooting

Run `npm run browser:probe` first — it distinguishes these cases rather than reporting one vague
failure.

| Probe says | Meaning | Fix |
|---|---|---|
| `apple_events: "denied"` | Automation was refused or revoked | System Settings ▸ Privacy & Security ▸ Automation — tick Google Chrome and System Events |
| `apple_events: "prompt-pending"` | An Apple Event timed out, almost always an unanswered consent dialog | Run `launchctl start com.jobseeker.jobrun` once while present and click Allow |
| `js_from_apple_events: "off"` | Chrome is blocking scripted reads | Chrome ▸ View ▸ Developer ▸ Allow JavaScript from Apple Events |
| `js_from_apple_events: "error"` | Chrome accepted the event but no tab ran the script. Read `js_probe_detail` — "timed out" on every tab means they were discarded, **not** that permission is missing | Exempt the sites from Memory Saver (section 3), or just click the tab to wake it |
| A channel reads fine interactively but never at 08:00 | Its tab sat idle overnight and was discarded | Section 3 |
| `chrome_running: false` with a blocker | Chrome is closed and could not be started | Check `JOBSEEKER_CHROME_AUTOLAUNCH` is not set to `0` |
| `read_page_content: true` | Everything is working | — |

A run that cannot read pages is **not** a failed run. It completes, records the gap in
`coverage`, and the digest names the blocker. Unread channels then age visibly through
`browser_debt` in `npm run audit` rather than disappearing.

## Privacy note

These grants are real: Automation access to Chrome means JobSeeker can read any page you have open,
including authenticated ones. That is inherent to reading WhatsApp Web and LinkedIn at all. What
bounds it is that the browser API exposes only navigation and extraction — never clicking, typing or
submitting — and that the sweep records message content **only** for threads carrying a job-search
signal. Everything else is counted and left alone.
