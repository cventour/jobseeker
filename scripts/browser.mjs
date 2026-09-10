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
// On Windows there are no Apple Events, and the CDP objection is the same, so the transport there is
// the JobSeeker Bridge extension: an ordinary Chrome extension the user loads once and pairs from
// Settings ▸ Browser ▸ Connect. It long-polls a localhost bridge (server/bridge.mjs) over HTTP and
// this module reaches it over plain HTTP. Same profile, no flags, no port anyone else can use, and
// the extension exposes the same primitives the AppleScript path has — list tabs, run a snippet,
// open, close-by-URL, loading? — so everything above the transport is shared.
//
// What runs INSIDE a page is one file for both platforms: extension/snippets.js. Node names a
// snippet; the extension passes the real function to chrome.scripting.executeScript, and the
// AppleScript driver stringifies that same function. Node never sends JavaScript as a string any
// more, because under Manifest V3 it cannot: measured on Windows 11 / Chrome 152.0.7977.83 with the
// extension loaded and paired, https://web.whatsapp.com/ refused all three routes —
// "Content Security Policy refuses string evaluation (ISOLATED/eval, ISOLATED/function, MAIN/eval)".
//
// This file is therefore a FACADE. The two transports are ./browser/applescript.mjs and
// ./browser/extension.mjs; the site-agnostic composites (findTab, openConversation, withOwnedTab,
// withScratchTab, withBrowser…) are ./browser/snippets.mjs and run on whichever driver is picked here. Consumers
// import from THIS file and never see the difference. JOBSEEKER_BROWSER_DRIVER=applescript|extension
// overrides the platform default.
//
// Read-only by construction, with ONE narrow exception. This module exposes navigation and
// extraction, and deliberately does NOT expose typing, form submission, or general clicking. With
// raw scripting access to a logged-in browser there is no per-site permission gate, so the
// enforcement is that the capability is simply absent from this API.
//
// The exception is openConversation() in snippets.mjs: it clicks a conversation in a chat list, and
// nothing else. It exists because list previews were not worth reading — "oh well that's ok",
// "Let's see :)" — and neither chat surface exposes a per-thread URL that navigation could reach
// instead (checked: all 19 LinkedIn conversation rows have href === null; WhatsApp Web has no
// per-chat URLs at all). It is constrained three ways: the element it dispatches on must be INSIDE
// the chat-list row the caller named (asserted with Node.contains, not assumed from the selector),
// it must not be a button, input, textarea, form or contenteditable, and the caller must not have
// marked the conversation unread. See its own comment for why the unread rule is the important one.

import { IS_WIN } from "../server/platform.mjs";
import { driver as applescript, CHROME_PROC_PATTERN } from "./browser/applescript.mjs";
import { driver as extension } from "./browser/extension.mjs";
import {
  setDriver,
  findTab,
  scriptableTabs,
  SNIPPETS,
  runSnippet,
  snippetJson,
  evalInTab,
  evalJson,
  assertCanReadContent,
  openConversation,
  withOwnedTab,
  withScratchTab,
  waitForLoad,
  waitForSelector,
  withBrowser,
} from "./browser/snippets.mjs";

const DRIVERS = { applescript, extension };
export const driverName = process.env.JOBSEEKER_BROWSER_DRIVER || (IS_WIN ? "extension" : "applescript");
export const driver = DRIVERS[driverName];
if (!driver) {
  throw new Error(`unknown JOBSEEKER_BROWSER_DRIVER "${driverName}" (expected applescript or extension)`);
}
setDriver(driver);

// The transport primitives, delegated so a consumer holding a reference keeps working if the
// driver is ever swapped under test.
export const ensureChrome = (opts) => driver.ensureChrome(opts);
export const chromeRunning = () => driver.chromeRunning();
export const listTabs = () => driver.listTabs();

export {
  CHROME_PROC_PATTERN,
  findTab,
  scriptableTabs,
  SNIPPETS,
  runSnippet,
  snippetJson,
  evalInTab,
  evalJson,
  assertCanReadContent,
  openConversation,
  withOwnedTab,
  withScratchTab,
  waitForLoad,
  waitForSelector,
  withBrowser,
};

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
