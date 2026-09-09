#!/usr/bin/env node
// Collect everything worth knowing when something is broken, into one file.
//
//   npm run diagnose
//
// It exists because the alternative is a conversation: "what does the log say", "which log", "run
// this, now paste that". Every question in that exchange is answerable from the machine itself, so
// this asks all of them at once and writes the answers to data/diagnostics.txt. Hand that over and
// whoever is helping can read it instead of interviewing you.
//
// It never writes anywhere except that one file, never touches data/*.md, and redacts the things
// that should not travel: the bridge token, the WhatsApp number, anything that looks like a key.

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import * as platform from "../server/platform.mjs";

const ROOT = platform.ROOT;
const DATA = process.env.JOBSEEKER_DATA_DIR ? path.resolve(process.env.JOBSEEKER_DATA_DIR) : path.join(ROOT, "data");
const OUT = path.join(DATA, "diagnostics.txt");
const TAIL = 60;

const lines = [];
const say = (s = "") => lines.push(s);
const head = (s) => {
  say("");
  say("=".repeat(78));
  say(s);
  say("=".repeat(78));
};

/** Anything that could identify or authenticate is replaced, not truncated. */
function redact(text) {
  return String(text)
    .replace(/\b[0-9a-f]{32,}\b/gi, "<redacted-token>")
    .replace(/(token|secret|key|password|authorization)("?\s*[:=]\s*"?)[^\s",}]+/gi, "$1$2<redacted>")
    .replace(/\+?\d[\d\s()-]{8,}\d/g, "<redacted-phone>");
}

async function tail(file, n = TAIL) {
  try {
    const t = await fs.readFile(file, "utf8");
    const all = t.split(/\r?\n/);
    const kept = all.slice(-n);
    return `${all.length} lines, showing last ${Math.min(n, all.length)}:\n` + redact(kept.join("\n"));
  } catch (e) {
    return e.code === "ENOENT" ? "(absent)" : `(unreadable: ${e.code || e.message})`;
  }
}

async function show(label, file, n = TAIL) {
  say("");
  say(`--- ${label}  [${path.relative(ROOT, file)}] ---`);
  say(await tail(file, n));
}

async function cmd(label, c, args, opts = {}) {
  const r = await platform.run(c, args, { timeout: 20_000, ...opts });
  say("");
  say(`--- ${label} ---`);
  say(redact((r.out || r.err || "(no output)").trim()).split("\n").slice(0, 40).join("\n"));
  if (!r.ok) say(`(exit ${r.code})`);
}

async function main() {
  head(`JobSeeker diagnostics — ${new Date().toISOString()}`);
  say(`platform     ${process.platform} ${os.release()} (${process.arch})`);
  say(`node         ${process.version} at ${process.execPath}`);
  say(`repo         ${ROOT}`);
  say(`data         ${DATA}`);
  say(`claude       ${platform.resolveBin("claude") || "NOT FOUND on PATH"}`);
  if (platform.IS_WIN) say(`powershell   ${platform.resolveBin("powershell")}`);
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
    say(`version      ${pkg.version}`);
  } catch {
    say("version      (package.json unreadable)");
  }

  head("Is anything running");
  const port = await (async () => {
    try {
      const cfg = await fs.readFile(path.join(ROOT, "config", "job-seeker.config.md"), "utf8");
      const m = /^dashboard_port:\s*(\d+)/m.exec(cfg);
      return m ? Number(m[1]) : 4319;
    } catch {
      return 4319;
    }
  })();
  for (const p of [port, 4320]) {
    for (const route of ["_whoami", "bridge/status"]) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/${route}`, { signal: AbortSignal.timeout(4000) });
        say(`127.0.0.1:${p}/${route} -> ${r.status} ${redact(await r.text()).slice(0, 300)}`);
      } catch (e) {
        say(`127.0.0.1:${p}/${route} -> no answer (${e.name})`);
      }
    }
  }

  head("The daily run");
  {
    const r = await platform.runScript("set-schedule", ["--show"], { timeout: 20_000 });
    say("");
    say("--- schedule ---");
    say(redact((r.out || r.err || "(no output)").trim()));
  }
  await show("last run status", path.join(DATA, ".job-run.status.json"), 40);
  await show("job-run log", path.join(DATA, ".job-run.log"));

  head("Browser and the bridge");
  await show("browser status", path.join(DATA, ".browser-status.json"), 60);
  await show("bridge requests", path.join(DATA, ".bridge.log"), 80);
  say("");
  say("--- bridge pairing ---");
  for (const f of [".bridge.ext.json", ".bridge.json"]) {
    say(`${f}: ${await tail(path.join(DATA, f), 10)}`);
  }
  say(`.bridge.token: ${(await fs
    .access(path.join(DATA, ".bridge.token"))
    .then(() => "present")
    .catch(() => "absent"))}`);
  const ext = path.join(ROOT, "extension");
  say("");
  say(`--- extension folder (${ext}) ---`);
  try {
    const files = await fs.readdir(ext);
    say(files.join(", "));
    const man = JSON.parse(await fs.readFile(path.join(ext, "manifest.json"), "utf8"));
    say(`manifest version ${man.version}`);
  } catch (e) {
    say(`(unreadable: ${e.message})`);
  }

  head("Other logs");
  for (const [label, file] of [
    ["dashboard", path.join(DATA, ".dashboard.log")],
    ["dashboard errors", path.join(DATA, ".dashboard.err.log")],
    ["detached jobs", path.join(DATA, ".spawn.log")],
    ["run now", path.join(DATA, ".run-now.log")],
    ["run now status", path.join(DATA, ".run-now.status.json")],
    ["CV parse", path.join(DATA, ".cv-parse.log")],
    ["setup", path.join(DATA, ".setup", "setup.log")],
    ["setup step", path.join(DATA, ".setup", "step.log")],
    // stdout and stderr are separate files, and a process that dies before it can announce itself
    // writes only to the second. Reading just the first is how an EADDRINUSE looked like silence.
    ["dashboard start (stdout)", path.join(DATA, ".setup", "server.log")],
    ["dashboard start (stderr)", path.join(DATA, ".setup", "server.err.log")],
    ["bridge (stderr)", path.join(DATA, ".setup", "bridge.err.log")],
    ["whatsapp server (stderr)", path.join(DATA, ".setup", "whatsapp-server.err.log")],
  ]) {
    await show(label, file);
  }
  if (platform.IS_WIN) {
    await show("installer", path.join(os.tmpdir(), "jobseeker-install.log"), 80);
  }

  head("Config (redacted)");
  say(await tail(path.join(ROOT, "config", "job-seeker.config.md"), 80));

  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(OUT, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${OUT}`);
  console.log("Tokens, keys and phone numbers are replaced; read it before sending it on.");
}

main().catch((e) => {
  console.error("diagnose failed:", e.message);
  process.exit(1);
});
