// The localhost bridge between Node and the "JobSeeker Bridge" Chrome extension.
//
// Why this exists. On macOS the browser-driving scripts talk to Chrome through Apple Events
// (osascript), which do not exist on Windows. The obvious substitute, Chrome's remote-debugging
// port, is gone too: Chrome 136+ refuses --remote-debugging-port on the default profile, and a
// separate profile would not carry the user's WhatsApp Web / LinkedIn logins, which is the whole
// point of driving THEIR browser. What is left is an MV3 extension. The extension cannot be
// connected to from outside (there is no inbound socket into a service worker), so the direction is
// inverted: the extension long-polls THIS server for work, executes it in the user's tabs, and posts
// the result back. Node calls look synchronous (`await bridge.call("evalInTab", ...)`); underneath,
// the request sits in a queue until the extension's next poll picks it up.
//
// Trust boundary. Identical to today's osascript path: any local process that can read
// data/.bridge.token can drive reads in the user's browser. The token is minted once (32 random
// bytes, mode 0600 where modes mean anything), handed to the extension exactly once through a short-
// lived pairing code the user copies from the dashboard, and never travels further than loopback.
// The extension's identity (its chrome-extension:// Origin) is pinned at pairing time, so a stray
// web page that somehow learned the token still cannot poll for work. Nothing here authenticates
// the *user* -- "127.0.0.1 only" is the authentication, exactly as it is for the dashboard -- and the
// server rejects any connection whose remote address is not loopback, regardless of how it was bound.
//
// Method allowlist (everything else is a 400, before any queueing):
//   ping                 -> liveness
//   listTabs             -> [{id, url, title, active, windowId}]
//   evalInTab            -> run a read-only script in a tab, return its value
//   openTab              -> open a URL, return the tab id
//   closeTabsByUrlPrefix -> close tabs we opened
//   tabLoading           -> is a tab still loading?
// The extension enforces the same list on its side; this one is here so a bad caller is told no
// without the extension ever seeing the request.
//
// Files (all under dataDir, all dotfiles, none of them Markdown -- this module never touches data/*.md):
//   .bridge.token      the shared secret, created on first need
//   .bridge.pair.json  {code, expires}  a single-use pairing code, 5 minute TTL
//   .bridge.ext.json   {extensionId, pairedAt}  the pinned extension Origin
//   .bridge.json       {port, pid, started}  written by --serve mode only, removed on exit
//
// Two ways to run it: mounted inside the dashboard (`createBridge({dataDir}).handle(req, res)`,
// mounted BEFORE the same-origin check, because the extension's Origin is chrome-extension://...),
// or standalone: `node server/bridge.mjs --serve [--port N]`.

import crypto from "crypto";
import { promises as fs } from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { ROOT, chmodSafe } from "./platform.mjs";

export const BRIDGE_VERSION = "1";
export const METHODS = new Set(["ping", "listTabs", "evalInTab", "openTab", "closeTabsByUrlPrefix", "tabLoading"]);

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const BODY_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 180_000;
const PAIR_TTL_MS = 5 * 60_000;
const PAIR_ATTEMPTS = 5; // wrong codes tolerated per minute before 429
const IDLE_EXIT_MS = 15 * 60_000;

const TOKEN_FILE = ".bridge.token";
const PAIR_FILE = ".bridge.pair.json";
const EXT_FILE = ".bridge.ext.json";
const SERVE_FILE = ".bridge.json";

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function noContent(res) {
  if (res.writableEnded) return;
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

/** Read a body of at most BODY_LIMIT bytes; 413 above that, 400 if it is not a JSON object. */
function readJson(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        // Answer first, then drop the connection rather than swallow the rest of the upload.
        req.pause();
        res.setHeader("connection", "close");
        res.on("finish", () => req.socket.destroy());
        reject(new HttpError(413, "body exceeds 1 MB"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        resolve(v);
      } catch (e) {
        reject(new HttpError(400, `invalid JSON body: ${e.message}`));
      }
    });
    req.on("error", (e) => reject(new HttpError(400, e.message)));
  });
}

async function writeAtomic(file, text, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, text);
  if (mode) await chmodSafe(tmp, mode);
  await fs.rename(tmp, file);
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function bearer(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  return m ? m[1] : "";
}

