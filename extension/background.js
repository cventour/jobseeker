// JobSeeker Bridge — service worker.
//
// This is the Windows (and any-OS) twin of scripts/browser.mjs's Apple Events layer. Node cannot
// script Chrome on Windows without a debugging port, and a debugging port lets ANY local process
// drive the browser as the user. So instead the extension polls the local dashboard for commands
// and runs them itself; the only process that can hand it a command is the one that holds the
// bearer token issued at pairing time, and the dashboard pins our Origin (chrome-extension://<id>).
//
// Read-only by construction, same rule as browser.mjs. The method allowlist below exposes tab
// listing, page evaluation, opening/closing tabs we own, and a load probe — and deliberately does
// NOT expose typing, form submission, or clicking. The one constrained click that exists in the
// system (openConversation) is a Node-side snippet that runs THROUGH evalInTab and carries its own
// guards; it is not an extension capability and nothing here can widen it.
//
// Protocol (frozen; server/bridge.mjs implements the other side):
//   GET  /bridge/status              -> {paired, connected, lastSeen, extensionId, pending, version:"1"}
//   POST /bridge/pair   {code}       -> {token}
//   GET  /bridge/poll   Bearer token -> 200 {id, method, params, timeoutMs} | 204 nothing yet | 403 bad token
//   POST /bridge/result Bearer token   {id, ok, result?, error?}

"use strict";

const DEFAULT_PORTS = [4319, 4320];
const BACKOFF_MS = [1000, 2000, 5000, 15000];
// Client-side cap on a single long-poll. A service worker whose only activity is one pending fetch
// can be torn down around the 30 s idle mark, so we come back for air before that and let the
// server queue whatever arrives in the gap.
const POLL_CAP_MS = 25000;

// ---------- settings + status ----------

async function getSettings() {
  const s = await chrome.storage.local.get(["ports", "token", "lastGoodPort"]);
  const ports = Array.isArray(s.ports) && s.ports.length ? s.ports.map(Number).filter(Boolean) : DEFAULT_PORTS.slice();
  return { ports, token: s.token || null, lastGoodPort: s.lastGoodPort ? Number(s.lastGoodPort) : null };
}

// Status lives in storage.session (survives worker restarts, dies with the browser) and is served
// to the options page over runtime messaging. storage.local is the fallback for Chrome builds
// where storage.session is missing.
const statusStore = chrome.storage.session || chrome.storage.local;
let status = { state: "no-bridge", port: null, lastSeen: null, lastError: null };

async function setStatus(patch) {
  status = { ...status, ...patch };
  try {
    await statusStore.set({ bridgeStatus: status });
  } catch {
    /* best effort */
  }
  return status;
}

async function loadStatus() {
  try {
    const s = await statusStore.get("bridgeStatus");
    if (s && s.bridgeStatus) status = { ...status, ...s.bridgeStatus };
  } catch {
    /* keep defaults */
  }
}

// ---------- bridge HTTP ----------

const base = (port) => `http://127.0.0.1:${port}`;

async function fetchJson(url, init = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    let body = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { res, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask one port whether a bridge answers there. Returns the status object or null. */
async function probePort(port) {
  try {
    const { res, body } = await fetchJson(`${base(port)}/bridge/status`);
    if (!res.ok || !body || body.version !== "1") return null;
    return body;
  } catch {
    return null;
  }
}

/** Find the bridge: lastGoodPort first, then every configured port. Returns a port or null. */
async function discover() {
  const { ports, lastGoodPort } = await getSettings();
  const order = [];
  if (lastGoodPort) order.push(lastGoodPort);
  for (const p of ports) if (!order.includes(p)) order.push(p);
  for (const port of order) {
    const st = await probePort(port);
    if (st) {
      if (port !== lastGoodPort) await chrome.storage.local.set({ lastGoodPort: port });
      return { port, status: st };
    }
  }
  return null;
}

/** Exchange the 6-digit code shown on the dashboard for a bearer token. */
async function pair(port, code) {
  const target = Number(port) || (await discover())?.port;
  if (!target) throw new Error("No JobSeeker dashboard is running on this computer.");
  const { res, body } = await fetchJson(
    `${base(target)}/bridge/pair`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: String(code) }) },
    8000
  );
  if (!res.ok || !body || !body.token) {
    const msg = (body && (body.error || body.message)) || `pairing refused (HTTP ${res.status})`;
    throw new Error(msg);
  }
  await chrome.storage.local.set({ token: body.token, lastGoodPort: target });
  await setStatus({ state: "connected", port: target, lastError: null, lastSeen: Date.now() });
  return { port: target };
}

