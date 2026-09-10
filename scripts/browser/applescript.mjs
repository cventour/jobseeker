// The macOS driver: Chrome over Apple Events (osascript). This is the transport that scripts/browser.mjs
// was built on; the facade there explains WHY Apple Events and not CDP. Everything in this file talks
// to Chrome and nothing else — the site-agnostic composites (findTab, openConversation, withOwnedTab,
// withBrowser…) live in ./snippets.mjs and work on any driver exposing this same surface.

import { execFile } from "child_process";
// The page snippets are shipped by the extension and shared with this driver, so both platforms run
// IDENTICAL page code from one file. Apple Events cannot be handed a function reference the way
// chrome.scripting can, so this driver stringifies the same function instead — see runSnippet().
import snippets from "../../extension/snippets.js";

const { SNIPPETS } = snippets;

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
 * The pattern anchors on the main binary's PATH, which is what keeps helper processes from making a
 * dead browser look alive — they live under Contents/Frameworks/.../Helpers/, so the leading ^ has
 * always excluded them on its own.
 *
 * It must NOT also anchor the end. A trailing `$` means "the command line is exactly the binary and
 * nothing else", which is true only of a Chrome launched with zero arguments — and a real Chrome
 * essentially never is. Measured on this machine, the live browser reads:
 *
 *   /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --origin-trial-disabled-features=… --restart
 *
 * so the check returned FALSE while Chrome was plainly running, every single time. Everything
 * downstream then behaved exactly as designed on top of a false premise: ensureChrome() called
 * `open` (a no-op on a running Chrome), polled this function for 180 seconds, never saw it flip,
 * and reported "Chrome was launched but never became scriptable". The probe skips Apple Events
 * entirely when Chrome looks down, so apple_events stayed "unknown", tabs_open 0, and the digest
 * said WhatsApp and LinkedIn could not be read — for days, on a machine where Chrome was open the
 * whole time. `( |$)` accepts arguments while still requiring the binary itself.
 */
// Exported so it can be tested against real command lines instead of only being exercised when a
// browser happens to be open — this bug was invisible precisely because nothing checked it.
export const CHROME_PROC_PATTERN = "^/Applications/Google Chrome.app/Contents/MacOS/Google Chrome( |$)";

export async function chromeRunning() {
  return new Promise((resolve) => {
    execFile("/usr/bin/pgrep", ["-f", CHROME_PROC_PATTERN], { timeout: 10_000 }, (err, stdout) =>
      resolve(!err && String(stdout).trim().length > 0)
    );
  });
}

// One AppleScript, shared by listTabs() and probe(): the two used to carry their own copies and
// the probe's drifted (see scriptableTabs in snippets.mjs for what that cost).
const LIST_TABS_SCRIPT = [
  'set out to ""',
  `tell ${CHROME}`,
  "  set wi to 0",
  "  repeat with w in windows",
  "    set wi to wi + 1",
  // Which tab is in the foreground. Chrome's Memory Saver discards long-idle background tabs,
  // and a discarded tab has no renderer, so injected JavaScript never returns — it hangs until
  // the Apple Event times out. The active tab is the one that is always live.
  "    set ai to active tab index of w",
  "    set ti to 0",
  "    repeat with t in tabs of w",
  "      set ti to ti + 1",
  // `id of t` is Chrome's own tab id: stable across the user opening and closing other tabs, which
  // an index is not. It rides along here so a tab can be re-addressed later (navigateTab, closeTab).
  '      set out to out & wi & "\\t" & ti & "\\t" & ai & "\\t" & (id of t as string) & "\\t" & (URL of t) & "\\t" & (title of t) & "\\n"',
  "    end repeat",
  "  end repeat",
  "end tell",
  "return out",
].join("\n");