/** Constant-time string equality, so a wrong token does not leak how wrong it was. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function isLoopback(req) {
  return LOOPBACK.has(req.socket?.remoteAddress);
}

// ---------- pairing code ----------

/**
 * Mint a fresh single-use pairing code (6 digits, 5 minute TTL) into dataDir/.bridge.pair.json.
 * The dashboard shows it; the user types it into the extension; the extension trades it for the
 * token at POST /bridge/pair. Exported so the dashboard can mint one even when the bridge runs as
 * a separate --serve process (both read the same file).
 */
export async function mintPairingCode(dataDir, ttlMs = PAIR_TTL_MS) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const pairing = { code, expires: new Date(Date.now() + ttlMs).toISOString() };
  await writeAtomic(path.join(dataDir, PAIR_FILE), JSON.stringify(pairing), 0o600);
  return pairing;
}

// ---------- the bridge ----------

/**
 * createBridge({ dataDir }) -> { handle, call, status, mintPairingCode }
 *
 * Options beyond dataDir exist for tests: connectedWindowMs (how recent a poll counts as "connected",
 * default 30 s), pollHoldMs (how long a poll is held before a 204, default 20 s), pairTtlMs.
 */
export function createBridge({
  dataDir,
  connectedWindowMs = 30_000,
  pollHoldMs = 20_000,
  pairTtlMs = PAIR_TTL_MS,
} = {}) {
  if (!dataDir) throw new Error("createBridge: dataDir is required");

  let token = null; // loaded or minted on first need
  let ext = undefined; // undefined = not loaded yet; null = not paired; {extensionId, pairedAt}
  let lastSeen = 0; // ms epoch of the extension's most recent authenticated poll
  let lastPairing = null; // the most recent code minted in THIS process, for status()
  const wrongCodes = []; // timestamps of failed pair attempts, for the rate limit
  const queue = []; // jobs not yet handed to the extension
  const pending = new Map(); // id -> {job, resolve, reject, timer}, until the extension answers
  let poller = null; // {res, timer} while a poll is being held

  async function getToken() {
    if (token) return token;
    const file = path.join(dataDir, TOKEN_FILE);
    try {
      const t = (await fs.readFile(file, "utf8")).trim();
      if (/^[0-9a-f]{64}$/.test(t)) return (token = t);
    } catch {
      /* first need: mint below */
    }
    token = crypto.randomBytes(32).toString("hex");
    await writeAtomic(file, token + "\n", 0o600);
    return token;
  }

  async function getExt() {
    if (ext !== undefined) return ext;
    const v = await readJsonFile(path.join(dataDir, EXT_FILE));
    ext = v && typeof v.extensionId === "string" && v.extensionId ? v : null;
    return ext;
  }

  const connected = () => lastSeen > 0 && Date.now() - lastSeen < connectedWindowMs;

  /**
   * The bearer token is the authentication. The pinned origin is a second opinion, and it is only
   * consulted when the browser actually offers one.
   *
   * That distinction is load-bearing. An extension with host permissions for this port does not
   * make a CORS request, so Chrome sends an `Origin` header on the pairing POST and sends none on
   * the polling GET. Demanding it on every request meant the extension paired, was refused 403 on
   * its very first poll, concluded the pairing had been revoked, threw its token away, and sat
   * there checking status forever. Measured on Chrome 152: paired, then never polled again.
   *
   * So a request that carries an origin must carry the right one, and a request that carries none
   * is judged on its token alone. The token is a 32-byte secret readable only by processes that can
   * already read this user's data directory, which is the same trust boundary the rest of JobSeeker
   * has.
   */
  async function authenticate(req, { requireOrigin }) {
    if (!safeEqual(bearer(req), await getToken())) throw new HttpError(403, "bad or missing token");
    if (requireOrigin) {
      const e = await getExt();
      if (!e) throw new HttpError(403, "no extension has paired with this bridge yet");
      const origin = req.headers.origin;
      if (origin && origin !== e.extensionId) throw new HttpError(403, "origin is not the paired extension");
    }
  }

  // Hand one job to a waiting poller, if there is one and there is work.
  function dispatch() {
    if (!poller || queue.length === 0) return;
    const { res, timer } = poller;
    clearTimeout(timer);
    poller = null;
    const job = queue.shift();
    json(res, 200, { id: job.id, method: job.method, params: job.params, timeoutMs: job.timeoutMs });
  }

  function releasePoller() {
    if (!poller) return;
    clearTimeout(poller.timer);
    const { res } = poller;
    poller = null;
    noContent(res);
  }

  function settle(id, ok, result, error) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(result);
    else p.reject(new Error(typeof error === "string" && error ? error : "extension reported an error"));
    return true;
  }

  /**
   * Ask the extension to run `method`. Resolves with its result; rejects with an Error carrying
   * `.status` 400 (method not allowed), 503 (extension not connected) or 504 (no answer in time),
   * or with no `.status` when the extension itself answered {ok:false}.
   */
  function call(method, params = {}, { timeoutMs } = {}) {
    if (!METHODS.has(method)) {
      return Promise.reject(new HttpError(400, `method not allowed: ${String(method).slice(0, 40)}`));
    }
    if (!connected()) return Promise.reject(new HttpError(503, "extension not connected"));
    const t = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const job = { id: crypto.randomUUID(), method, params: params ?? {}, timeoutMs: t };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        pending.delete(job.id);
        reject(new HttpError(504, `extension did not answer within ${Math.round(t / 1000)}s`));
      }, t);
      pending.set(job.id, { job, resolve, reject, timer });
      queue.push(job);
      dispatch();
    });
  }

  function status() {
    const validPairing = lastPairing && Date.parse(lastPairing.expires) > Date.now() ? lastPairing : null;
    return {
      paired: !!ext,
      connected: connected(),
      lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
      extensionId: ext ? ext.extensionId : null,
      pending: queue.length, // waiting for the extension's next poll
      inFlight: pending.size - queue.length,
      pairing: validPairing,
      version: BRIDGE_VERSION,
    };
  }

  // ---------- routes ----------

  async function routeStatus(req, res) {
    await getExt();
    const s = status();
    json(res, 200, {
      paired: s.paired,
      connected: s.connected,
      lastSeen: s.lastSeen,
      extensionId: s.extensionId,
      pending: s.pending,
      version: s.version,
    });
  }

  async function routePair(req, res) {
    const now = Date.now();
    while (wrongCodes.length && now - wrongCodes[0] > 60_000) wrongCodes.shift();
    if (wrongCodes.length >= PAIR_ATTEMPTS) throw new HttpError(429, "too many pairing attempts; wait a minute");

    const body = await readJson(req, res);
    const origin = String(req.headers.origin || "");
    if (!origin) throw new HttpError(400, "Origin header required");

    const file = path.join(dataDir, PAIR_FILE);
    const pairing = await readJsonFile(file);
    const fresh = pairing && typeof pairing.code === "string" && Date.parse(pairing.expires) > now;
    if (!fresh || !safeEqual(String(body.code ?? ""), pairing.code)) {
      wrongCodes.push(now);
      throw new HttpError(403, fresh ? "wrong pairing code" : "no valid pairing code; mint a new one");
    }

    // Single use: the code is gone before the token leaves.
    await fs.rm(file, { force: true });
    lastPairing = null;
    ext = { extensionId: origin, pairedAt: new Date(now).toISOString() };
    await writeAtomic(path.join(dataDir, EXT_FILE), JSON.stringify(ext), 0o600);
    lastSeen = 0; // a new pairing starts unconnected until it polls
    json(res, 200, { token: await getToken() });
  }

  async function routePoll(req, res) {
    await authenticate(req, { requireOrigin: true });
    lastSeen = Date.now();
    if (queue.length) {
      const job = queue.shift();
      return json(res, 200, { id: job.id, method: job.method, params: job.params, timeoutMs: job.timeoutMs });
    }
    // One poller at a time: a newcomer takes over, the earlier one is let go with "nothing yet".
    releasePoller();
    const timer = setTimeout(() => {
      if (poller && poller.res === res) releasePoller();
    }, pollHoldMs);
    poller = { res, timer };
    req.on("close", () => {
      if (poller && poller.res === res) {
        clearTimeout(poller.timer);
        poller = null;
      }
    });
  }

  async function routeResult(req, res) {
    await authenticate(req, { requireOrigin: true });
    lastSeen = Date.now();
    const body = await readJson(req, res);
    if (typeof body.id !== "string" || !pending.has(body.id)) throw new HttpError(404, "unknown request id");
    settle(body.id, body.ok === true, body.result, body.error);
    noContent(res);
  }

  async function routeCall(req, res) {
    await authenticate(req, { requireOrigin: false });
    const body = await readJson(req, res);
    if (typeof body.method !== "string" || !METHODS.has(body.method)) {
      throw new HttpError(400, `method not allowed: ${String(body.method ?? "").slice(0, 40)}`);
    }
    try {
      const result = await call(body.method, body.params ?? {}, { timeoutMs: body.timeoutMs });
      json(res, 200, { ok: true, result });
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { ok: false, error: e.message });
      json(res, 200, { ok: false, error: e.message });
    }
  }

  /**
   * Serve one request if it is ours. Returns true when the path is under /bridge/ (the response is
   * then handled here, possibly asynchronously), false when the caller should route it itself.
   */
  function handle(req, res) {
    const pathname = (req.url || "/").split("?")[0];
    if (!pathname.startsWith("/bridge/")) return false;
    res.setHeader("cache-control", "no-store");

    (async () => {
      if (!isLoopback(req)) throw new HttpError(403, "loopback only");
      const m = req.method;
      if (m === "GET" && pathname === "/bridge/status") return routeStatus(req, res);
      if (m === "POST" && pathname === "/bridge/pair") return routePair(req, res);
      if (m === "GET" && pathname === "/bridge/poll") return routePoll(req, res);
      if (m === "POST" && pathname === "/bridge/result") return routeResult(req, res);
      if (m === "POST" && pathname === "/bridge/call") return routeCall(req, res);
      throw new HttpError(404, "no such bridge route");
    })().catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      json(res, status, { error: e instanceof HttpError ? e.message : "internal error" });
    });
    return true;
  }

  return {
    handle,
    call,
    status,
    mintPairingCode: async () => (lastPairing = await mintPairingCode(dataDir, pairTtlMs)),
    /** Drop every queued and in-flight call (used at shutdown). */
    close() {
      releasePoller();
      for (const id of [...pending.keys()]) settle(id, false, undefined, "bridge closed");
      queue.length = 0;
    },
  };
}

