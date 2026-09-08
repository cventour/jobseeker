#!/usr/bin/env node
// Tests for the OS edge: server/platform.mjs and the CRLF / file-lock tolerance in server/md.mjs.
//
// Why these exist: the dashboard used to spawn `bash scripts/x.sh` directly. It now asks
// platform.mjs, and a wrong mapping would make a Settings button run the wrong script. So every
// name → command mapping is asserted here for BOTH platforms, using JOBSEEKER_FORCE_PLATFORM to
// load the module as if on the other OS. The CRLF tests guard a real bug: a config file saved by
// a Windows editor parsed as empty.
//
//   npm run test:platform

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
// ESM on Windows refuses a bare absolute path ("D:\\a\\..." is read as the protocol "d:"), so every
// dynamic import and every generated import statement goes through a file:// URL.
const mod = (...parts) => pathToFileURL(path.join(REPO, ...parts)).href;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// Load platform.mjs in a child process with the platform forced, and print the mappings as JSON.
async function mappings(forced) {
  const code = `
    import * as p from ${JSON.stringify(mod("server", "platform.mjs"))};
    const out = {
      IS_WIN: p.IS_WIN, IS_MAC: p.IS_MAC,
      setSchedule: p.scriptCommand("set-schedule", ["08:00", "1,4"]),
      runNow: p.scriptCommand("run-now", ["track"]),
      claudeRun: p.scriptCommand("lib/claude-run"),
      node: p.nodeCommand("server/record.mjs", ["list-spend"]),
      agent: await p.browserAgentStatus().then(s => s.applicable),
    };
    console.log(JSON.stringify(out));
  `;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, JOBSEEKER_FORCE_PLATFORM: forced, PATH: "" },
  });
  return JSON.parse(stdout);
}

async function testMappings() {
  console.log("platform mappings");
  const mac = await mappings("darwin");
  check("darwin: IS_MAC", mac.IS_MAC && !mac.IS_WIN);
  check("darwin: set-schedule → bash", mac.setSchedule.cmd === "bash");
  check(
    "darwin: set-schedule → scripts/set-schedule.sh 08:00 1,4",
    mac.setSchedule.args.join(" ") === `${path.join(REPO, "scripts", "set-schedule.sh")} 08:00 1,4`
  );
  check("darwin: run-now → scripts/run-now.sh track", mac.runNow.args[0].endsWith(path.join("scripts", "run-now.sh")) && mac.runNow.args[1] === "track");
  check("darwin: lib/claude-run → scripts/lib/claude-run.sh", mac.claudeRun.args[0].endsWith(path.join("scripts", "lib", "claude-run.sh")));
  check("darwin: browser agent applicable", mac.agent === true);

  const win = await mappings("win32");
  check("win32: IS_WIN", win.IS_WIN && !win.IS_MAC);
  check("win32: set-schedule → powershell.exe", /powershell\.exe$/i.test(win.setSchedule.cmd));
  check("win32: -NoProfile -NonInteractive -ExecutionPolicy Bypass -File", win.setSchedule.args.slice(0, 5).join(" ") === "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File");
  check("win32: set-schedule → scripts/win/set-schedule.ps1", win.setSchedule.args[5].endsWith(path.join("scripts", "win", "set-schedule.ps1")));
  check("win32: args preserved", win.setSchedule.args.slice(6).join(" ") === "08:00 1,4");
  check("win32: lib/claude-run → scripts/win/lib/claude-run.ps1", win.claudeRun.args[5].endsWith(path.join("scripts", "win", "lib", "claude-run.ps1")));
  check("win32: browser agent not applicable", win.agent === false);

  check("node command uses the running binary", win.node.cmd === process.execPath && mac.node.cmd === process.execPath);
  check("node command resolves script under ROOT", mac.node.args[0] === path.join(REPO, "server", "record.mjs"));

  const { scriptCommand, uid } = await import(mod("server", "platform.mjs"));
  let threw = false;
  try {
    scriptCommand("set-schedule.sh");
  } catch {
    threw = true;
  }
  check("scriptCommand rejects a name with an extension", threw);
  check("uid() is a number or null", uid() === null || Number.isInteger(uid()));
}

async function testCrlf() {
  console.log("CRLF tolerance (server/md.mjs)");
  const md = await import(mod("server", "md.mjs"));

  const lf = "---\nname: Test\nmarkets: A, B\n---\n\nbody line\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  const a = md.parseFrontmatter(lf);
  const b = md.parseFrontmatter(crlf);
  check("frontmatter: LF parses", a.data.name === "Test" && a.data.markets === "A, B");
  check("frontmatter: CRLF parses identically", JSON.stringify(b.data) === JSON.stringify(a.data), JSON.stringify(b.data));
  check("frontmatter: CRLF body has no stray \\r", !/\r/.test(b.body) && b.body.trim() === "body line");

  const bom = "﻿" + crlf;
  check("frontmatter: BOM + CRLF parses", md.parseFrontmatter(bom).data.name === "Test");

  if (typeof md.parseTable === "function") {
    const table = "| id | company |\n|---|---|\n| a1 | Acme |\n| a2 | Bolt |\n";
    const t1 = md.parseTable(table);
    const t2 = md.parseTable(table.replace(/\n/g, "\r\n"));
    check("table: CRLF parses identically", JSON.stringify(t1) === JSON.stringify(t2), JSON.stringify(t2).slice(0, 120));
  }
}

async function testAtomicWrite() {
  console.log("writeFileAtomic");
  const md = await import(mod("server", "md.mjs"));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-plat-"));
  const file = path.join(tmp, "x.md");
  await md.writeFileAtomic(file, "one\n");
  await md.writeFileAtomic(file, "two\n");
  check("overwrites in place", (await fs.readFile(file, "utf8")) === "two\n");
  const left = (await fs.readdir(tmp)).filter((f) => f.endsWith(".tmp"));
  check("no temp files left behind", left.length === 0, left.join(","));
  await fs.rm(tmp, { recursive: true, force: true });
}

async function testRunDispatcher() {
  console.log("scripts/run.mjs");
  const r = await run(process.execPath, [path.join(REPO, "scripts", "run.mjs")]).catch((e) => e);
  check("no args → usage, exit 64", r.code === 64 && /usage/.test(String(r.stderr)));
}

await testMappings();
await testCrlf();
await testAtomicWrite();
await testRunDispatcher();

console.log(failures ? `\n${failures} failure(s)` : "\nall platform tests passed");
process.exit(failures ? 1 : 0);
