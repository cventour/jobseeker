// JobSeeker Bridge — service worker.
//
// This is the Windows (and any-OS) twin of scripts/browser.mjs's Apple Events layer. Node cannot
// script Chrome on Windows without a debugging port, and a debugging port lets ANY local process
// drive the browser as the user. So instead the extension polls the local dashboard for commands
// and runs them itself; the only process that can hand it a command is the one that holds the
// bearer token issued at pairing time, and the dashboard pins our Origin (chrome-extension://<id>).
//
// Read-only by construction, same rule as browser.mjs. The method allowlist below exposes tab
// listing, running a NAMED snippet, opening/closing tabs we own, and a load probe — and deliberately
// does NOT expose typing, form submission, or clicking. The one constrained click that exists in the
// system (openConversationClick) is one of the named snippets in snippets.js and carries its own
// three guards; there is no generic click method here and nothing on this side can widen it.
//
// Node never sends JavaScript as a STRING. It cannot: measured on Windows 11, Chrome 152.0.7977.83,
// with this extension loaded and paired, https://web.whatsapp.com/ — a host in our own
// host_permissions — refused all three routes ("Content Security Policy refuses string evaluation
// (ISOLATED/eval, ISOLATED/function, MAIN/eval)"). Indirect eval and new Function are governed by the
// extension's own MV3 CSP in the isolated world, and the MAIN world is governed by the page's CSP.
// What works — it is how that failing probe itself ran — is chrome.scripting.executeScript with a
// real `func` reference, so runSnippet below does exactly that. snippets.js is the one source of
// truth for that code and the macOS driver stringifies the SAME functions.
//
// Protocol (frozen; server/bridge.mjs implements the other side):
//   GET  /bridge/status              -> {paired, connected, lastSeen, extensionId, pending, version:"1"}
//   POST /bridge/pair   {code}       -> {token}
//   GET  /bridge/poll   Bearer token -> 200 {id, method, params, timeoutMs} | 204 nothing yet | 403 bad token
//   POST /bridge/result Bearer token   {id, ok, result?, error?}

"use strict";

// The page snippets, shared verbatim with the Node side (scripts/browser/applescript.mjs imports the
// same file). A classic service worker can pull in a classic script, which keeps the manifest's
// background entry unchanged — no "type": "module" needed, so service-worker registration is exactly
// what it was. snippets.js publishes `self.SNIPPETS` when there is no CommonJS `module` around.
importScripts("snippets.js");

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

/**
 * Run a named snippet from snippets.js in a tab.
 *
 * `func` is a REAL function reference from this extension's own code, which is the only thing MV3
 * allows (see the measurement at the top of this file). chrome.scripting serialises that function
 * and runs it in the ISOLATED world, so it must be self-contained — nothing from snippets.js's own
 * scope is reachable inside it. `args` is passed through structured clone, so it must be JSON-shaped.
 *
 * The value comes back as a string, matching what AppleScript's `execute javascript` returns on
 * macOS; anything structured is JSON-stringified by the snippet itself.
 */
async function runSnippet({ tabId, name, args }) {
  if (typeof tabId !== "number") throw new Error("runSnippet: tabId must be a number");
  const known = (typeof SNIPPETS !== "undefined" && SNIPPETS) || {};
  const fn = Object.prototype.hasOwnProperty.call(known, name) ? known[name] : null;
  if (!fn) {
    throw new Error(`runSnippet: unknown snippet "${String(name)}" (known: ${Object.keys(known).join(", ") || "none"})`);
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: fn,
      args: [args && typeof args === "object" ? args : {}],
    });
  } catch (e) {
    throw new Error(mapScriptingError(String((e && e.message) || e)));
  }
  const first = results && results[0];
  // Chrome builds that predate InjectionResult.error report a thrown snippet as `result: undefined`,
  // so check both shapes rather than trusting either one alone.
  if (first && first.error) throw new Error(mapScriptingError(first.error.message || String(first.error)));
  if (!first) throw new Error("the page did not answer (tab discarded or still loading)");
  const v = first.result;
  return { value: v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v) };
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
  runSnippet: async (p) => runSnippet(p || {}),
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
          // The poll carries this worker's own view of the world, so it lands in the bridge's log
          // on disk. Nothing else the service worker knows survives it being torn down, and its
          // options page is not reachable from a terminal -- which is exactly where someone
          // debugging "it says connected but nothing happens" is sitting.
          const said = new URLSearchParams({ s: status.state || "?" });
          if (status.lastError) said.set("e", String(status.lastError).slice(0, 160));
          ({ res, body } = await fetchJson(
            `${base(port)}/bridge/poll?${said}`,
            { headers: { authorization: `Bearer ${token}` } },
            POLL_CAP_MS
          ));
        } catch (e) {
          if (e && e.name === "AbortError") continue; // our own cap; nothing arrived, poll again
          await setStatus({ state: "error", lastError: `poll failed: ${String((e && e.message) || e)}` });
          break; // back to discovery with backoff
        }
        if (res.status === 403) {
          // Stop, and say so, but KEEP the token. A refusal is not proof the pairing is gone: the
          // dashboard may have been restarting mid-request, or another JobSeeker may have answered
          // on this port for a moment. Deleting the credential on a single refusal turns a blip
          // into "set it up again", and the user has no way to tell the two apart. Forgetting a
          // pairing is a decision, so it stays on the Forget button in the options page.
          await setStatus({
            state: "refused",
            port,
            lastError:
              "the dashboard refused this pairing. If this persists, use Forget pairing and connect again.",
          });
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