// ---------- --serve mode ----------

// The same flat "key: value" file the dashboard reads, with the same deliberately tiny reader: a
// regex over the frontmatter, no YAML. Importing dashboard.mjs here would start the dashboard.
async function configPort() {
  try {
    const text = await fs.readFile(path.join(ROOT, "config", "job-seeker.config.md"), "utf8");
    const m = /^bridge_port:\s*(\d{2,5})\s*$/m.exec(text);
    if (m) return Number(m[1]);
  } catch {
    /* no config: default */
  }
  return 4320;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function probeOtherBridge(port) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/bridge/status`, { signal: ac.signal });
    clearTimeout(t);
    const v = await r.json();
    return v && v.version === BRIDGE_VERSION;
  } catch {
    return false;
  }
}

async function serve() {
  const dataDir = process.env.JOBSEEKER_DATA_DIR ? path.resolve(process.env.JOBSEEKER_DATA_DIR) : path.join(ROOT, "data");
  const port = Number(argValue("--port")) || (await configPort());
  const bridge = createBridge({ dataDir });
  const serveFile = path.join(dataDir, SERVE_FILE);

  let idle = null;
  let closing = false;
  const shutdown = async (why) => {
    if (closing) return;
    closing = true;
    clearTimeout(idle);
    console.error(`bridge: exiting (${why})`);
    bridge.close();
    server.close();
    await fs.rm(serveFile, { force: true }).catch(() => {});
    process.exit(0);
  };
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => shutdown("idle for 15 min"), IDLE_EXIT_MS);
  };

  const server = http.createServer((req, res) => {
    armIdle();
    const started = Date.now();
    res.on("finish", () => {
      console.error(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    });
    if (!bridge.handle(req, res)) {
      res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Not found");
    }
  });

  server.on("error", async (e) => {
    if (e.code === "EADDRINUSE") {
      if (await probeOtherBridge(port)) process.exit(0); // a bridge is already up; nothing to do
      console.error(`bridge: port ${port} is in use by something that is not a JobSeeker bridge`);
      process.exit(1);
    }
    console.error(`bridge: ${e.message}`);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await writeAtomic(
      serveFile,
      JSON.stringify({ port, pid: process.pid, started: new Date().toISOString() }),
      0o600
    );
    console.error(`bridge: listening on http://127.0.0.1:${port}/bridge/ (data: ${dataDir})`);
    armIdle();
  });

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly && process.argv.includes("--serve")) {
  serve().catch((e) => {
    console.error(`bridge: ${e.message}`);
    process.exit(1);
  });
} else if (invokedDirectly) {
  console.error("usage: node server/bridge.mjs --serve [--port N]");
  process.exit(2);
}
