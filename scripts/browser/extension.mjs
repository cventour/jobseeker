// The Windows driver: Chrome through the JobSeeker Bridge extension, over a localhost bridge.
//
// Windows has no Apple Events, and CDP is ruled out for the same reasons the facade header gives
// (a debugging port needs a non-default profile, which is what would make WhatsApp show a QR code).
// So the browser side is an ordinary Chrome extension the user loads once and pairs from
// Settings ▸ Browser ▸ Connect. It long-polls `node server/bridge.mjs` over loopback HTTP, and this module
// makes plain HTTP calls to that bridge:
//
//   GET  /bridge/status                 → { connected, extensionId, ... }
//   POST /bridge/call  {method, params, timeoutMs}  Authorization: Bearer <data/.bridge.token>
//                                       → { ok, result } | { ok:false, error }; 503 = no extension
//
// Methods: ping, listTabs, evalInTab, openTab, closeTabsByUrlPrefix, tabLoading. The extension
// JSON-stringifies any non-string page result, so evalInTab returns exactly what the AppleScript
// path returns — a string — and the composites in ./snippets.mjs need no per-driver branches.
//
// Same read-only surface as the macOS driver: no typing, no form submission, no general clicking.
// The bridge exposes only the methods listed above, so the constraint holds on the wire as well.

import { execFile, spawn } from "child_process";
import { promises as fs, existsSync } from "fs";
import path from "path";
import { IS_WIN, ROOT, run, spawnNodeDetached } from "../../server/platform.mjs";

const DATA = path.join(ROOT, "data");
const CONFIG = path.join(ROOT, "config", "job-seeker.config.md");
const BRIDGE_JSON = path.join(DATA, ".bridge.json");
const BRIDGE_TOKEN = path.join(DATA, ".bridge.token");
const DEFAULT_DASHBOARD_PORT = 4319;
const DEFAULT_BRIDGE_PORT = 4320;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The same one-line read server/config.mjs and scripts/setup-step.sh do — the port is a plain
// frontmatter scalar and this module must not pull in the Markdown parser just to find it.
async function dashboardPort() {
  try {
    const m = /^dashboard_port:\s*(\d+)/m.exec(await fs.readFile(CONFIG, "utf8"));
    if (m) return Number(m[1]);
  } catch {
    /* no config → default */
  }
  return DEFAULT_DASHBOARD_PORT;
}

async function readBridgeJson() {
  try {
    const j = JSON.parse(await fs.readFile(BRIDGE_JSON, "utf8"));
    return j && Number(j.port) ? j : null;
  } catch {
    return null;
  }
}

