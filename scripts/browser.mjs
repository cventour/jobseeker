#!/usr/bin/env node
// Read the user's LIVE, already-logged-in Chrome — without restarting it, copying its profile, or
// opening a debugging port.
//
// Why Apple Events and not CDP (the obvious choice):
//   Chrome 150 refuses `--remote-debugging-port` whenever the user-data-dir is the default one
//   ("DevTools remote debugging requires a non-default data directory" — verified in this build).
//   Getting a port therefore means relaunching Chrome against a non-default directory, which is
//   either a different profile (WhatsApp shows a QR — the one outcome that is forbidden here) or a
//   symlink alias that Chrome very likely canonicalises away. And a port, once open, lets ANY local
//   process drive the browser as the user. Apple Events need none of that: no restart, no port, no
//   profile games. The WhatsApp linked device is preserved because we never touch the profile.
//
// The cost is a one-time, per-profile Chrome setting the user must enable by hand:
//   View > Developer > Allow JavaScript from Apple Events
// Without it, tab URLs and titles still work (so unread badges are still readable), but page
// content is not. `assertCanReadContent()` reports that precisely rather than as "Chrome is broken".
//
// Read-only by construction: this module exposes navigation and extraction and deliberately does
// NOT expose clicking, typing, or form submission. AGENT-RULES §11 requires the chat sweep be
// read-only, and with raw scripting access there is no per-site permission gate to enforce it —
// so the enforcement is that the capability is simply absent from this API.

import { execFile } from "child_process";
import { withBrowserLock } from "../server/lock.mjs";

const CHROME = 'application id "com.google.Chrome"';

// Apple Events to a busy Chrome are slow, and the FIRST one after an idle period has been observed
// to time out (-1712) while the very next one succeeds. So every call gets a generous budget and
// one retry before its failure is believed.
function osascript(script, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, err: String(stderr || err.message || err).trim() });
        resolve({ ok: true, out: String(stdout).replace(/\n$/, "") });
      }
    );
  });
}

async function osa(script, opts) {
  const first = await osascript(script, opts);
  if (first.ok || !/-1712|timed out/i.test(first.err)) return first;
  return osascript(script, opts);
}

// AppleScript string literals only understand \" and \\ — a raw newline inside one is a syntax
// error, so JS payloads must be single-line-safe after escaping.
const asStr = (s) =>
  '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';

/**
 * Make sure Chrome is running, launching it if it is not. Never restarts or quits a running one.
 *
 * The launch is deliberately IDENTICAL to how macOS starts Chrome at login: `open -g -a`, through
 * LaunchServices, with NO flags at all. That matters — every flag we might be tempted to add
 * (`--remote-debugging-port`, `--user-data-dir`, `--profile-directory`) is what would risk landing
 * on a different profile, and a different profile means WhatsApp shows a QR code. No flags means
 * Chrome picks its own last-used profile exactly as it always does, so the linked device survives.
 * `-g` keeps it in the background so an unattended run never steals focus from the user.
 *
 * Set JOBSEEKER_CHROME_AUTOLAUNCH=0 to disable and have a closed Chrome be reported as a blocker.
 */