function parseTabList(out) {
  return out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 5 && p[4])
    .map(([w, t, a, id, url, title]) => ({
      window: Number(w),
      tab: Number(t),
      active: Number(t) === Number(a),
      id: id || null,
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

/** Every open tab, with the 1-based window/tab indices needed to address it later. */
export async function listTabs() {
  const r = await osa(LIST_TABS_SCRIPT);
  if (!r.ok) throw new Error(`cannot list Chrome tabs: ${r.err}`);
  return parseTabList(r.out);
}

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
    // -1712 on a specific tab is almost never a permission problem — permission failures are
    // instant and browser-wide. It is Chrome's Memory Saver having discarded a long-idle background
    // tab: no renderer, so the event hangs until it times out. Naming it stops the digest reporting
    // "Chrome is broken" when the truth is "that tab was asleep".
    if (/-1712|timed out/i.test(r.err)) {
      throw new Error(
        `tab ${tab.tab} of window ${tab.window} did not respond (Apple Event timed out). ` +
          "Chrome most likely discarded this background tab to save memory; only foreground tabs are " +
          "guaranteed to be live."
      );
    }
    throw new Error(`evalInTab failed: ${r.err}`);
  }
  return r.out;
}

/**
 * Flatten a snippet's source to ONE LINE.
 *
 * AppleScript string literals cannot contain a raw newline, and asStr() escapes them — but a `//`
 * line comment inside a flattened function would then comment out everything after it, silently.
 * That failure has happened here before: openConversation returned "no error" and simply never
 * clicked. So snippets carry block comments only (extension/snippets.js rule 3) and every one is
 * flattened here; scripts/test-security.mjs asserts both properties against the real functions.
 *
 * Exported so the test flattens exactly what production flattens, rather than a copy of the rule.
 */
export const flattenSnippet = (fn) => String(fn).replace(/\r\n|\r|\n/g, " ");

/**
 * Run a NAMED snippet from extension/snippets.js in a tab and return its value.
 *
 * The extension hands `SNIPPETS[name]` to chrome.scripting.executeScript as a function reference;
 * Apple Events has no such call, so here the same function is stringified and evaluated as
 * `(<source>)(<args as JSON>)`. Chrome returns the program's completion value, which is the call's
 * result — exactly what the extension's executeScript returns. One file, two transports, no drift.
 */
export async function runSnippet(tab, name, args = {}) {
  const fn = Object.prototype.hasOwnProperty.call(SNIPPETS, name) ? SNIPPETS[name] : null;
  if (!fn) throw new Error(`unknown snippet "${name}" (known: ${Object.keys(SNIPPETS).join(", ")})`);
  return evalInTab(tab, `(${flattenSnippet(fn)})(${JSON.stringify(args ?? {})})`);
}

/** Open `url` in a new tab at the end of window 1 (creating a window if none) and return its address. */
export async function openTab(url) {
  const open = await osa(
    `tell ${CHROME}\n  if (count of windows) = 0 then make new window\n  set t to make new tab at end of tabs of window 1 with properties {URL:${asStr(url)}}\n  return ((count of tabs of window 1) as string) & "\\t" & (id of t as string)\nend tell`
  );
  if (!open.ok) throw new Error(`could not open tab: ${open.err}`);
  const [tab, id] = String(open.out).split("\t");
  return { window: 1, tab: Number(tab), id: id || null };
}

/**
 * Point a tab we already opened at `url`, and return its (possibly moved) address.
 *
 * This is what lets a sweep of forty boards use ONE tab instead of forty: navigate, read, navigate
 * again. The address it navigates by is Chrome's tab `id`, never the index — the user opens and
 * closes tabs while we work, so an index goes stale, and navigating a stale index would send one of
 * THEIR tabs somewhere. A tab whose id is no longer present is reported as gone, never guessed at
 * by position; the caller reopens.
 *
 * One AppleScript quirk to know: tab ids do NOT compare as numbers here — `(id of t) = 159280993`
 * is false even for the tab that has exactly that id — so both sides are compared as strings.
 */
export async function navigateTab(tab, url) {
  if (!tab?.id) throw new Error("navigateTab needs a tab id (open the tab with openTab)");
  const r = await osa(
    `tell ${CHROME}\n  set wi to 0\n  repeat with w in windows\n    set wi to wi + 1\n    set ti to 0\n    repeat with t in tabs of w\n      set ti to ti + 1\n      if (id of t as string) = ${asStr(String(tab.id))} then\n        set URL of t to ${asStr(url)}\n        return (wi as string) & "\\t" & (ti as string)\n      end if\n    end repeat\n  end repeat\n  return "not-found"\nend tell`
  );
  if (!r.ok) throw new Error(`could not navigate tab: ${r.err}`);
  if (String(r.out).trim() === "not-found") {
    throw new Error(`tab ${tab.id} is no longer open (closed while we were working)`);
  }
  const [w, t] = String(r.out).split("\t");
  return { window: Number(w), tab: Number(t), id: tab.id };
}

/** Close one tab BY ID. Best effort — never throws, and never touches a tab we did not open. */
export async function closeTab(tab) {
  if (!tab?.id) return;
  await osa(
    `tell ${CHROME}\n  repeat with w in windows\n    repeat with t in tabs of w\n      if (id of t as string) = ${asStr(String(tab.id))} then close t\n    end repeat\n  end repeat\nend tell`
  ).catch(() => {});
}

/**
 * Close every tab whose URL starts with `url`. Close by URL match rather than by index: the user
 * may have opened or closed tabs while we worked, and closing a stale index would close one of
 * THEIR tabs. Best effort — never throws.
 */
export async function closeTabsByUrl(url) {
  await osa(
    `tell ${CHROME}\n  repeat with w in windows\n    repeat with t in tabs of w\n      if URL of t starts with ${asStr(url)} then close t\n    end repeat\n  end repeat\nend tell`
  ).catch(() => {});
}

/** Is the tab still loading? `true`/`false`, or `null` when Chrome did not answer. */
export async function tabLoading(tab) {
  const r = await osa(
    `tell ${CHROME} to return (loading of (tab ${tab.tab} of window ${tab.window}))`,
    { timeoutMs: 10_000 }
  );
  if (!r.ok) return null;
  return r.out.trim() !== "false";
}

// ---------- Probe: the driver-specific facts scripts/browser-probe.mjs records ----------
//
// The probe deliberately has its OWN osascript helpers rather than reusing osa() above. Their
// retry rule differs (the probe retries every failure once, not only timeouts) and their timeout
// differs, and those two were tuned against real 08:00 runs. Keeping them separate keeps the probe's
// verdicts exactly what they have always been.

// Apple Events to a busy Chrome can take seconds; the first one after idle is the slowest and a
// cold call has been observed to time out at 10s while the very next one succeeds. So: generous
// timeout, and one retry before believing a failure.
function probeOsa(script, { timeoutMs = 25_000 } = {}) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, err: String(stderr || err.message || err).trim() });
      resolve({ ok: true, out: String(stdout).trim() });
    });
  });
}

