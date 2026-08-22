#!/usr/bin/env node
// Guards the one property of the chat sweep that fails SILENTLY if it breaks:
// a channel must never be reported as swept — and its watermark must never advance — unless real
// conversations were actually extracted.
//
// Why this matters more than the extraction itself: WhatsApp and LinkedIn reshuffle their DOM
// constantly, so these selectors WILL drift. When they do, the honest outcome is "not swept,
// selectors drifted" (which shows up as browser_debt and gets fixed). The dangerous outcome is
// "swept, 0 conversations" — that advances the watermark, reports success, and hides an unread
// inbox for weeks. This is the exact shape of the bug the watermarks were introduced to prevent, so
// it gets a test that needs no browser and no permissions.
//
//   npm run test:sweep

import { sweepChannel, readThreads } from "./chat-sweep.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

// Stub the browser: return whatever the case under test needs, with no Chrome involved.
const ctxReturning = (payload) => ({
  evalJson: async () => (payload instanceof Error ? Promise.reject(payload) : payload),
});
const tab = { window: 1, tab: 1, unread: 7 };
const run = (payload, t = tab) =>
  sweepChannel({ ctx: ctxReturning(payload), source: "WhatsApp", host: "web.whatsapp.com", js: "x", tab: t });

async function main() {
  console.log("\nchat-sweep safety\n");

  const noTab = await run({ chats: [{ name: "x", unread: 1 }] }, null);
  check("no tab open -> not swept", noTab.swept === false, noTab.reason);

  const drifted = await run({ chats: [] });
  check(
    "empty extraction -> NOT swept (selectors drifted, not an empty inbox)",
    drifted.swept === false && /drift/i.test(drifted.reason),
    drifted.reason
  );

  const errored = await run({ error: "chat list not found" });
  check("extraction error -> not swept", errored.swept === false, errored.reason);

  const threw = await run(new Error("Chrome is blocking scripted reads"));
  check("thrown error is caught, not swept", threw.swept === false, threw.reason);

  const qr = await run({ logged_out: true });
  check(
    "QR / logged-out -> not swept AND flagged, never re-linked",
    qr.swept === false && qr.logged_out === true && /SESSION LOST/.test(qr.reason),
    qr.reason
  );

  const good = await run({ chats: [{ name: "Dana Whitfield", preview: "hi", unread: 2 }, { name: "Recruiter", preview: "role", unread: 0 }] });
  check("real conversations -> swept", good.swept === true && good.chats.length === 2);
  check("unread count is preserved for the digest", good.chats.filter((c) => c.unread > 0).length === 1);

  // Chrome liveness detection. This is not a sweep behaviour, but it is the gate in front of every
  // sweep: when it answers wrongly, nothing downstream can work and the failure presents as "Chrome
  // was launched but never became scriptable" — which reads like a slow machine or a permissions
  // problem, so it went undiagnosed for days while Chrome was open the entire time.
  //
  // The pattern is checked against REAL command lines rather than by starting a browser, because a
  // test that only passes when a browser happens to be running is exactly what failed to exist here.
  const { CHROME_PROC_PATTERN } = await import("./browser.mjs");
  const re = new RegExp(CHROME_PROC_PATTERN);
  const MAIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const HELPERS =
    "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/151.0.7922.138/Helpers";
  // The real one from this machine — the case the old `$`-anchored pattern missed.
  check(
    "Chrome WITH launch arguments is detected",
    re.test(`${MAIN} --origin-trial-disabled-features=CanvasTextNg --restart`)
  );
  check("Chrome with no arguments is detected", re.test(MAIN));
  check("renderer helper does NOT count as a running browser", !re.test(`${HELPERS}/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer`));
  check("crashpad handler does NOT count as a running browser", !re.test(`${HELPERS}/chrome_crashpad_handler --monitor-self`));
  check("a lookalike path elsewhere does NOT match", !re.test("/Users/someone/Google Chrome.app/Contents/MacOS/Google Chrome"));

  // Opening an unread thread marks it read on the real account and destroys the user's own signal
  // about what still needs them. That is the one property of this sweep that cannot regress
  // quietly, so it is asserted here rather than left to the comment that explains it.
  {
    const opened = [];
    const ctx = {
      openConversation: async (_tab, opts) => {
        opened.push(opts.name);
        return { messages: 3, text: "line one\nline two" };
      },
    };
    const chats = [
      { idx: 0, name: "Read Recruiter", unread: 0, preview: "hi" },
      { idx: 1, name: "Unread Recruiter", unread: 2, preview: "hi" },
      { idx: 2, name: "Also Read", unread: 0, preview: "hi" },
    ];
    const res = await readThreads({ ctx, source: "WhatsApp", tab: { id: 1 }, chats });
    check("unread threads are never opened", !opened.includes("Unread Recruiter"), opened.join(", "));
    check("already-read threads ARE opened", opened.length === 2, `opened ${opened.length}`);
    check("skipped unread threads are counted, not hidden", res.skippedUnread === 1, String(res.skippedUnread));
    check("an unread thread keeps its preview and gains no thread text", !chats[1].thread_text);
    check("a read thread gains its thread text", chats[0].thread_text === "line one\nline two");
    check("the thread is matched by NAME, not by array position", opened[1] === "Also Read", opened[1]);
  }

  // An unknown surface must read nothing rather than guess a selector and click something arbitrary.
  {
    let called = false;
    const ctx = { openConversation: async () => ((called = true), null) };
    const res = await readThreads({
      ctx, source: "Telegram", tab: {}, chats: [{ idx: 0, name: "x", unread: 0 }],
    });
    check("an unknown channel reads nothing and clicks nothing", !called && res.read === 0);
  }

  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-chat-sweep error:", e?.message || e);
  process.exit(1);
});
