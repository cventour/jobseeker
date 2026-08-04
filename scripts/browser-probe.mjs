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
import { ensureChrome } from "./browser.mjs";

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
    "pgrep -f '^/Applications/Google Chrome.app/Contents/MacOS/Google Chrome$' | head -1"
  );
  const chromeRunning = Boolean(chromePid);

  const cdp = await probeCdp(CDP_PORT);

  // Tab inventory. Titles and URLs are plain scripting properties — no "Allow JavaScript from
  // Apple Events" needed — so this works even when content reading does not.
  let tabs = [];
  let appleEvents = "unknown";
  let appleEventsError = "";
  if (chromeRunning) {
    const script =
      'set out to "" \n' +
      'tell application id "com.google.Chrome"\n' +
      "  repeat with w in windows\n" +
      "    repeat with t in tabs of w\n" +
      '      set out to out & (URL of t) & "\\t" & (title of t) & "\\n"\n' +
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
        .filter(([u]) => u)
        .map(([url, title]) => ({ url, title: title || "" }));
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

  // Can we read PAGE CONTENT via Apple Events? Only meaningful if a tab exists to test against.
  // The error text is explicit and stable, so we detect the specific "turned off" case rather than
  // treating every failure as "off".
  let jsFromAppleEvents = "unknown";
  if (appleEvents === "ok" && tabs.length) {
    const r = await osa(
      'tell application id "com.google.Chrome" to execute (tab 1 of window 1) javascript "1"'
    );
    if (r.ok) jsFromAppleEvents = "on";
    else if (/Allow JavaScript from Apple Events|turned off/i.test(r.err)) jsFromAppleEvents = "off";
    else jsFromAppleEvents = "error";
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
  if (jsFromAppleEvents === "error") {
    blockers.push("Chrome accepted the Apple Event but the page script failed — the tab may still be loading.");
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
    capabilities,
    blockers,
    tabs_open: tabs.length,
    whatsapp: whatsappTab
      ? { tab_open: true, unread: unreadFromTitle(whatsappTab.title) }
      : { tab_open: false, unread: null },
    linkedin: linkedinTab
      ? { tab_open: true, unread: unreadFromTitle(linkedinTab.title) }
      : { tab_open: false, unread: null },
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
        } · linkedin tab=${status.linkedin.tab_open}\n` +
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
