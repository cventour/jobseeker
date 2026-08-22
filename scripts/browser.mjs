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
// Read-only by construction, with ONE narrow exception. This module exposes navigation and
// extraction, and deliberately does NOT expose typing, form submission, or general clicking. With
// raw scripting access to a logged-in browser there is no per-site permission gate, so the
// enforcement is that the capability is simply absent from this API.
//
// The exception is openConversation() below: it clicks a conversation in a chat list, and nothing
// else. It exists because list previews were not worth reading — "oh well that's ok", "Let's see :)"
// — and neither chat surface exposes a per-thread URL that navigation could reach instead (checked:
// all 19 LinkedIn conversation rows have href === null; WhatsApp Web has no per-chat URLs at all).
// It is constrained three ways: the element it dispatches on must be INSIDE the chat-list row the
// caller named (asserted with Node.contains, not assumed from the selector), it must not be a
// button, input, textarea, form or contenteditable, and the caller must not have marked the
// conversation unread. See its own comment for why the unread rule is the important one.

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

/** Every open tab, with the 1-based window/tab indices needed to address it later. */
export async function listTabs() {
  const script = [
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
    '      set out to out & wi & "\\t" & ti & "\\t" & ai & "\\t" & (URL of t) & "\\t" & (title of t) & "\\n"',
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
    .filter((p) => p.length >= 4 && p[3])
    .map(([w, t, a, url, title]) => ({
      window: Number(w),
      tab: Number(t),
      active: Number(t) === Number(a),
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
 * Tabs that could run injected JavaScript, MOST LIKELY FIRST.
 *
 * Two filters, and the ordering is the important half:
 *
 *  - chrome://, about: and the New Tab page refuse injected JS whatever the permission says, so
 *    probing one proves nothing either way.
 *  - Chrome's Memory Saver discards long-idle background tabs. A discarded tab has no renderer, so
 *    the Apple Event never returns and only fails when it times out. Measured on a real 36-tab
 *    browser: exactly ONE tab answered — the foreground one. Active tabs are always live, so they
 *    go first; anything else is a coin flip that costs a full timeout to lose.
 *
 * Exported so the capability probe and assertCanReadContent share ONE rule. They had two, and after
 * the first was fixed the copy in browser-probe.mjs kept its hardcoded `tab 1 of window 1` — which
 * is how a browser that could read pages perfectly well got reported to the user as unreadable, and
 * silently skipped the board sweep for a whole run.
 */
export const scriptableTabs = (tabs) =>
  (tabs || [])
    .filter((t) => /^https?:/i.test(String(t.url || "")))
    .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));

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

export async function evalJson(tab, js) {
  const raw = await evalInTab(tab, js);
  if (!raw || raw === "missing value") return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`extraction did not return JSON (got: ${raw.slice(0, 120)})`);
  }
}

/**
 * Fail early and precisely, so callers never mistake "not permitted" for "not working".
 *
 * Callers that open their own tab should tolerate the "no http(s) tab to probe" case — it means the
 * permission is unknown, not denied, and the real read will report the truth either way.
 */
export async function assertCanReadContent(tabs) {
  const candidates = scriptableTabs(tabs);
  if (!candidates.length) {
    // No scriptable tab open is not a permission failure — callers that open their own tab can
    // carry on, so say what is actually true rather than claiming reads are blocked.
    throw new Error("Chrome has no http(s) tab to probe (permission unknown, not denied)");
  }
  // Try several tabs, not just the first. Two separate ways a single blind probe lies:
  // a chrome:// or New Tab page refuses injected JS regardless of permission, and a heavy SPA
  // (the Emirates careers portal, for one) leaves the Apple Event pending until it times out.
  // Either turned "your first tab is busy" into "you cannot read pages", which is the exact false
  // negative this function exists to prevent. A permission denial, by contrast, is instant and
  // affects every tab — so it still surfaces, from the last attempt.
  let last;
  for (const tab of candidates.slice(0, 4)) {
    try {
      await evalInTab(tab, "1");
      return;
    } catch (e) {
      last = e;
      // A denial is conclusive on the first tab; no point asking three more.
      if (/not authori[sz]ed|not allowed|Allow JavaScript from Apple Events/i.test(String(e?.message))) throw e;
    }
  }
  throw last;
}

/**
 * Open conversation `index` in a chat list and return its visible messages.
 *
 * The one clicking capability in this module, and shaped so it cannot become a general one: the
 * caller supplies a list selector and an index, the script resolves that to an element INSIDE the
 * list and clicks it, and nothing else on the page is reachable. It cannot submit a form, type into
 * a field, or press a send button — those elements are never selected.
 *
 * `skipIfUnread` is the part that matters, and it defaults to true. Opening an unread conversation
 * marks it read on the real account, which destroys the user's own signal about what still needs
 * them — the reason this whole sweep was list-only. But that cost only exists for UNREAD threads;
 * opening one that is already read changes nothing at all. Measured on this account, 16 of 17
 * swept threads were already read, so refusing just the unread ones keeps the signal intact while
 * still reading almost everything.
 *
 * Returns null when the conversation is skipped or cannot be read, never a partial guess.
 */
export async function openConversation(
  tab,
  { listSelector, nameSelector, name, index, messageSelector, waitMs = 2500, max = 8000 }
) {
  const click = `
(function(){
  try{
    var items = document.querySelectorAll(${JSON.stringify(listSelector)});
    var want = ${JSON.stringify(name || "")};
    var el = null;
    /* Prefer matching by NAME. Both chat lists virtualise: scrolling re-renders the rows, so an
       index captured during extraction can point at a different conversation by the time we click.
       Opening the wrong thread is not a cosmetic bug here — it can be an unread one.
       NOTE: block comments only in here. This whole script is flattened to ONE LINE before it is
       injected, so a line comment would silently comment out everything after it. */
    if (want) {
      for (var i = 0; i < items.length && !el; i++) {
        var t = items[i].querySelector(${JSON.stringify(nameSelector || "span[title]")});
        var got = t ? (t.getAttribute('title') || t.textContent || '').trim() : '';
        if (got === want) el = items[i];
      }
    }
    if (!el) el = items[${Number(index)}];
    if (!el) return JSON.stringify({ error: 'conversation not found (name/index both missed)' });

    el.scrollIntoView({ block: 'center' });
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return JSON.stringify({ error: 'conversation row is not visible' });
    /* Dispatch on the deepest element under the row centre, not on the row itself. Measured on a
       live WhatsApp: an event dispatched at the row does nothing — the handler is bound further
       down — while the same sequence on elementFromPoint() opens the thread. A plain .click() does
       not work either; the list wants the pointer/mouse pair. */
    var target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!target) return JSON.stringify({ error: 'nothing at the row centre' });
    /* Two independent guards, both of which must hold. The containment check is the real one: it
       makes "we only ever click inside the conversation row we chose" a property of the code rather
       than of the selector being well behaved. */
    if (!el.contains(target)) return JSON.stringify({ error: 'point resolved outside the row' });
    if (target.closest('button, input, textarea, form, [contenteditable="true"]')) {
      return JSON.stringify({ error: 'refusing to click a control' });
    }

    var b = { bubbles: true, cancelable: true, composed: true, view: window,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, detail: 1 };
    var p = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, b, p, { buttons: 1 })));
    target.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, b, { buttons: 1 })));
    target.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, b, p, { buttons: 0 })));
    target.dispatchEvent(new MouseEvent('mouseup', b));
    target.dispatchEvent(new MouseEvent('click', b));
    return JSON.stringify({ ok: true });
  }catch(e){ return JSON.stringify({ error: String(e && e.message || e) }); }
})()`.replace(/\n/g, " ");

  const read = `
(function(){
  try{
    /* Selector GENERATIONS, tried newest-first, first non-empty one wins — not one combined
       selector. Combining them double-counts: on the current WhatsApp a message matches both
       'div[role="row"]' and its nested '[data-testid="msg-container"]', so every message was
       logged twice. Keeping the older generations still guards against the next DOM rotation. */
    var gens = ${JSON.stringify(Array.isArray(messageSelector) ? messageSelector : [messageSelector])};
    var nodes = [];
    for (var g = 0; g < gens.length && nodes.length === 0; g++) {
      nodes = document.querySelectorAll(gens[g]);
    }
    var out = [];
    for (var i = Math.max(0, nodes.length - 40); i < nodes.length; i++) {
      var t = (nodes[i].innerText || '').replace(/\\n{2,}/g, '\\n').trim();
      if (t) out.push(t);
    }
    var joined = out.join('\\n---\\n');
    /* Truncate from the FRONT, not the back: in a long thread the recent end is what matters, and
       slicing the head would keep the oldest of the last 40 and drop what was just agreed. */
    var cap = ${Number(max)};
    if (joined.length > cap) joined = '[earlier messages omitted] ' + joined.slice(joined.length - cap);
    return JSON.stringify({ messages: out.length, text: joined });
  }catch(e){ return JSON.stringify({ error: String(e && e.message || e) }); }
})()`.replace(/\n/g, " ");

  const clicked = await evalJson(tab, click);
  if (!clicked || clicked.error) return null;
  await new Promise((r) => setTimeout(r, waitMs));
  const body = await evalJson(tab, read);
  if (!body || body.error || !body.messages) return null;
  return body;
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
      openConversation,
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