async function probeOsaRetry(script, opts) {
  const first = await probeOsa(script, opts);
  if (first.ok) return first;
  return probeOsa(script, opts);
}

function sh(cmd) {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", cmd], { timeout: 10_000 }, (err, stdout) =>
      resolve(err ? "" : String(stdout).trim())
    );
  });
}

// Host only — a probe detail that ends up in the digest must not carry query strings, which on a
// careers or mail tab can hold search terms and ids that are none of this file's business.
const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return "unknown host";
  }
};

/**
 * Measure what Apple Events can do with the running Chrome. `launched` says whether ensureChrome()
 * just started it (a settling Chrome gets extra chances). `scriptableTabs` is the shared ordering
 * rule from snippets.mjs, passed in so this file does not import upward.
 *
 * Returns the fields the status file records verbatim: chrome_pid, chrome_running, tabs,
 * apple_events, apple_events_error, js_from_apple_events, js_probe_detail.
 */
export async function probe({ launched = false, scriptableTabs = (t) => t || [] } = {}) {
  const chromePid = await sh(
    // See chromeRunning() above: the trailing `$` matched only an argument-less Chrome,
    // so this reported "not running" against a browser that was open the whole time.
    "pgrep -f '^/Applications/Google Chrome.app/Contents/MacOS/Google Chrome( |$)' | head -1"
  );
  const chromeRunning = Boolean(chromePid);

  // Tab inventory. Titles and URLs are plain scripting properties — no "Allow JavaScript from
  // Apple Events" needed — so this works even when content reading does not.
  let tabs = [];
  let appleEvents = "unknown";
  let appleEventsError = "";
  if (chromeRunning) {
    // Carries the 1-based window/tab indices, because addressing anything other than the first tab
    // needs them — and the first tab is precisely what must not be assumed (see the JS probe below).
    let r = await probeOsaRetry(LIST_TABS_SCRIPT);
    // A Chrome we started ourselves is often still settling; give it a few more chances rather
    // than recording a hard failure on the first stumble.
    for (let i = 0; i < 3 && !r.ok && launched; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      r = await probeOsaRetry(LIST_TABS_SCRIPT);
    }
    if (r.ok) {
      appleEvents = "ok";
      tabs = parseTabList(r.out);
    } else {
      // Three distinct failures that must not be collapsed into one:
      //   -1743  the user actively denied Automation, or it was revoked.
      //   -1712  the event timed out. Unattended, this usually means a TCC consent dialog is on
      //          screen with nobody to click it. It is the expected 08:00 failure, because the
      //          grant is keyed to the RESPONSIBLE PROCESS: approving it for Claude does not
      //          approve it for /bin/bash under launchd. Reporting this as a generic "error" would
      //          hide a one-click fix behind a shrug.
      //   other  a real transient.
      if (/-1743|not authori/i.test(r.err)) appleEvents = "denied";
      else if (/-1712|timed out/i.test(r.err)) appleEvents = "prompt-pending";
      else appleEvents = "error";
      // KEEP THE TEXT. Discarding it produced a real run whose only diagnostic was the generic
      // "no mechanism available to read page content" — precisely the guessing this probe exists
      // to end. Trimmed because osascript echoes the whole script back on failure.
      appleEventsError = String(r.err).replace(/\s+/g, " ").slice(0, 300);
    }
  }

  // Can we read PAGE CONTENT via Apple Events?
  //
  // The question is whether the MECHANISM works, so ANY tab that answers proves it. Probing a
  // single hardcoded `tab 1 of window 1` answered a different and useless question — "is whatever
  // happens to be leftmost responsive right now" — and got it wrong in both directions:
  //   * a chrome:// or New Tab page refuses injected JS regardless of permission;
  //   * a heavy SPA leaves the Apple Event pending until it times out. On 2026-08-17 tab 1 was a
  //     careers portal that took the full timeout, so the run reported "cannot read pages", the
  //     digest told the user WhatsApp and LinkedIn were unreadable, and job-run.sh skipped the
  //     board sweep entirely — while reading actually worked fine on every other tab.
  // So: walk several scriptable tabs with a short timeout each, and stop at the first success.
  // A denial or a disabled setting is instant and applies to every tab, so it still surfaces.
  const JS_PROBE_TABS = 5;
  const JS_PROBE_TIMEOUT_MS = 8000; // a trivial `1` on a healthy tab answers in milliseconds
  let jsFromAppleEvents = "unknown";
  let jsProbeDetail = "";
  const candidates = scriptableTabs(tabs);
  if (appleEvents === "ok" && !tabs.length) {
    jsProbeDetail = "no tabs open";
  } else if (appleEvents === "ok" && !candidates.length) {
    // Not a permission failure: there is simply nothing injectable open (a cold Chrome sitting on
    // the New Tab Page). Saying "cannot read" here would be a guess dressed as a measurement.
    jsFromAppleEvents = "unknown";
    jsProbeDetail = `no http(s) tab among ${tabs.length} open — permission untested, not denied`;
  } else if (appleEvents === "ok") {
    const tried = [];
    for (const t of candidates.slice(0, JS_PROBE_TABS)) {
      const r = await probeOsa(
        `tell application id "com.google.Chrome" to execute (tab ${t.tab} of window ${t.window}) javascript "1"`,
        { timeoutMs: JS_PROBE_TIMEOUT_MS }
      );
      if (r.ok) {
        jsFromAppleEvents = "on";
        jsProbeDetail = `succeeded on ${hostOf(t.url)}${tried.length ? ` after ${tried.length} unresponsive tab(s)` : ""}`;
        break;
      }
      // Conclusive for the whole browser — no point asking four more tabs.
      if (/Allow JavaScript from Apple Events|turned off/i.test(r.err)) {
        jsFromAppleEvents = "off";
        jsProbeDetail = "Chrome reports the Apple Events JavaScript setting is off";
        break;
      }
      if (/-1743|not authori/i.test(r.err)) {
        jsFromAppleEvents = "denied";
        jsProbeDetail = "Automation permission denied";
        break;
      }
      tried.push(`${hostOf(t.url)} (${/-1712|timed out/i.test(r.err) ? "timed out" : "error"})`);
    }
    if (jsFromAppleEvents === "unknown") {
      jsFromAppleEvents = "error";
      jsProbeDetail = `tried ${tried.length} tab(s), none responded: ${tried.join(", ")}`.slice(0, 300);
    }
  }

  return {
    driver: "applescript",
    chrome_pid: chromePid || null,
    chrome_running: chromeRunning,
    tabs,
    apple_events: appleEvents,
    apple_events_error: appleEventsError || null,
    js_from_apple_events: jsFromAppleEvents,
    js_probe_detail: jsProbeDetail || null,
    // Which mechanism would serve page reads. null when none can.
    read_mechanism: jsFromAppleEvents === "on" ? "apple-events" : null,
  };
}

export const driver = {
  name: "applescript",
  ensureChrome,
  chromeRunning,
  listTabs,
  runSnippet,
  // Raw string evaluation. Still available HERE because Apple Events allow it and the probe uses
  // it, but everything else routes through runSnippet so both platforms run the same page code.
  evalInTab,
  openTab,
  navigateTab,
  closeTab,
  closeTabsByUrl,
  tabLoading,
  probe,
};
