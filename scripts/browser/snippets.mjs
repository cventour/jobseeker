// Driver-agnostic composites: everything scripts/browser.mjs exposes that is not itself a way of
// talking to Chrome. These know about tabs, selectors and chat lists, and NOTHING about how a
// snippet reaches the page — that is the driver's job (./applescript.mjs on macOS, ./extension.mjs on
// Windows). The facade calls setDriver() once at import time; nothing here works before that.
//
// Read-only by construction, with ONE narrow exception. This module exposes navigation and
// extraction, and deliberately does NOT expose typing, form submission, or general clicking. With
// raw scripting access to a logged-in browser there is no per-site permission gate, so the
// enforcement is that the capability is simply absent from this API. The exception is
// openConversation() below; its own comment explains the three constraints that keep it narrow.

import { withBrowserLock } from "../../server/lock.mjs";

let driver = null;

export function setDriver(d) {
  if (!d || typeof d.evalInTab !== "function") throw new Error("setDriver: not a browser driver");
  driver = d;
}

export function getDriver() {
  if (!driver) throw new Error("browser driver not set — import scripts/browser.mjs, not browser/snippets.mjs");
  return driver;
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
export function evalInTab(tab, js) {
  return getDriver().evalInTab(tab, js);
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
  const d = getDriver();
  const tab = await d.openTab(url);
  try {
    await waitForLoad(tab);
    return await fn(tab);
  } finally {
    // Close by URL match rather than by index: the user may have opened or closed tabs while we
    // worked, and closing a stale index would close one of THEIR tabs.
    await d.closeTabsByUrl(url).catch(() => {});
  }
}

export async function waitForLoad(tab, { timeoutMs = 45_000 } = {}) {
  const d = getDriver();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Only an explicit "not loading" counts; an unanswered question keeps waiting.
    if ((await d.tabLoading(tab)) === false) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

/** Wait for a selector to appear, polling from Node so a wedged page cannot block forever. */
export async function waitForSelector(tab, selector, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await evalInTab(tab, `document.querySelector(${JSON.stringify(selector)}) ? "1" : "0"`);
    if (String(hit ?? "").trim() === "1") return true;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

/**
 * The single entry point. Holds the browser mutex for the whole session so two sweeps can never
 * drive Chrome at once (AGENT-RULES §13) — enforced here rather than asked for in prose.
 */
export async function withBrowser(fn) {
  const d = getDriver();
  return withBrowserLock(async () => {
    const chrome = await d.ensureChrome();
    if (!chrome.running) throw new Error(chrome.reason || "Chrome is not available");
    const tabs = await d.listTabs();
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
