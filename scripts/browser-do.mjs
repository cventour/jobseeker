#!/usr/bin/env node
// Ask the browser broker to do Chrome work, and wait for the answer.
//
// Callers use this INSTEAD of driving Chrome in-process, so the Apple Events are always issued by
// the LaunchAgent (a stable, permanently-granted identity) rather than by whichever Claude Code
// binary happens to be running today. See scripts/browser-agent.sh for why that matters.
//
//   node scripts/browser-do.mjs probe
//   node scripts/browser-do.mjs chat-sweep --dry-run
//   node scripts/browser-do.mjs read-url https://careers.example.com/jobs
//   node scripts/browser-do.mjs board-sweep --max 15
//   node scripts/browser-do.mjs chat-sweep --linkedin
//
// Falls back to running in-process if the agent is not installed, so nothing breaks on a machine
// that has not run scripts/install-browser-agent.sh -- it just prompts more often.

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const REQ = path.join(DATA, ".browser-request.json");
const RES = path.join(DATA, ".browser-result.json");
const LABEL = "com.jobseeker.browser";

const sh = (cmd, args, timeout = 600_000) =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || err?.message || "") })
    )
  );

async function agentInstalled() {
  const r = await sh("launchctl", ["print", `gui/${process.getuid()}/${LABEL}`], 15_000);
  return r.ok;
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action) {
    process.stderr.write("usage: browser-do.mjs <probe|chat-sweep> [args...]\n");
    process.exit(64);
  }

  if (!(await agentInstalled())) {
    // Honest fallback: say why the slower path is being used rather than silently prompting.
    process.stderr.write(
      `browser-do: ${LABEL} is not installed — running in-process instead.\n` +
        `            macOS will ask for Automation permission again after every Claude Code update.\n` +
        `            Install once with: bash scripts/install-browser-agent.sh\n`
    );
    const script =
      { probe: "browser-probe.mjs", "read-url": "browser-read.mjs", "board-sweep": "board-sweep.mjs" }[action] ||
      "chat-sweep.mjs";
    const r = await sh("node", [path.join(ROOT, "scripts", script), ...args]);
    process.stdout.write(r.out);
    if (r.err) process.stderr.write(r.err);
    process.exit(r.ok ? 0 : 1);
  }

  const id = `req_${Date.now().toString(36)}`;
  await fs.mkdir(DATA, { recursive: true });
  await fs.rm(RES, { force: true });
  await fs.writeFile(REQ, JSON.stringify({ id, action, args }, null, 2));

  // -k restarts the job if it is somehow already running, so a stuck previous request cannot wedge
  // every later one.
  const kick = await sh("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${LABEL}`], 30_000);
  if (!kick.ok) {
    process.stderr.write(`browser-do: could not start ${LABEL}: ${kick.err}\n`);
    process.exit(1);
  }

  // Browser work is slow (page loads, human-paced reading), so the wait is generous.
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    try {
      const res = JSON.parse(await fs.readFile(RES, "utf8"));
      if (res.id === id) {
        process.stdout.write(res.output || "");
        if (!res.output?.endsWith("\n")) process.stdout.write("\n");
        process.exit(res.ok ? 0 : res.code || 1);
      }
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stderr.write(`browser-do: timed out waiting for ${LABEL} (see data/.browser-agent.log)\n`);
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write("browser-do: " + (e?.message || e) + "\n");
  process.exit(1);
});
