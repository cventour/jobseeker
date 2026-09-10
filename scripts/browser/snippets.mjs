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

// Nothing in here writes page code any more. Every snippet that runs inside a page is a real named
// function in extension/snippets.js — the ONE source of truth, shipped by the extension and
// stringified by the AppleScript driver — and this module only ever names one. That is not a style
// choice: sending JavaScript as a string cannot work under Manifest V3 (measured on Chrome 152; the
// note is in extension/snippets.js), so a composite that built JS text would work on macOS and be
// impossible on Windows.
import snippets from "../../extension/snippets.js";
import { withBrowserLock } from "../../server/lock.mjs";

export const { SNIPPETS } = snippets;

let driver = null;

export function setDriver(d) {
  if (!d || typeof d.runSnippet !== "function") throw new Error("setDriver: not a browser driver");
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
 * Run a NAMED snippet from extension/snippets.js in a tab and return its value.
 * The snippet MUST be read-only. It returns a JSON string for anything structured.
 *
 * The name is checked here as well as in both drivers, so a typo fails in Node with the list of
 * real names rather than as "the page did not answer" after a browser round-trip.
 */
export function runSnippet(tab, name, args = {}) {
  if (!Object.prototype.hasOwnProperty.call(SNIPPETS, name)) {
    throw new Error(`unknown snippet "${name}" (known: ${Object.keys(SNIPPETS).join(", ")})`);
  }
  return getDriver().runSnippet(tab, name, args ?? {});
}

const parseSnippetJson = (raw) => {
  if (!raw || raw === "missing value") return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`extraction did not return JSON (got: ${raw.slice(0, 120)})`);
  }
};

/** runSnippet + JSON.parse. What every structured extraction actually wants. */
export async function snippetJson(tab, name, args = {}) {
  return parseSnippetJson(await runSnippet(tab, name, args));
}

/**
 * RAW string evaluation. Kept because the macOS probe path and any one-off debugging still use it,
 * and because removing an export would break consumers — but it is a macOS-only capability now:
 * the extension driver refuses it with the CSP measurement rather than failing at the far end.
 * Everything in this repo goes through runSnippet/snippetJson instead.
 */
export function evalInTab(tab, js) {
  return getDriver().evalInTab(tab, js);
}

export async function evalJson(tab, js) {
  return parseSnippetJson(await evalInTab(tab, js));
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
      await runSnippet(tab, "pageAlive");
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
  const clicked = await snippetJson(tab, "openConversationClick", {
    listSelector,
    nameSelector: nameSelector || "span[title]",
    name: name || "",
    index: Number(index),
  });
  if (!clicked || clicked.error) return null;
  await new Promise((r) => setTimeout(r, waitMs));
  const body = await snippetJson(tab, "readThreadMessages", { messageSelector, max: Number(max) });
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

/** What a tab is showing, by id. `null` when the tab cannot be found or the driver cannot say. */
async function urlOfTab(d, tab) {
  try {
    const row = (await d.listTabs()).find((t) => String(t.id) === String(tab?.id));
    return row?.url || null;
  } catch {
    return null;
  }
}

/**
 * Wait until a navigated tab has stopped showing `fromUrl`.
 *
 * `loading` alone is not enough: for a moment after the URL is set, Chrome still reports the OLD
 * page, complete and idle, so a naive waitForLoad returns immediately on stale content. Waiting for
 * the URL to CHANGE — rather than to equal the target — is also what survives redirects: a careers
 * page that bounces to a login wall or a regional domain still counts as having moved.
 *
 * Best effort. A tab that cannot be read, or a repeat visit to the same URL, falls through to the
 * caller's own settling wait, which is all there was before this existed.
 */
async function waitForNavigation(d, tab, fromUrl, { timeoutMs = 15_000 } = {}) {
  if (!fromUrl) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await urlOfTab(d, tab);
    if (now === null || now !== fromUrl) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * ONE tab, pointed at each URL in turn, then closed. The frugal alternative to withOwnedTab in a loop.
 *
 * withOwnedTab opens and closes a tab per URL, so a forty-board sweep makes forty tabs appear and
 * vanish in the user's browser. That churn is what users actually complain about, and it buys
 * nothing: a sweep reads one page at a time, so one tab is all it ever needs. Here the user sees a
 * single tab that changes page, and one tab closing at the end.
 *
 * The callback gets `visit(url)`, which returns the tab handle to read from:
 *
 *   await withScratchTab(async ({ visit }) => {
 *     for (const url of urls) {
 *       const tab = await visit(url);
 *       results.push(await snippetJson(tab, "extractPageText", { max: 60_000 }));
 *     }
 *   });
 *
 * Never point a scratch tab at WhatsApp Web (see withOwnedTab): it is single-session, and a tab that
 * navigates away and back is a tab that can steal or drop the user's session.
 */
export async function withScratchTab(fn) {
  const d = getDriver();
  let tab = null;
  let lastUrl = null;

  const visit = async (url) => {
    // Reuse when we can, reopen when we cannot. A scratch tab legitimately disappears mid-sweep —
    // the user closes it, or the Windows extension's service worker restarts and forgets the tab
    // was ours — and that must cost ONE reopen, not the rest of the sweep. It is also the fallback
    // for an older bridge extension that has no navigateTab at all: it answers "unknown method",
    // and the run degrades to exactly the tab-per-URL behaviour it had before.
    if (tab && typeof d.navigateTab === "function") {
      // What the tab shows RIGHT NOW, captured before we move it. A fresh tab cannot show you the
      // previous page; a reused one can, for as long as Chrome takes to commit the navigation — so
      // the previous URL is the thing to wait to stop seeing. Without this a sweep would happily
      // attribute one company's careers page to the next company in the list.
      const before = await urlOfTab(d, tab);
      try {
        tab = await d.navigateTab(tab, url);
        await waitForNavigation(d, tab, before);
      } catch {
        tab = null;
      }
    } else {
      tab = null;
    }
    if (!tab) tab = await d.openTab(url);
    lastUrl = url;
    await waitForLoad(tab);
    return tab;
  };

  try {
    return await fn({ visit });
  } finally {
    // Close by id, not by URL: after a sweep the tab is sitting on the LAST url it visited, and a
    // URL-prefix close could take one of the user's tabs with it.
    //
    // The URL fallback is for one real case: a Windows bridge extension too old to know closeTab.
    // It is the weaker close — a user tab on the same URL goes with ours — but leaving a tab behind
    // every sweep is exactly the complaint this change exists to answer, so it is the better risk.
    if (tab) {
      try {
        await d.closeTab(tab);
      } catch {
        if (lastUrl) await d.closeTabsByUrl(lastUrl).catch(() => {});
      }
    }
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
    const hit = await runSnippet(tab, "hasSelector", { selector });
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
      runSnippet,
      snippetJson,
      // Raw evaluation, macOS only (see evalInTab above). Kept on the context so nothing that held
      // a reference breaks; everything in this repo uses runSnippet/snippetJson.
      evalInTab,
      evalJson,
      withOwnedTab,
      withScratchTab,
      waitForSelector,
      openConversation,
    });
  });
}
