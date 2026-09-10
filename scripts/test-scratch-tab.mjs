#!/usr/bin/env node
// Guards withScratchTab — the reason a sweep of forty careers pages uses ONE tab instead of forty.
//
// Three properties, each of which fails quietly if it breaks:
//   1. It reuses the tab. Regress this and the user gets their wall of tabs back, and nothing errors.
//   2. It never reads the PREVIOUS page. Chrome keeps serving the old page for a moment after the
//      URL is set, so a reused tab can hand one company's careers page to the next company in the
//      list — a wrong answer that looks exactly like a right one. (A fresh tab could not do this,
//      which is why the guard arrived with the reuse.)
//   3. It closes what it opened, by id, even when the body throws.
// And one recovery: a tab that disappears mid-sweep — the user closed it, or the Windows
// extension's service worker restarted and forgot the tab was ours — costs one reopen, not the run.
//
// Driver-level, with a fake driver: no Chrome, no permissions, nothing to log into.
//
//   npm run test:scratch

import { setDriver, withScratchTab } from "./browser/snippets.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

/**
 * A Chrome that commits navigations LATE: the tab keeps reporting the old URL, and serving the old
 * page, for `lagTicks` polls after it is told to move. That lag is the real behaviour the guard
 * exists for, so the fake has it by default.
 */
function fakeChrome({ lagTicks = 2, loseTabAfter = null, noNavigateTab = false, noCloseTab = false } = {}) {
  const state = { tabs: new Map(), nextId: 1, opened: [], closed: [], closedByUrl: [], navigations: 0, visits: 0 };
  let pending = null;

  const settle = () => {
    if (!pending) return;
    if (pending.ticks > 0) {
      pending.ticks--;
      return;
    }
    const t = state.tabs.get(pending.id);
    if (t) t.url = pending.url;
    pending = null;
  };

  const driver = {
    name: "fake",
    runSnippet: async () => "1",
    async listTabs() {
      settle();
      return [...state.tabs.values()].map((t) => ({ ...t }));
    },
    async openTab(url) {
      const id = String(state.nextId++);
      state.tabs.set(id, { id, window: 1, tab: state.tabs.size + 1, url });
      state.opened.push(url);
      return { id, window: 1, tab: state.tabs.size };
    },
    async closeTab(tab) {
      // An old bridge extension answers "unknown method" here, which is why this is allowed to throw.
      if (noCloseTab) throw new Error("unknown method");
      state.closed.push(String(tab.id));
      state.tabs.delete(String(tab.id));
    },
    async closeTabsByUrl(url) {
      state.closedByUrl.push(url);
      for (const [id, t] of state.tabs) if (String(t.url).startsWith(url)) state.tabs.delete(id);
    },
    async tabLoading() {
      return false;
    },
  };

  if (!noNavigateTab) {
    driver.navigateTab = async (tab, url) => {
      const id = String(tab?.id);
      state.navigations++;
      if (!state.tabs.has(id)) throw new Error(`tab ${id} is no longer open`);
      pending = { id, url, ticks: lagTicks };
      return { ...state.tabs.get(id) };
    };
  }

  // The page a read would actually see right now, which is the point of the whole exercise.
  const pageOf = (tab) => state.tabs.get(String(tab.id))?.url ?? null;

  const visitAndRead = async (visit, url) => {
    const tab = await visit(url);
    state.visits++;
    const saw = pageOf(tab);
    // Losing the tab AFTER the read is the real sequence: the user closes it while we are between
    // boards, not while we are reading one.
    if (loseTabAfter != null && state.visits === loseTabAfter) state.tabs.delete(String(tab.id));
    return { tab, saw };
  };

  return { driver, state, visitAndRead };
}

async function main() {
  console.log("\nwithScratchTab\n");

  const URLS = ["https://a.example/careers", "https://b.example/careers", "https://c.example/jobs"];

  // 1 + 2 + 3: one tab, correct page every time, closed at the end.
  {
    const { driver, state, visitAndRead } = fakeChrome();
    setDriver(driver);
    const seen = [];
    const ids = new Set();
    await withScratchTab(async ({ visit }) => {
      for (const url of URLS) {
        const { tab, saw } = await visitAndRead(visit, url);
        ids.add(String(tab.id));
        seen.push(saw);
      }
    });
    check("three pages are read through ONE tab", ids.size === 1, `${ids.size} tab(s), ${state.opened.length} opened`);
    check("the tab is navigated, not reopened", state.navigations === 2 && state.opened.length === 1);
    check(
      "every read sees its OWN page, never the previous one",
      seen.join() === URLS.join(),
      seen.join(" | ")
    );
    check("the tab is closed by id at the end", state.closed.length === 1);
  }

  // The stale-page guard is load-bearing: without the wait, the fake serves the previous page.
  {
    const { driver, state } = fakeChrome({ lagTicks: 3 });
    setDriver(driver);
    const first = await driver.openTab(URLS[0]);
    await driver.navigateTab(first, URLS[1]);
    const now = (await driver.listTabs()).find((t) => t.id === first.id).url;
    check(
      "the fake really does lag (so the test above is testing something)",
      now === URLS[0],
      `showed ${now}`
    );
    await driver.closeTab(first);
    void state;
  }

  // A tab that vanishes mid-sweep costs one reopen — not the rest of the boards.
  {
    const { driver, state, visitAndRead } = fakeChrome({ loseTabAfter: 1 });
    setDriver(driver);
    const seen = [];
    await withScratchTab(async ({ visit }) => {
      for (const url of URLS) seen.push((await visitAndRead(visit, url)).saw);
    });
    check("a tab closed mid-sweep is reopened once", state.opened.length === 2, `${state.opened.length} opens`);
    check("and the sweep still reads every page", seen.join() === URLS.join(), seen.join(" | "));
  }

  // An older bridge extension has no navigateTab at all. It must degrade to the old tab-per-URL
  // behaviour rather than fail the run.
  {
    const { driver, state, visitAndRead } = fakeChrome({ noNavigateTab: true });
    setDriver(driver);
    const seen = [];
    await withScratchTab(async ({ visit }) => {
      for (const url of URLS) seen.push((await visitAndRead(visit, url)).saw);
    });
    check("a driver without navigateTab still works", seen.join() === URLS.join(), seen.join(" | "));
    check("…by opening a tab per URL, as before", state.opened.length === 3, `${state.opened.length} opens`);
  }

  // An extension too old to know closeTab must still not leave the tab behind.
  {
    const { driver, state, visitAndRead } = fakeChrome({ noCloseTab: true });
    setDriver(driver);
    await withScratchTab(async ({ visit }) => {
      for (const url of URLS) await visitAndRead(visit, url);
    });
    check(
      "a driver that cannot close by id falls back to closing by URL",
      state.closedByUrl.length === 1 && state.closedByUrl[0] === URLS[2],
      state.closedByUrl.join(" | ") || "nothing closed"
    );
    check("…and no tab is left behind", state.tabs.size === 0, `${state.tabs.size} left`);
  }

  // A body that throws must not leak the tab.
  {
    const { driver, state } = fakeChrome();
    setDriver(driver);
    let threw = false;
    await withScratchTab(async ({ visit }) => {
      await visit(URLS[0]);
      throw new Error("board exploded");
    }).catch(() => (threw = true));
    check("a failing sweep still closes its tab", threw && state.closed.length === 1);
  }

  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-scratch-tab error:", e?.message || e);
  process.exit(1);
});