async function getStatus(base, { timeoutMs = 3000 } = {}) {
  try {
    const res = await fetch(`${base}/bridge/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reachable: false, reason: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    return { reachable: true, ...body };
  } catch (e) {
    const code = e?.cause?.code || e?.code || e?.name || "";
    return {
      reachable: false,
      reason: code === "TimeoutError" ? "timeout" : code || String(e?.message || e),
    };
  }
}

// Resolved once per process. The dashboard hosts the bridge when it is running (same port, so one
// pairing serves both); a standalone bridge is spawned only when nothing answers there.
let basePromise = null;

async function resolveBase() {
  const candidates = [];
  candidates.push(`http://127.0.0.1:${await dashboardPort()}`);
  const known = await readBridgeJson();
  if (known) candidates.push(`http://127.0.0.1:${known.port}`);

  for (const base of candidates) {
    if ((await getStatus(base)).reachable) return base;
  }

  // Nothing is listening: start a standalone bridge and wait for it to publish its port.
  const before = known?.started || null;
  spawnNodeDetached(path.join("server", "bridge.mjs"), ["--serve"]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(250);
    const j = await readBridgeJson();
    if (j && j.started !== before) {
      const base = `http://127.0.0.1:${j.port}`;
      if ((await getStatus(base, { timeoutMs: 1500 })).reachable) return base;
    }
  }
  // Last resort: the documented default. Callers get a precise connection error from there.
  const fallback = `http://127.0.0.1:${(await readBridgeJson())?.port || DEFAULT_BRIDGE_PORT}`;
  if ((await getStatus(fallback)).reachable) return fallback;
  throw new Error(
    "JobSeeker Bridge is not running and could not be started (node server/bridge.mjs --serve). " +
      "Start the dashboard, or run `npm run bridge`."
  );
}

function bridgeBase() {
  if (!basePromise) {
    basePromise = resolveBase().catch((e) => {
      basePromise = null; // let the next call try again rather than caching a failure forever
      throw e;
    });
  }
  return basePromise;
}

async function token() {
  try {
    const t = (await fs.readFile(BRIDGE_TOKEN, "utf8")).trim();
    if (t) return t;
  } catch {
    /* fall through */
  }
  throw new Error(
    "JobSeeker Bridge extension is not paired: open the dashboard and use Settings ▸ Browser ▸ Connect, " +
      "then load the extension in Chrome (data/.bridge.token is missing)."
  );
}

const NOT_CONNECTED =
  "JobSeeker Bridge extension is not connected (is Chrome running with the extension enabled?)";

/** One bridge call. Throws a precise Error for every failure shape the bridge can produce. */
export async function call(method, params = {}, { timeoutMs = 30_000 } = {}) {
  const base = await bridgeBase();
  const auth = await token();
  let res;
  try {
    res = await fetch(`${base}/bridge/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify({ method, params, timeoutMs }),
      // The bridge enforces timeoutMs itself; give it a little headroom before we give up locally.
      signal: AbortSignal.timeout(timeoutMs + 5000),
    });
  } catch (e) {
    throw new Error(`JobSeeker Bridge unreachable at ${base}: ${e?.cause?.code || e?.message || e}`);
  }
  if (res.status === 503) throw new Error(NOT_CONNECTED);
  // 504 is the bridge saying the extension never answered — the same "tab is asleep" shape as an
  // Apple Event timing out, so word it the way evalInTab() expects to translate.
  if (res.status === 504) throw new Error(`${method} timed out waiting for the extension (${timeoutMs}ms)`);
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "JobSeeker Bridge rejected the pairing token — re-pair from Settings ▸ Browser ▸ Connect."
    );
  }
  const body = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(
      `JobSeeker Bridge ${method} failed: HTTP ${res.status}${body?.error ? ` — ${body.error}` : ""}`
    );
  if (!body || body.ok === false)
    throw new Error(`${method} failed: ${body?.error || "bridge returned no result"}`);
  return body.result;
}

// ---------- Chrome process ----------

async function chromeRunningWin() {
  const r = await run("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/NH"], { timeout: 10_000 });
  return r.ok && /chrome\.exe/i.test(r.out);
}

// The macOS pattern, for the case where this driver is forced on a Mac (tests, or a user who
// prefers the extension). Kept here rather than imported so the two drivers stay independent.
function chromeRunningPosix() {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/pgrep",
      ["-f", "^/Applications/Google Chrome.app/Contents/MacOS/Google Chrome( |$)"],
      { timeout: 10_000 },
      (err, stdout) => resolve(!err && String(stdout).trim().length > 0)
    );
  });
}

export function chromeRunning() {
  return IS_WIN && process.platform === "win32" ? chromeRunningWin() : chromeRunningPosix();
}

/** Where chrome.exe lives: the App Paths registry key first, then the three standard install dirs. */
export async function findChromeExe() {
  const reg = await run(
    "reg",
    ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe", "/ve"],
    { timeout: 10_000 }
  );
  if (reg.ok) {
    // "    (Default)    REG_SZ    C:\Program Files\Google\Chrome\Application\chrome.exe"
    const m = /REG_SZ\s+(.+\S)\s*$/m.exec(reg.out);
    if (m && existsSync(m[1].trim())) return m[1].trim();
  }
  const dirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LocalAppData];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, "Google", "Chrome", "Application", "chrome.exe");
    if (existsSync(p)) return p;
  }
  return null;
}

async function waitForConnected(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const s = await getStatus(await bridgeBase());
      if (s.connected === true) return { ok: true };
      last = s.reachable
        ? "bridge is up but the extension has not connected"
        : `bridge unreachable (${s.reason})`;
    } catch (e) {
      last = String(e?.message || e);
    }
    await sleep(2000);
  }
  return { ok: false, last };
}

/**
 * Make sure Chrome is running, launching it if it is not. Never restarts or quits a running one.
 *
 * As on macOS the launch carries NO flags: `--user-data-dir` or `--profile-directory` would risk a
 * different profile, and a different profile means WhatsApp shows a QR code. Chrome picks its own
 * last-used profile, so the linked device — and the extension loaded in that profile — survive.
 *
 * "Ready" means the extension has connected to the bridge, not merely that chrome.exe exists: an
 * extension takes a few seconds after start-up to open its socket, and a Chrome without the
 * extension can never be read from.
 *
 * Set JOBSEEKER_CHROME_AUTOLAUNCH=0 to disable and have a closed Chrome be reported as a blocker.
 */
export async function ensureChrome({ timeoutMs = 180_000 } = {}) {
  if (await chromeRunning()) {
    // Already up. Give a freshly started bridge a moment to be found by the extension, but do not
    // fail here — listTabs() reports "not connected" precisely if it still is not.
    await waitForConnected(Math.min(timeoutMs, 15_000));
    return { running: true, launched: false };
  }
  if (process.env.JOBSEEKER_CHROME_AUTOLAUNCH === "0") {
    return { running: false, launched: false, reason: "Chrome is closed and autolaunch is disabled" };
  }
  if (process.platform !== "win32") {
    return {
      running: false,
      launched: false,
      reason: "Chrome is closed (the extension driver only launches Chrome on Windows)",
    };
  }

  const exe = await findChromeExe();
  if (!exe)
    return { running: false, launched: false, reason: "could not launch Chrome: chrome.exe not found" };
  try {
    const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
  } catch (e) {
    return { running: false, launched: false, reason: `could not launch Chrome: ${e?.message || e}` };
  }

  const w = await waitForConnected(timeoutMs);
  if (w.ok) return { running: true, launched: true };
  // Carry the REASON out, exactly as the macOS driver does.
  return {
    running: false,
    launched: true,
    reason:
      `Chrome was launched but the JobSeeker Bridge extension never connected within ${Math.round(timeoutMs / 1000)}s` +
      (w.last ? ` — last state: ${w.last}` : "") +
      ". Load the JobSeeker Bridge extension and connect it from Settings ▸ Browser.",
  };
}

// ---------- Tabs ----------

const unreadFromTitle = (title) => {
  const m = /^\((\d+)\)/.exec(String(title || "").trim());
  return m ? Number(m[1]) : null;
};

/** Every open tab, in the same shape the AppleScript driver returns, plus Chrome's tab `id`. */
export async function listTabs() {
  const rows = await call("listTabs", {});
  // The extension numbers windows and tabs 1-based itself; derive the same numbering here if a
  // build ever omits it, so nothing downstream sees NaN.
  const windowIndex = new Map();
  const tabCount = new Map();
  return (Array.isArray(rows) ? rows : []).map((t) => {
    if (!windowIndex.has(t.windowId)) windowIndex.set(t.windowId, windowIndex.size + 1);
    tabCount.set(t.windowId, (tabCount.get(t.windowId) || 0) + 1);
    return {
      id: t.id,
      windowId: t.windowId,
      window: Number(t.window) || windowIndex.get(t.windowId),
      tab: Number(t.tab) || tabCount.get(t.windowId),
      active: Boolean(t.active),
      url: String(t.url || ""),
      title: String(t.title || ""),
      // Unread badges ride in the title ("(11) WhatsApp") — reportable even when reads fail.
      unread: unreadFromTitle(t.title),
    };
  });
}

// A tab addressed only by window/tab index (a probe that was written against the AppleScript
// shape) is resolved to its Chrome id here, so composites never need to know the difference.
async function tabIdOf(tab) {
  if (tab && tab.id != null) return tab.id;
  const hit = (await listTabs()).find((t) => t.window === Number(tab?.window) && t.tab === Number(tab?.tab));
  if (!hit) throw new Error(`tab ${tab?.tab} of window ${tab?.window} no longer exists`);
  return hit.id;
}

/**
 * Run an extraction snippet in a tab and return its value as a string.
 * The snippet MUST be read-only. Return a JSON string for anything structured.
 */
export async function evalInTab(tab, js, { timeoutMs = 30_000 } = {}) {
  const tabId = await tabIdOf(tab);
  let r;
  try {
    r = await call("evalInTab", { tabId, js, timeoutMs }, { timeoutMs });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/timed out|timeout/i.test(msg)) {
      // The same diagnosis as on macOS: a discarded background tab has no renderer to answer.
      throw new Error(
        `tab ${tab.tab} of window ${tab.window} did not respond (extension call timed out). ` +
          "Chrome most likely discarded this background tab to save memory; only foreground tabs are " +
          "guaranteed to be live."
      );
    }
    throw new Error(`evalInTab failed: ${msg}`);
  }
  const v = r && r.value;
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export async function openTab(url) {
  const r = await call("openTab", { url });
  if (!r || r.tabId == null) throw new Error("could not open tab: bridge returned no tab");
  return { id: r.tabId, window: Number(r.window) || 1, tab: Number(r.tab) || 0 };
}

export async function closeTabsByUrl(url) {
  await call("closeTabsByUrlPrefix", { prefix: url }).catch(() => {});
}

export async function tabLoading(tab) {
  try {
    const r = await call("tabLoading", { tabId: await tabIdOf(tab) }, { timeoutMs: 10_000 });
    return typeof r?.loading === "boolean" ? r.loading : null;
  } catch {
    return null;
  }
}

// ---------- Probe ----------

/**
 * The facts scripts/browser-probe.mjs records for this driver. Apple Events fields are reported as
 * "not-applicable" so the status file keeps one schema on both platforms.
 */
export async function probe({ launched = false } = {}) {
  const running = await chromeRunning();
  let bridge = { reachable: false, paired: existsSync(BRIDGE_TOKEN), connected: false, extensionId: null };
  let statusErr = "";
  try {
    const s = await getStatus(await bridgeBase());
    bridge = {
      reachable: Boolean(s.reachable),
      paired: bridge.paired,
      connected: s.connected === true,
      extensionId: s.extensionId || s.extension_id || null,
    };
    if (!s.reachable) statusErr = String(s.reason || "");
  } catch (e) {
    statusErr = String(e?.message || e);
  }

  let tabs = [];
  let tabsError = "";
  let version = null;
  if (bridge.connected) {
    // A Chrome we started ourselves may still be settling; give it a few chances.
    for (let i = 0; i < (launched ? 4 : 1); i++) {
      try {
        tabs = await listTabs();
        tabsError = "";
        break;
      } catch (e) {
        tabsError = String(e?.message || e);
        if (launched) await sleep(3000);
      }
    }
    try {
      const p = await call("ping", {}, { timeoutMs: 5000 });
      version = p?.version || null;
    } catch {
      /* optional */
    }
  }

  return {
    driver: "extension",
    chrome_pid: null,
    chrome_running: running,
    tabs,
    bridge: { ...bridge, version, error: statusErr || tabsError || null },
    apple_events: "not-applicable",
    apple_events_error: null,
    js_from_apple_events: "not-applicable",
    js_probe_detail: bridge.connected
      ? `extension connected${tabs.length ? ` with ${tabs.length} tab(s)` : ""}`
      : bridge.paired
        ? "extension paired but not connected"
        : "extension not paired",
    read_mechanism: bridge.connected ? "extension" : "none",
  };
}

export const driver = {
  name: "extension",
  ensureChrome,
  chromeRunning,
  listTabs,
  evalInTab,
  openTab,
  closeTabsByUrl,
  tabLoading,
  probe,
};