// ---------- tab helpers ----------

/** Every tab with the same 1-based window/tab indices Node used to get from Apple Events. */
async function listTabs() {
  const windows = await chrome.windows.getAll({ populate: true });
  const out = [];
  windows.forEach((w, wi) => {
    (w.tabs || []).forEach((t, ti) => {
      out.push({
        id: t.id,
        windowId: w.id,
        window: wi + 1,
        tab: ti + 1,
        active: Boolean(t.active),
        url: t.url || "",
        title: t.title || "",
      });
    });
  });
  return out;
}

async function indicesFor(tabId) {
  const all = await listTabs();
  const hit = all.find((t) => t.id === tabId);
  return hit ? { window: hit.window, tab: hit.tab } : { window: null, tab: null };
}

// Injected into the page. Must be self-contained: chrome.scripting serialises the function source,
// so nothing from this file's scope is reachable inside it.
//
// The snippet is evaluated as a PROGRAM whose completion value is returned — exactly what
// AppleScript's `execute javascript` did — so the existing Node snippets ("(function(){...})()",
// "document.title", `document.querySelector(...) ? "1" : "0"`) run unchanged.
//
// Which evaluator Chrome allows is the open question this file cannot settle without a browser:
//   1. Indirect eval in the ISOLATED world. MV3 applies the extension's own CSP (script-src 'self',
//      no 'unsafe-eval', and Chrome refuses to relax it) to content-script isolated worlds since the
//      "isolated world CSP" change, so this is EXPECTED to throw an EvalError.
//   2. new Function(...) in the ISOLATED world. Same CSP directive governs it; expected to fail too.
//   3. The MAIN world (page's own JS context). There the PAGE's CSP decides. WhatsApp Web and LinkedIn
//      both ship a CSP, and whether it carries 'unsafe-eval' has to be observed on a real Chrome.
// The dispatcher tries 1, then 2 in ISOLATED, then 1 again in MAIN, and reports which one was
// refused. If all three are refused on the target sites the design falls back to shipping the
// snippets inside the extension:
//   TODO(runSnippet): add method runSnippet {name, args} that executes a named function from a
//   snippets.js bundled here (no string evaluation at all), and have Node call it instead of
//   evalInTab for WhatsApp/LinkedIn extraction. Not implemented until the eval path is measured.
function pageEval(src, mode) {
  // Errors are RETURNED, not thrown: on Chrome builds that predate InjectionResult.error a thrown
  // exception would resolve as `result: undefined`, indistinguishable from a snippet that returned
  // null, and the CSP fallback chain in evalInTab would never run.
  try {
    let v;
    if (mode === "function") {
      v = new Function("return (" + src + ")")();
    } else {
      v = (0, eval)(src);
    }
    return { ok: true, value: typeof v === "string" ? v : v === undefined || v === null ? null : JSON.stringify(v) };
  } catch (e) {
    return { ok: false, error: String((e && (e.message || e.name)) || e), name: e && e.name };
  }
}

const CSP_BLOCKED = /unsafe-eval|Content Security Policy|EvalError|Refused to evaluate/i;