export async function ensureChrome({ timeoutMs = 180_000 } = {}) {
  if (await chromeRunning()) return { running: true, launched: false };
  if (process.env.JOBSEEKER_CHROME_AUTOLAUNCH === "0") {
    return { running: false, launched: false, reason: "Chrome is closed and autolaunch is disabled" };
  }

  const r = await new Promise((resolve) =>
    execFile("open", ["-g", "-a", "Google Chrome"], { timeout: 20_000 }, (err, _o, stderr) =>
      resolve(err ? String(stderr || err.message) : null)
    )
  );
  if (r) return { running: false, launched: false, reason: `could not launch Chrome: ${r}` };

  // Ready means Apple Events actually answer AND a window exists, not merely that the process is
  // alive. Chrome accepts a launch long before it can service scripting, and a windowless Chrome
  // has nothing to read — declaring victory on "count of windows" succeeding with 0 windows is how
  // a run ends up with apple_events:"ok" and tabs_open:0.
  //
  // The budget is generous because the observed failure was a COLD launch at 08:00 competing with
  // the rest of the run: 60s was not enough, the probe gave up, and the whole morning went
  // browser-less. Waiting three minutes once is far cheaper than losing the day's sweep.
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  let relaunched = false;
  while (Date.now() < deadline) {
    if (await chromeRunning()) {
      const probe = await osa(`tell ${CHROME} to return (count of windows)`, { timeoutMs: 15_000 });
      if (probe.ok) {
        const windows = Number(probe.out) || 0;
        if (windows > 0) return { running: true, launched: true, windows };
        lastErr = "Chrome is scriptable but has no window open";
        // A background launch can land windowless if the last session was closed. `open` again is
        // a verified no-op on a running Chrome, so this asks for a window without risking a second
        // instance. Only once, so a genuinely broken launch cannot loop.
        if (!relaunched) {
          relaunched = true;
          await new Promise((resolve) =>
            execFile("open", ["-g", "-a", "Google Chrome"], { timeout: 20_000 }, () => resolve())
          );
        }
      } else {
        lastErr = probe.err;
      }
    } else {
      lastErr = "Chrome process not visible yet";
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  // Carry the REASON out. Returning a bare failure is what produced the useless
  // "no mechanism available to read page content" in a real run.
  return {
    running: false,
    launched: true,
    reason: `Chrome was launched but never became scriptable within ${Math.round(timeoutMs / 1000)}s` +
      (lastErr ? ` — last error: ${lastErr}` : ""),
  };
}

/**
 * Is Chrome running? Deliberately answered with pgrep rather than System Events.
 *
 * Two reasons, both learned the hard way:
 *   1. It must not need a permission. Asking System Events required a SECOND macOS Automation
 *      grant, which is re-prompted every time Claude Code updates (the grant is keyed to a
 *      version-pinned binary). A liveness check that can fail for permission reasons is the wrong
 *      shape: it turns "is Chrome up?" into "am I allowed to ask?".
 *   2. It must never LAUNCH Chrome as a side effect, which a plain `tell application "Google
 *      Chrome"` would. pgrep cannot.
 *
 * The regex anchors on the main binary, so Chrome's helper processes (which all carry --type=)
 * cannot make a dead browser look alive.
 */
export async function chromeRunning() {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/pgrep",
      ["-f", "^/Applications/Google Chrome.app/Contents/MacOS/Google Chrome$"],
      { timeout: 10_000 },
      (err, stdout) => resolve(!err && String(stdout).trim().length > 0)
    );
  });
}

/** Every open tab, with the 1-based window/tab indices needed to address it later. */
export async function listTabs() {
  const script = [
    'set out to ""',
    `tell ${CHROME}`,
    "  set wi to 0",
    "  repeat with w in windows",
    "    set wi to wi + 1",
    "    set ti to 0",
    "    repeat with t in tabs of w",
    "      set ti to ti + 1",
    '      set out to out & wi & "\\t" & ti & "\\t" & (URL of t) & "\\t" & (title of t) & "\\n"',
    "    end repeat",
    "  end repeat",
    "end tell",
    "return out",
  ].join("\n");
  const r = await osa(script);
  if (!r.ok) throw new Error(`cannot list Chrome tabs: ${r.err}`);
  return r.out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 3 && p[2])
    .map(([w, t, url, title]) => ({
      window: Number(w),
      tab: Number(t),
      url,
      title: title || "",
      // Unread badges ride in the title ("(11) WhatsApp") and need NO extra permission, so this is
      // reportable even in a run that cannot read a single message.
      unread: (() => {
        const m = /^\((\d+)\)/.exec(String(title || "").trim());
        return m ? Number(m[1]) : null;
      })(),
    }));
}

export const findTab = (tabs, host) => tabs.find((t) => t.url.includes(host)) || null;

/**
 * Run an extraction snippet in a tab and return its value.
 * The snippet MUST be read-only. Return a JSON string for anything structured.
 */
