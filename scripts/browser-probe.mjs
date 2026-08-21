#!/usr/bin/env node
// What can this run actually do with the browser? Measure it; never infer it.
//
// Why this exists: every run decided its own browser story from context, and the stories were
// wrong and mutually contradictory. One digest said "WhatsApp and LinkedIn not checked — no Chrome"
// in a message that was itself delivered over WhatsApp. An interactive run that had Chrome still
// reported it as absent. Seven different hand-written phrasings of "no browser" ended up in the log,
// none machine-readable, so nothing downstream could count the drought.
//
// The fix is to stop asking the model. This probe writes ONE machine-readable verdict and
// .claude/commands/job-run.md forbids asserting browser state from anything else.
//
// It names CAPABILITIES, not apps (AGENT-RULES §10). "WhatsApp" is two unrelated things here:
// SENDING goes over the WhatsApp MCP and needs no browser at all, while READING needs a browser.
// Conflating them is what produced the self-contradicting digest.
//
//   node scripts/browser-probe.mjs          # human-readable summary + writes data/.browser-status.json
//   node scripts/browser-probe.mjs --json   # JSON only

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { ensureChrome, scriptableTabs } from "./browser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const STATUS_FILE = path.join(DATA, ".browser-status.json");

const CDP_PORT = Number(process.env.JOBSEEKER_CDP_PORT || 9333);

// Apple Events to a busy Chrome can take seconds; the first one after idle is the slowest and a
// cold call has been observed to time out at 10s while the very next one succeeds. So: generous
// timeout, and one retry before believing a failure.
function osa(script, { timeoutMs = 25_000 } = {}) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, err: String(stderr || err.message || err).trim() });
      resolve({ ok: true, out: String(stdout).trim() });
    });
  });
}

async function osaRetry(script, opts) {
  const first = await osa(script, opts);
  if (first.ok) return first;
  return osa(script, opts);
}

function sh(cmd) {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", cmd], { timeout: 10_000 }, (err, stdout) =>
      resolve(err ? "" : String(stdout).trim())
    );
  });
}

// A socket that accepts is NOT a ready CDP endpoint — Chrome binds the DevTools HTTP server before
// it can serve. Require a 200 that parses as JSON and carries a websocket URL.
async function probeCdp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { up: false, reason: `HTTP ${res.status}` };
    const body = await res.json();
    if (!body.webSocketDebuggerUrl) return { up: false, reason: "no webSocketDebuggerUrl" };
    return { up: true, browser: body.Browser || "", port };
  } catch (e) {
    return { up: false, reason: e?.name === "TimeoutError" ? "timeout" : "no listener" };
  }
}

// Unread counts ride along in the tab title ("(11) WhatsApp"), which AppleScript can read with NO
// extra permission — worth capturing even when we cannot read the messages themselves, because
// "11 unread and we could not read them" is a far more useful thing to report than silence.
// Host only — a probe detail that ends up in the digest must not carry query strings, which on a
// careers or mail tab can hold search terms and ids that are none of this file's business.
const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return "unknown host";
  }
};

function unreadFromTitle(title) {
  const m = /^\((\d+)\)/.exec(String(title || "").trim());
  return m ? Number(m[1]) : null;
}