async function evalInTab({ tabId, js }) {
  if (typeof tabId !== "number") throw new Error("evalInTab: tabId must be a number");
  if (typeof js !== "string") throw new Error("evalInTab: js must be a string");
  const attempts = [
    { world: "ISOLATED", mode: "eval" },
    { world: "ISOLATED", mode: "function" },
    { world: "MAIN", mode: "eval" },
  ];
  const refused = [];
  for (const a of attempts) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: a.world,
        func: pageEval,
        args: [js, a.mode],
      });
      const first = results && results[0];
      if (first && first.error) throw new Error(first.error.message || String(first.error));
      const r = first ? first.result : null;
      if (!r || typeof r !== "object") {
        // No frame answered (discarded tab, page mid-navigation). Not a CSP matter; do not retry.
        throw new Error("the page did not answer (tab discarded or still loading)");
      }
      if (r.ok) return { value: r.value === undefined ? null : r.value, via: `${a.world}/${a.mode}` };
      if (r.name === "EvalError" || CSP_BLOCKED.test(r.error)) {
        refused.push(`${a.world}/${a.mode}`);
        continue;
      }
      // The snippet itself threw — that is the caller's bug, surface it verbatim.
      throw new Error(`snippet threw: ${r.error}`);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/^snippet threw|did not answer/.test(msg)) throw e;
      if (CSP_BLOCKED.test(msg)) {
        refused.push(`${a.world}/${a.mode}`);
        continue;
      }
      throw new Error(mapScriptingError(msg));
    }
  }
  throw new Error(
    `this page's Content Security Policy refuses string evaluation (${refused.join(", ")}). ` +
      "See TODO(runSnippet) in background.js."
  );
}

function mapScriptingError(msg) {
  if (/Cannot access contents of (url|the page)|must request permission|host permission/i.test(msg)) {
    return (
      "JobSeeker Bridge is not allowed to read this site. Open the extension's options and choose " +
      '"Also let it read careers pages", or add the site to its permitted hosts.'
    );
  }
  if (/chrome:\/\/|chrome-extension:\/\/|Cannot access a chrome/i.test(msg)) {
    return "Chrome does not let extensions read its own pages (chrome:// and similar).";
  }
  if (/No tab with id|discarded|Frame with ID|not loaded/i.test(msg)) {
    return `tab is not available (${msg}). It may have been closed or discarded to save memory.`;
  }
  return msg;
}

async function openTab({ url }) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("openTab: url must be http(s)");
  const tab = await chrome.tabs.create({ url, active: false });
  const idx = await indicesFor(tab.id);
  return { tabId: tab.id, ...idx };
}

async function closeTabsByUrlPrefix({ prefix }) {
  if (typeof prefix !== "string" || !prefix) throw new Error("closeTabsByUrlPrefix: prefix required");
  const tabs = await chrome.tabs.query({});
  const ids = tabs.filter((t) => (t.url || "").startsWith(prefix)).map((t) => t.id);
  if (ids.length) await chrome.tabs.remove(ids);
  return { closed: ids.length };
}

async function tabLoading({ tabId }) {
  const tab = await chrome.tabs.get(tabId);
  return { loading: tab.status !== "complete" };
}

// The allowlist. Anything not named here is refused with "unknown method"; there is no generic
// "click", "type" or "submit" and none should ever be added.
const METHODS = {
  ping: async () => ({ version: chrome.runtime.getManifest().version, chrome: navigator.userAgent }),
  listTabs: async () => listTabs(),
  evalInTab: async (p) => evalInTab(p || {}),
  openTab: async (p) => openTab(p || {}),
  closeTabsByUrlPrefix: async (p) => closeTabsByUrlPrefix(p || {}),
  tabLoading: async (p) => tabLoading(p || {}),
};