export async function evalInTab(tab, js) {
  const script = `tell ${CHROME} to return execute (tab ${tab.tab} of window ${tab.window}) javascript ${asStr(js)}`;
  const r = await osa(script);
  if (!r.ok) {
    if (/Allow JavaScript from Apple Events|turned off/i.test(r.err)) {
      throw new Error(
        "Chrome is blocking scripted reads: enable View > Developer > Allow JavaScript from Apple Events (one-time, no restart)."
      );
    }
    throw new Error(`evalInTab failed: ${r.err}`);
  }
  return r.out;
}

export async function evalJson(tab, js) {
  const raw = await evalInTab(tab, js);
  if (!raw || raw === "missing value") return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`extraction did not return JSON (got: ${raw.slice(0, 120)})`);
  }
}

/** Fail early and precisely, so callers never mistake "not permitted" for "not working". */
export async function assertCanReadContent(tabs) {
  const probe = tabs[0];
  if (!probe) throw new Error("Chrome has no open tabs to read");
  await evalInTab(probe, "1");
}

/**
 * Open a tab we own, and guarantee it is closed again.
 * Never used for WhatsApp Web: it is single-session, so a second tab shows "WhatsApp is open in
 * another window" and STEALS the session from the user's existing tab. Reuse that one instead.
 */
export async function withOwnedTab(url, fn) {
  const open = await osa(
    `tell ${CHROME}\n  if (count of windows) = 0 then make new window\n  set t to make new tab at end of tabs of window 1 with properties {URL:${asStr(url)}}\n  return (count of tabs of window 1)\nend tell`
  );
  if (!open.ok) throw new Error(`could not open tab: ${open.err}`);
  const tab = { window: 1, tab: Number(open.out) };
  try {
    await waitForLoad(tab);
    return await fn(tab);
  } finally {
    // Close by URL match rather than by index: the user may have opened or closed tabs while we
    // worked, and closing a stale index would close one of THEIR tabs.
    await osa(
      `tell ${CHROME}\n  repeat with w in windows\n    repeat with t in tabs of w\n      if URL of t starts with ${asStr(url)} then close t\n    end repeat\n  end repeat\nend tell`
    ).catch(() => {});
  }
}

export async function waitForLoad(tab, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await osa(
      `tell ${CHROME} to return (loading of (tab ${tab.tab} of window ${tab.window}))`,
      { timeoutMs: 10_000 }
    );
    if (r.ok && r.out.trim() === "false") return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

/** Wait for a selector to appear, polling from Node so a wedged page cannot block forever. */
export async function waitForSelector(tab, selector, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await evalInTab(tab, `document.querySelector(${JSON.stringify(selector)}) ? "1" : "0"`);
    if (hit.trim() === "1") return true;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

/**
 * The single entry point. Holds the browser mutex for the whole session so two sweeps can never
 * drive Chrome at once (AGENT-RULES §13) — enforced here rather than asked for in prose.
 */
export async function withBrowser(fn) {
  return withBrowserLock(async () => {
    const chrome = await ensureChrome();
    if (!chrome.running) throw new Error(chrome.reason || "Chrome is not available");
    const tabs = await listTabs();
    return fn({
      tabs,
      chrome,
      findTab: (host) => findTab(tabs, host),
      evalInTab,
      evalJson,
      withOwnedTab,
      waitForSelector,
    });
  });
}

// CLI: `node scripts/browser.mjs` prints what it can see, for debugging.
import { realpathSync } from "fs";
import { fileURLToPath } from "url";
const isMain = (() => {
  try {
    return realpathSync(process.argv[1] || "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  withBrowser(async ({ tabs }) => {
    process.stdout.write(`${tabs.length} tabs\n`);
    for (const t of tabs) {
      process.stdout.write(
        `  w${t.window}t${t.tab}  ${t.unread != null ? `[${t.unread} unread] ` : ""}${t.url.slice(0, 70)}\n`
      );
    }
    try {
      await assertCanReadContent(tabs);
      process.stdout.write("content reading: OK\n");
    } catch (e) {
      process.stdout.write(`content reading: BLOCKED — ${e.message}\n`);
    }
  }).catch((e) => {
    process.stderr.write("browser.mjs: " + (e?.message || e) + "\n");
    process.exit(1);
  });
}
