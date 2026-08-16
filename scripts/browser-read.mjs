#!/usr/bin/env node
// Read a page through the user's real, logged-in Chrome and print its text.
//
// This closes a gap that was quietly costing job finds. 45 careers boards are classed `blocked` or
// `browser` — an HTTP 401/403/429/5xx or a TLS failure, which PROVES a board is there and is refusing
// a script rather than that it is absent. role-scout is told to "switch to Chrome and open it", but
// the only browser tools it had were `mcp__claude-in-chrome__*`, which are injected by an interactive
// Claude Code session and are simply absent from the scheduled `claude -p` run. So every morning the
// queue was read and then skipped, and the digest said "boards needing a browser were not covered".
//
// Everything needed already existed: scripts/browser.mjs drives the live Chrome over Apple Events with
// a permission that survives Claude Code updates. It just had no "fetch me this URL" entry point.
//
//   node scripts/browser-read.mjs <url> [--wait 6] [--max 20000]
//   node scripts/browser-do.mjs read-url <url>     (routed through the LaunchAgent — preferred)
//
// Read-only by construction: browser.mjs exposes navigation and extraction and deliberately does not
// expose clicking, typing or form submission, so this cannot act on a page it opens.

import { withBrowser, assertCanReadContent } from "./browser.mjs";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
// Careers pages are frequently JS-rendered — the whole reason they are in this queue — so settling
// time is not optional.
const WAIT_S = flag("--wait", 6);
const MAX = flag("--max", 20000);

if (!url || !/^https?:\/\//i.test(url)) {
  process.stderr.write("usage: browser-read.mjs <http(s)://url> [--wait 6] [--max 20000]\n");
  process.exit(64);
}

// Extract visible text, not markup. Scripts, styles and nav chrome are stripped so a scout reads the
// listing rather than a page of boilerplate.
const EXTRACT = `
(function () {
  try {
    var kill = document.querySelectorAll('script,style,noscript,svg,iframe');
    for (var i = 0; i < kill.length; i++) kill[i].remove();
    var main = document.querySelector('main,[role="main"],#content,.careers,.jobs') || document.body;
    var t = (main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
    return JSON.stringify({ title: document.title || '', href: location.href, text: t.slice(0, ${MAX}), length: t.length });
  } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
})()
`.replace(/\n/g, " ");

await withBrowser(async (ctx) => {
  // Probe only to turn a permission denial into a precise error. We open our own tab below, so
  // "no scriptable tab is currently open" is not a reason to refuse the read.
  await assertCanReadContent(ctx.tabs).catch((e) => {
    if (/no http\(s\) tab to probe/.test(String(e?.message))) return;
    throw e;
  });
  const out = await ctx.withOwnedTab(url, async (tab) => {
    // Wait for the document to settle, then give client-side rendering a chance.
    await new Promise((r) => setTimeout(r, WAIT_S * 1000));
    return ctx.evalJson(tab, EXTRACT);
  });

  if (!out || out.error) {
    process.stderr.write(`browser-read: ${out?.error || "no content extracted"}\n`);
    process.exit(1);
  }
  // Report the FINAL url: a redirect to a login wall or a consent page is the useful finding, and it
  // would otherwise look like an empty careers page.
  process.stdout.write(`# ${out.title}\n# ${out.href}\n# ${out.length} chars\n\n${out.text}\n`);
}).catch((e) => {
  process.stderr.write("browser-read: " + (e?.message || e) + "\n");
  process.exit(1);
});
