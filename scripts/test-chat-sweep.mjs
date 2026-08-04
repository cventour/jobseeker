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

import { sweepChannel } from "./chat-sweep.mjs";

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

  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-chat-sweep error:", e?.message || e);
  process.exit(1);
});