async function main() {
  const jsonOnly = process.argv.includes("--json");

  // Bring Chrome up if it is closed. The probe runs before any agent in scripts/job-run.sh, so
  // doing it here means the whole pipeline finds a browser waiting rather than each consumer
  // discovering the absence separately. `--no-launch` reports the closed state without acting.
  let launched = false;
  let launchReason = "";
  if (!process.argv.includes("--no-launch")) {
    const c = await ensureChrome();
    launched = Boolean(c.launched);
    if (!c.running && c.reason) launchReason = c.reason;
  }

  const chromePid = await sh(
    // See chromeRunning() in browser.mjs: the trailing `$` matched only an argument-less Chrome,
    // so this reported "not running" against a browser that was open the whole time.
    "pgrep -f '^/Applications/Google Chrome.app/Contents/MacOS/Google Chrome( |$)' | head -1"
  );
  const chromeRunning = Boolean(chromePid);

  const cdp = await probeCdp(CDP_PORT);

  // Tab inventory. Titles and URLs are plain scripting properties — no "Allow JavaScript from
  // Apple Events" needed — so this works even when content reading does not.
  let tabs = [];
  let appleEvents = "unknown";
  let appleEventsError = "";
  if (chromeRunning) {
    // Carries the 1-based window/tab indices, because addressing anything other than the first tab
    // needs them — and the first tab is precisely what must not be assumed (see the JS probe below).
    const script =
      'set out to "" \n' +
      'tell application id "com.google.Chrome"\n' +
      "  set wi to 0\n" +
      "  repeat with w in windows\n" +
      "    set wi to wi + 1\n" +
      "    set ai to active tab index of w\n" +
      "    set ti to 0\n" +
      "    repeat with t in tabs of w\n" +
      "      set ti to ti + 1\n" +
      '      set out to out & wi & "\\t" & ti & "\\t" & ai & "\\t" & (URL of t) & "\\t" & (title of t) & "\\n"\n' +
      "    end repeat\n" +
      "  end repeat\n" +
      "end tell\n" +
      "return out";
    let r = await osaRetry(script);
    // A Chrome we started ourselves is often still settling; give it a few more chances rather
    // than recording a hard failure on the first stumble.
    for (let i = 0; i < 3 && !r.ok && launched; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      r = await osaRetry(script);
    }
    if (r.ok) {
      appleEvents = "ok";
      tabs = r.out
        .split("\n")
        .map((l) => l.split("\t"))
        .filter((p) => p.length >= 4 && p[3])
        .map(([w, t, a, url, title]) => ({
          window: Number(w),
          tab: Number(t),
          active: Number(t) === Number(a),
          url,
          title: title || "",
        }));
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

  const findTab = (host) => tabs.find((t) => t.url.includes(host)) || null;
  const whatsappTab = findTab("web.whatsapp.com");
  const linkedinTab = findTab("linkedin.com");
  // The message list lives ONLY here. Any other LinkedIn page carries the badge but no threads.
  const linkedinMsgTab = findTab("linkedin.com/messaging");

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
      const r = await osa(
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

  // The capability layer — what callers should actually branch on.
  const canReadPages = cdp.up || jsFromAppleEvents === "on";
  const capabilities = {
    // Reading WhatsApp/LinkedIn message CONTENT. Distinct from sending, below.
    read_page_content: canReadPages,
    // Which mechanism would serve it. null when none can.
    read_mechanism: cdp.up ? "cdp" : jsFromAppleEvents === "on" ? "apple-events" : null,
    // Listing open tabs, titles and unread badges. Much weaker, but works with no extra grant.
    enumerate_tabs: appleEvents === "ok",
    // Deliberately recorded so no digest ever again claims a browser failure blocked delivery:
    // sending goes over the WhatsApp MCP and never touches a browser.
    send_whatsapp: "independent-of-browser",
  };

  const blockers = [];
  if (!chromeRunning) blockers.push("Chrome is not running and could not be launched");
  if (appleEvents === "denied")
    blockers.push(
      "Apple Events to Chrome are denied — System Settings > Privacy & Security > Automation, tick Google Chrome"
    );
  if (appleEvents === "prompt-pending")
    blockers.push(
      "Apple Events timed out, most likely an unanswered Automation consent dialog. The grant is per " +
        "responsible-app, so approving it for Claude does NOT cover the launchd run: run " +
        "`launchctl start com.jobseeker.jobrun` once while you are at the Mac and click Allow."
    );
  if (jsFromAppleEvents === "off")
    blockers.push(
      "Chrome: View > Developer > Allow JavaScript from Apple Events is OFF — one-time toggle, no restart"
    );
  // Every remaining failure must name ITSELF. A generic fallback here is how a real morning was
  // lost with nothing in the digest but "no mechanism available".
  if (launchReason) blockers.push(launchReason);
  if (appleEvents === "error") {
    blockers.push(
      `Apple Events to Chrome failed: ${appleEventsError || "unknown error"}. ` +
        `Chrome is ${chromeRunning ? "running" : "not running"} with ${tabs.length} tab(s) visible.`
    );
  }
  if (jsFromAppleEvents === "denied") {
    blockers.push(
      "Chrome refused to run the page script: Automation permission denied — System Settings > " +
        "Privacy & Security > Automation, tick Google Chrome"
    );
  }
  if (jsFromAppleEvents === "error") {
    // Name what was actually tried. The old wording guessed ("the tab may still be loading"), which
    // was both wrong and unactionable: the real cause was one wedged tab being the only one asked.
    blockers.push(
      `Chrome accepted the Apple Event but no tab ran the page script — ${jsProbeDetail}. ` +
        "Permission looks granted; this is usually a busy or wedged tab, so it often clears by itself."
    );
  }
  if (!canReadPages && !blockers.length) {
    blockers.push(
      `no mechanism available to read page content (apple_events=${appleEvents}, ` +
        `js_from_apple_events=${jsFromAppleEvents}, cdp=${cdp.up ? "up" : "down"})`
    );
  }

  const status = {
    checked_at: new Date().toISOString(),
    chrome_running: chromeRunning,
    // Surfaced so a browser that appeared "by itself" overnight is never a mystery to the user.
    chrome_launched_by_us: launched,
    chrome_pid: chromePid || null,
    cdp,
    apple_events: appleEvents,
    apple_events_error: appleEventsError || null,
    chrome_launch_reason: launchReason || null,
    js_from_apple_events: jsFromAppleEvents,
    // Which tabs were asked and what they said — so a future "cannot read" is diagnosable from the
    // status file alone, instead of needing the failure reproduced by hand.
    js_probe_detail: jsProbeDetail || null,
    capabilities,
    blockers,
    tabs_open: tabs.length,
    whatsapp: whatsappTab
      ? { tab_open: true, unread: unreadFromTitle(whatsappTab.title) }
      : { tab_open: false, unread: null },
    // LinkedIn needs care that WhatsApp does not. WhatsApp Web's title badge counts unread CHATS;
    // LinkedIn's counts everything site-wide — notifications, invitations and messages together —
    // and it appears on every LinkedIn page, so it was being scraped off a *jobs* tab and reported
    // as "14 unread LinkedIn messages". Measured the same day: the message list held 10
    // conversations and none unread. That number was never about messages, and FR-6.4 forbids
    // exactly this kind of conflation. So `unread` is now reported ONLY from a messaging tab, and
    // the site-wide figure is named as what it is.
    linkedin: linkedinTab
      ? {
          tab_open: true,
          messaging_tab_open: Boolean(linkedinMsgTab),
          unread: linkedinMsgTab ? unreadFromTitle(linkedinMsgTab.title) : null,
          site_badge: unreadFromTitle(linkedinTab.title),
        }
      : { tab_open: false, messaging_tab_open: false, unread: null, site_badge: null },
  };

  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(STATUS_FILE, JSON.stringify(status, null, 2) + "\n");

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  } else {
    const rm = capabilities.read_mechanism;
    process.stdout.write(
      `browser: chrome=${chromeRunning ? (launched ? "launched by us" : "running") : "down"} · read-pages=${
        canReadPages ? rm : "NO"
      } · tabs=${tabs.length}\n` +
        `whatsapp tab=${status.whatsapp.tab_open}${
          status.whatsapp.unread != null ? ` (${status.whatsapp.unread} unread)` : ""
        } · linkedin messaging tab=${status.linkedin.messaging_tab_open}${
          status.linkedin.unread != null ? ` (${status.linkedin.unread} unread)` : ""
        }${
          // Named, not silently reported as unread messages — it counts notifications and
          // invitations too, and it shows on every LinkedIn page.
          status.linkedin.site_badge != null ? ` · linkedin site badge=${status.linkedin.site_badge}` : ""
        }\n` +
        (blockers.length ? blockers.map((b) => `  blocker: ${b}\n`).join("") : "") +
        `wrote ${path.relative(ROOT, STATUS_FILE)}\n`
    );
  }
  // Exit 0 always: "no browser" is a valid, reportable answer, not a script failure. A non-zero
  // exit here would abort job-run.sh and lose the whole run over a missing capability.
}

main().catch((e) => {
  process.stderr.write("browser-probe error: " + (e?.message || e) + "\n");
  process.exit(1);
});
