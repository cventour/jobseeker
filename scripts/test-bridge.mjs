#!/usr/bin/env node
// Protocol test for the extension bridge (server/bridge.mjs).
//
// Plays both sides: mounts createBridge() on an ephemeral loopback port with a throwaway dataDir,
// then pretends to be the Chrome extension with fetch -- pairing, polling, posting results -- and a
// Node caller on the other side. Every rejection path the protocol promises (wrong code, reused code,
// missing token, wrong Origin, non-loopback, oversize body, unknown method, extension not connected)
// is exercised, because each one is a line of the trust boundary and a regression there is silent.
//
//   npm run test:bridge

import { promises as fs } from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createBridge } from "../server/bridge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-bridge-"));
  // Short windows so the slow paths are testable quickly. As in production, a held poll must be
  // shorter than the connected window, or "connected" would flicker off between two idle polls.
  const CONNECTED_MS = 800;
  const HOLD_MS = 300;
  const bridge = createBridge({ dataDir: tmp, connectedWindowMs: CONNECTED_MS, pollHoldMs: HOLD_MS });

  // A request carrying X-Test-Remote pretends to arrive from that address: the loopback check reads
  // req.socket.remoteAddress, so that is what gets faked.
  const server = http.createServer((req, res) => {
    // Sockets are kept alive and reused by fetch, so the fake must be undone once this response is out.
    const fake = req.headers["x-test-remote"];
    if (fake) {
      Object.defineProperty(req.socket, "remoteAddress", { value: fake, configurable: true });
      res.on("finish", () => delete req.socket.remoteAddress);
    }
    if (!bridge.handle(req, res)) {
      res.writeHead(404);
      res.end("not bridge");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (p, init = {}) => fetch(base + p, init);
  const post = (p, body, headers = {}) =>
    api(p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  console.log(`\nbridge: protocol against ${base}\n`);

  // Not ours -> false, so the host keeps routing.
  const other = await api("/anything");
  check("non-/bridge/ paths are left to the host", other.status === 404 && (await other.text()) === "not bridge");

  // Status before anything happened.
  let r = await api("/bridge/status");
  let s = await r.json();
  check(
    "status: unpaired, not connected, version 1",
    r.status === 200 && s.paired === false && s.connected === false && s.lastSeen === null && s.version === "1",
    JSON.stringify(s)
  );
  check("status: Cache-Control no-store", r.headers.get("cache-control") === "no-store");

  // Loopback only.
  r = await api("/bridge/status", { headers: { "x-test-remote": "192.168.1.20" } });
  check("non-loopback remote address -> 403", r.status === 403, `got ${r.status}`);
  r = await api("/bridge/status", { headers: { "x-test-remote": "::ffff:127.0.0.1" } });
  check("IPv4-mapped loopback is accepted", r.status === 200, `got ${r.status}`);

  // Pairing.
  r = await post("/bridge/pair", { code: "000000" }, { origin: EXT });
  check("pair with no code minted -> 403", r.status === 403, `got ${r.status}`);

  const pairing = await bridge.mintPairingCode();
  check("mintPairingCode writes .bridge.pair.json", JSON.parse(await fs.readFile(path.join(tmp, ".bridge.pair.json"), "utf8")).code === pairing.code);
  check("status() exposes the live pairing code", bridge.status().pairing?.code === pairing.code);

  const wrong = pairing.code === "123456" ? "654321" : "123456";
  r = await post("/bridge/pair", { code: wrong }, { origin: EXT });
  check("pair with wrong code -> 403", r.status === 403, `got ${r.status}`);

  r = await post("/bridge/pair", { code: pairing.code }, { origin: EXT });
  const paired = await r.json();
  const token = paired.token;
  check("pair with right code -> 200 {token}", r.status === 200 && /^[0-9a-f]{64}$/.test(token || ""), JSON.stringify(paired));
  check(
    "token matches .bridge.token on disk",
    (await fs.readFile(path.join(tmp, ".bridge.token"), "utf8")).trim() === token
  );
  const ext = JSON.parse(await fs.readFile(path.join(tmp, ".bridge.ext.json"), "utf8"));
  check("Origin pinned in .bridge.ext.json", ext.extensionId === EXT && !!ext.pairedAt, JSON.stringify(ext));
  if (process.platform !== "win32") {
    const mode = (await fs.stat(path.join(tmp, ".bridge.token"))).mode & 0o777;
    check("token file is 0600", mode === 0o600, mode.toString(8));
  }

  r = await post("/bridge/pair", { code: pairing.code }, { origin: EXT });
  check("pair code is single-use -> 403 on reuse", r.status === 403, `got ${r.status}`);
  let pairFileGone = false;
  try {
    await fs.access(path.join(tmp, ".bridge.pair.json"));
  } catch {
    pairFileGone = true;
  }
  check("pair file deleted after use", pairFileGone);

  // Rate limit: we have made 3 wrong attempts so far; two more reach the limit, the sixth is 429.
  for (let i = 0; i < 2; i++) await post("/bridge/pair", { code: "000001" }, { origin: EXT });
  r = await post("/bridge/pair", { code: "000001" }, { origin: EXT });
  check("6th wrong pairing attempt in a minute -> 429", r.status === 429, `got ${r.status} ${JSON.stringify(await r.json())}`);

  // Poll auth.
  const auth = { authorization: `Bearer ${token}`, origin: EXT };
  r = await api("/bridge/poll");
  check("poll without token -> 403", r.status === 403, `got ${r.status}`);
  r = await api("/bridge/poll", { headers: { authorization: `Bearer ${"0".repeat(64)}`, origin: EXT } });
  check("poll with wrong token -> 403", r.status === 403, `got ${r.status}`);
  r = await api("/bridge/poll", { headers: { authorization: `Bearer ${token}`, origin: "chrome-extension://someoneelse" } });
  check("poll with right token but wrong Origin -> 403", r.status === 403, `got ${r.status}`);
  s = await (await api("/bridge/status")).json();
  check("rejected polls do not count as seen", s.connected === false && s.lastSeen === null);

  // Chrome sends an Origin on the pairing POST and none on the polling GET, because an extension
  // holding host permissions for this port is not making a CORS request. Rejecting the header's
  // absence is what made a real, correctly paired extension throw its token away and stop.
  r = await api("/bridge/poll", { headers: { authorization: `Bearer ${token}` } });
  check("poll with the right token and NO Origin is accepted", r.status === 204 || r.status === 200, `got ${r.status}`);

  // An idle poll is held, then released with 204.
  let t0 = Date.now();
  r = await api("/bridge/poll", { headers: auth });
  check("idle poll is held then 204", r.status === 204 && Date.now() - t0 >= HOLD_MS - 20, `${r.status} after ${Date.now() - t0}ms`);
  s = await (await api("/bridge/status")).json();
  check("status shows connected after a poll", s.paired && s.connected && typeof s.lastSeen === "string", JSON.stringify(s));

  // A second poller displaces the first (first gets 204 immediately).
  const first = api("/bridge/poll", { headers: auth });
  await sleep(50);
  t0 = Date.now();
  const second = api("/bridge/poll", { headers: auth });
  const firstRes = await first;
  // Bound: the first must be let go by the newcomer, not by its own hold timer running out.
  check("a second poll releases the first with 204", firstRes.status === 204 && Date.now() - t0 < HOLD_MS - 20, `${firstRes.status} after ${Date.now() - t0}ms`);

  // call() while the (second) poller is waiting -> it receives the job -> result -> call resolves.
  const callP = bridge.call("listTabs", { windowId: 7 }, { timeoutMs: 5000 });
  const job = await (await second).json();
  check(
    "waiting poller receives the enqueued call",
    job.method === "listTabs" && job.params.windowId === 7 && typeof job.id === "string" && job.timeoutMs === 5000,
    JSON.stringify(job)
  );
  s = await (await api("/bridge/status")).json();
  check("status: pending is 0 once the job is handed over", s.pending === 0, JSON.stringify(s));
  r = await post("/bridge/result", { id: job.id, ok: true, result: [{ id: 1, url: "https://web.whatsapp.com/" }] }, auth);
  check("result -> 204", r.status === 204, `got ${r.status}`);
  const result = await callP;
  check("call() resolves with the extension's result", Array.isArray(result) && result[0].url === "https://web.whatsapp.com/");

  r = await post("/bridge/result", { id: job.id, ok: true, result: 1 }, auth);
  check("result for an unknown/settled id -> 404", r.status === 404, `got ${r.status}`);
  r = await post("/bridge/result", { id: "x" }, { authorization: `Bearer ${token}`, origin: "chrome-extension://nope" });
  check("result with wrong Origin -> 403", r.status === 403, `got ${r.status}`);

  // Job enqueued BEFORE the poll arrives: the next poll gets it immediately.
  const callQueued = bridge.call("ping", {}).then(() => null, (e) => e.message);
  s = await (await api("/bridge/status")).json();
  check("status: pending counts the queued job", s.pending === 1, JSON.stringify(s));
  t0 = Date.now();
  r = await api("/bridge/poll", { headers: auth });
  const job2 = await r.json();
  check("poll returns a queued job immediately", r.status === 200 && job2.method === "ping" && Date.now() - t0 < 200, `${r.status} after ${Date.now() - t0}ms`);
  await post("/bridge/result", { id: job2.id, ok: false, error: "no such tab" }, auth);
  const errMsg = await callQueued;
  check("extension {ok:false} rejects call() with its error", errMsg === "no such tab", String(errMsg));

  // HTTP /bridge/call: same token, no Origin needed; result shapes.
  const httpCall = post("/bridge/call", { method: "tabLoading", params: { tabId: 3 } }, { authorization: `Bearer ${token}` });
  r = await api("/bridge/poll", { headers: auth });
  const job3 = await r.json();
  await post("/bridge/result", { id: job3.id, ok: true, result: false }, auth);
  r = await httpCall;
  let body = await r.json();
  check("POST /bridge/call -> 200 {ok:true, result}", r.status === 200 && body.ok === true && body.result === false, JSON.stringify(body));

  const httpCall2 = post("/bridge/call", { method: "openTab", params: { url: "https://x" } }, { authorization: `Bearer ${token}` });
  r = await api("/bridge/poll", { headers: auth });
  const job4 = await r.json();
  await post("/bridge/result", { id: job4.id, ok: false, error: "blocked" }, auth);
  r = await httpCall2;
  body = await r.json();
  check("POST /bridge/call -> 200 {ok:false, error} when the extension fails", r.status === 200 && body.ok === false && body.error === "blocked", JSON.stringify(body));

  r = await post("/bridge/call", { method: "ping" });
  check("POST /bridge/call without token -> 403", r.status === 403, `got ${r.status}`);
  r = await post("/bridge/call", { method: "chrome.cookies.getAll" }, { authorization: `Bearer ${token}` });
  check("unknown method over HTTP -> 400", r.status === 400, `got ${r.status}`);
  const badMethod = await bridge.call("evalEverywhere", {}).then(() => null, (e) => e);
  check("unknown method via call() -> rejects with status 400", badMethod?.status === 400, String(badMethod?.message));
  check("timeoutMs is capped at 180 s", (() => { const p = bridge.call("ping", {}, { timeoutMs: 999_999 }); p.catch(() => {}); return bridge.status().pending >= 1; })());
  // drain the capped job so it does not linger in the queue
  r = await api("/bridge/poll", { headers: auth });
  const capped = await r.json();
  check("capped job carries timeoutMs 180000", capped.timeoutMs === 180_000, String(capped.timeoutMs));
  await post("/bridge/result", { id: capped.id, ok: true }, auth);

  // Timeout: a job nobody answers -> 504 via HTTP, .status 504 via call().
  t0 = Date.now();
  const slow = post("/bridge/call", { method: "ping", timeoutMs: 1000 }, { authorization: `Bearer ${token}` });
  r = await api("/bridge/poll", { headers: auth }); // take the job, never answer it
  await r.json();
  r = await slow;
  body = await r.json();
  check("unanswered call -> 504 {ok:false}", r.status === 504 && body.ok === false && /did not answer within 1s/.test(body.error), `${r.status} ${JSON.stringify(body)} after ${Date.now() - t0}ms`);

  // Bad bodies.
  r = await api("/bridge/call", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{not json" });
  check("malformed JSON -> 400", r.status === 400, `got ${r.status}`);
  const big = JSON.stringify({ method: "ping", params: { pad: "x".repeat(1024 * 1024 + 100) } });
  let bigStatus = null;
  try {
    r = await api("/bridge/call", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: big });
    bigStatus = r.status;
  } catch (e) {
    bigStatus = `error: ${e.cause?.code || e.message}`;
  }
  check("body > 1 MB -> 413 (or 400)", bigStatus === 413 || bigStatus === 400, String(bigStatus));

  // Not connected: wait past the window with no poll, then call() -> 503 (both surfaces).
  await sleep(CONNECTED_MS + 100);
  s = await (await api("/bridge/status")).json();
  check("status: connected drops to false after the window", s.connected === false && typeof s.lastSeen === "string", JSON.stringify(s));
  const notConn = await bridge.call("ping", {}).then(() => null, (e) => e);
  check("call() with no poller -> rejects 503 'extension not connected'", notConn?.status === 503 && notConn.message === "extension not connected", String(notConn?.message));
  r = await post("/bridge/call", { method: "ping" }, { authorization: `Bearer ${token}` });
  body = await r.json();
  check("POST /bridge/call with no poller -> 503 {ok:false}", r.status === 503 && body.ok === false && body.error === "extension not connected", `${r.status} ${JSON.stringify(body)}`);

  // Unknown route under /bridge/ is still ours (404 JSON), never the host's.
  r = await api("/bridge/nope");
  check("unknown /bridge/ route -> 404 from the bridge", r.status === 404 && r.headers.get("content-type")?.includes("json"));

  // Nothing but dotfiles were created; never a Markdown file.
  const files = await fs.readdir(tmp);
  check("only bridge dotfiles written to dataDir", files.every((f) => f.startsWith(".bridge.")), files.join(", "));

  bridge.close();
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-bridge error:", e?.stack || e?.message || e);
  process.exit(1);
});