async function dispatch(cmd) {
  const fn = Object.prototype.hasOwnProperty.call(METHODS, cmd.method) ? METHODS[cmd.method] : null;
  if (!fn) return { id: cmd.id, ok: false, error: "unknown method" };
  const timeoutMs = Number(cmd.timeoutMs) > 0 ? Number(cmd.timeoutMs) : 30000;
  try {
    const result = await Promise.race([
      fn(cmd.params),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${cmd.method} timed out after ${timeoutMs} ms`)), timeoutMs)),
    ]);
    return { id: cmd.id, ok: true, result };
  } catch (e) {
    return { id: cmd.id, ok: false, error: String((e && e.message) || e) };
  }
}

// ---------- the poll loop ----------

let running = false;
let generation = 0;

async function runLoop() {
  if (running) return;
  running = true;
  const mine = ++generation;
  let backoff = 0;
  try {
    while (mine === generation) {
      const { token } = await getSettings();
      if (!token) {
        const found = await discover();
        await setStatus({ state: found ? "not-paired" : "no-bridge", port: found ? found.port : null });
        return; // storage.onChanged restarts us when a token arrives
      }
      const found = await discover();
      if (!found) {
        await setStatus({ state: "no-bridge", port: null, lastError: "no dashboard answered" });
        await sleep(BACKOFF_MS[Math.min(backoff++, BACKOFF_MS.length - 1)]);
        continue;
      }
      const port = found.port;
      backoff = 0;
      await setStatus({ state: "connected", port, lastError: null, lastSeen: Date.now() });

      // Poll this port until it fails, then rediscover.
      while (mine === generation) {
        let res, body;
        try {
          ({ res, body } = await fetchJson(
            `${base(port)}/bridge/poll`,
            { headers: { authorization: `Bearer ${token}` } },
            POLL_CAP_MS
          ));
        } catch (e) {
          if (e && e.name === "AbortError") continue; // our own cap; nothing arrived, poll again
          await setStatus({ state: "error", lastError: `poll failed: ${String((e && e.message) || e)}` });
          break; // back to discovery with backoff
        }
        if (res.status === 403) {
          await chrome.storage.local.remove("token");
          await setStatus({ state: "not-paired", port, lastError: "the dashboard no longer recognises this pairing" });
          return;
        }
        if (res.status === 204) {
          await setStatus({ lastSeen: Date.now() });
          continue;
        }
        if (!res.ok || !body || !body.id) {
          await setStatus({ state: "error", lastError: `unexpected poll response (HTTP ${res.status})` });
          await sleep(1000);
          break;
        }
        await setStatus({ state: "connected", lastSeen: Date.now(), lastError: null });
        const out = await dispatch(body);
        try {
          await fetchJson(
            `${base(port)}/bridge/result`,
            {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
              body: JSON.stringify(out),
            },
            8000
          );
        } catch (e) {
          await setStatus({ state: "error", lastError: `result post failed: ${String((e && e.message) || e)}` });
          break;
        }
      }
      await sleep(BACKOFF_MS[Math.min(backoff++, BACKOFF_MS.length - 1)]);
    }
  } finally {
    if (mine === generation) running = false;
  }
}

function restartLoop() {
  generation++; // any loop in flight sees the change at its next iteration and exits
  running = false;
  runLoop();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- lifecycle ----------

function ensureAlarm() {
  chrome.alarms.create("bridge-tick", { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  loadStatus().then(runLoop);
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  loadStatus().then(runLoop);
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "bridge-tick") runLoop();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ("token" in changes || "ports" in changes)) restartLoop();
});

// Options page messaging.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "status": {
        if (status.state === "no-bridge" || status.state === "not-paired") {
          // Cheap refresh so the options page does not show a stale "no dashboard" after the user starts one.
          const found = await discover();
          const { token } = await getSettings();
          await setStatus({
            state: found ? (token ? status.state : "not-paired") : "no-bridge",
            port: found ? found.port : null,
          });
          if (found && token) runLoop();
        }
        const settings = await getSettings();
        return { ...status, paired: Boolean(settings.token), ports: settings.ports, extensionId: chrome.runtime.id };
      }
      case "pair": {
        const r = await pair(msg.port, msg.code);
        restartLoop();
        return { ok: true, ...r };
      }
      case "forget": {
        generation++;
        running = false;
        await chrome.storage.local.remove(["token", "lastGoodPort"]);
        await setStatus({ state: "not-paired", lastError: null });
        return { ok: true };
      }
      case "setPort": {
        const port = Number(msg.port);
        if (!port || port < 1 || port > 65535) throw new Error("port must be 1-65535");
        const { ports } = await getSettings();
        const next = [port, ...ports.filter((p) => p !== port)];
        await chrome.storage.local.set({ ports: next });
        return { ok: true, ports: next };
      }
      default:
        throw new Error("unknown message");
    }
  })().then(
    (r) => sendResponse(r),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
  );
  return true; // async response
});

// A worker woken for any reason should make sure the loop is alive.
ensureAlarm();
loadStatus().then(runLoop);
