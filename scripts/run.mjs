#!/usr/bin/env node
// Run a JobSeeker script by name on whichever OS this is.
//
//   node scripts/run.mjs set-schedule 08:00 1,4
//   node scripts/run.mjs setup
//
// On macOS that is `bash scripts/set-schedule.sh 08:00 1,4`; on Windows it is
// `powershell -File scripts/win/set-schedule.ps1 08:00 1,4`. The npm scripts in package.json and
// the agent instructions in .claude/ go through here so they never name a shell.

import { spawn } from "child_process";
import { scriptCommand, ROOT } from "../server/platform.mjs";

const [name, ...args] = process.argv.slice(2);
if (!name || name.startsWith("-")) {
  process.stderr.write("usage: node scripts/run.mjs <script-name> [args...]\n");
  process.exit(64);
}

const { cmd, args: cmdArgs } = scriptCommand(name, args);
const child = spawn(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit", windowsHide: true });
child.on("error", (e) => {
  process.stderr.write(`run.mjs: could not start ${cmd}: ${e.message}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
