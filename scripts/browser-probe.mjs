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
import { IS_WIN } from "../server/platform.mjs";
import { ensureChrome, scriptableTabs, driver, driverName } from "./browser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const STATUS_FILE = path.join(DATA, ".browser-status.json");

const CDP_PORT = Number(process.env.JOBSEEKER_CDP_PORT || 9333);

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

  // Everything transport-specific — is Chrome up, can we list tabs, can we run a script in one —
  // is measured by the driver (browser/applescript.mjs on macOS, browser/extension.mjs on Windows)
  // and comes back as the same named facts, so the verdict below is written once.
  const facts = await driver.probe({ launched, scriptableTabs });
  const chromePid = facts.chrome_pid || "";
  const chromeRunning = Boolean(facts.chrome_running);
  const tabs = facts.tabs || [];
  const appleEvents = facts.apple_events;
  const appleEventsError = facts.apple_events_error || "";
  const jsFromAppleEvents = facts.js_from_apple_events;
  const jsProbeDetail = facts.js_probe_detail || "";
  const bridge = facts.bridge || null;

  const cdp = await probeCdp(CDP_PORT);

  const findTab = (host) => tabs.find((t) => t.url.includes(host)) || null;
  const whatsappTab = findTab("web.whatsapp.com");
  const linkedinTab = findTab("linkedin.com");
  // The message list lives ONLY here. Any other LinkedIn page carries the badge but no threads.
  const linkedinMsgTab = findTab("linkedin.com/messaging");

  // The capability layer — what callers should actually branch on.
  const driverReads = Boolean(facts.read_mechanism) && facts.read_mechanism !== "none";
  const canReadPages = cdp.up || driverReads;
  const capabilities = {
    // Reading WhatsApp/LinkedIn message CONTENT. Distinct from sending, below.
    read_page_content: canReadPages,
    // Which mechanism would serve it. null when none can.
    read_mechanism: cdp.up ? "cdp" : driverReads ? facts.read_mechanism : null,
    // Listing open tabs, titles and unread badges. Much weaker, but works with no extra grant.
    enumerate_tabs: appleEvents === "ok" || Boolean(bridge?.connected),
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
        "responsible-app, so approving it for Claude does NOT cover the scheduled run: " +
        (IS_WIN
          ? "use Settings ▸ Run now once while you are at the PC and click Allow."
          : "run `launchctl start com.jobseeker.jobrun` once while you are at the Mac and click Allow.")
    );
  if (jsFromAppleEvents === "off")
    blockers.push(
      "Chrome: View > Developer > Allow JavaScript from Apple Events is OFF — one-time toggle, no restart"
    );
  // The extension driver has two states worth naming, and each has one fix.
  if (bridge && !bridge.connected) {
    blockers.push(
      bridge.paired
        ? "JobSeeker Bridge extension is not connected (is Chrome running with the extension enabled?). " +
            "Load the JobSeeker Bridge extension and connect it from Settings ▸ Browser" +
            (bridge.error ? ` — ${bridge.error}` : "")
        : "Load the JobSeeker Bridge extension and connect it from Settings ▸ Browser" +
            (bridge.reachable ? "" : " (the bridge is not running — start the dashboard or `npm run bridge`)")
    );
  }
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
      IS_WIN
        ? `no mechanism available to read page content (bridge=${bridge?.connected ? "connected" : "not connected"}, ` +
            `cdp=${cdp.up ? "up" : "down"}) — load the JobSeeker Bridge extension and connect it from ` +
            "Settings ▸ Browser, then use Settings ▸ Run now"
        : `no mechanism available to read page content (apple_events=${appleEvents}, ` +
            `js_from_apple_events=${jsFromAppleEvents}, cdp=${cdp.up ? "up" : "down"})`
    );
  }

  const status = {
    checked_at: new Date().toISOString(),
    chrome_running: chromeRunning,
    // Surfaced so a browser that appeared "by itself" overnight is never a mystery to the user.
    chrome_launched_by_us: launched,
    chrome_pid: chromePid || null,
    // Which transport measured this: "applescript" (macOS) or "extension" (Windows bridge).
    driver: driverName,
    ...(bridge ? { bridge } : {}),
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
