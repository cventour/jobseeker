#!/usr/bin/env node
// Run state and the schedule ladder, end to end.
//
//   node scripts/test-run-state.mjs
//
// Every case runs against a THROWAWAY COPY of the repo with a redirected HOME. That is a safety
// requirement, not tidiness, and three separate things make it so:
//
//   * scripts/job-run.sh reap_whatsapp_mcp() does `pgrep -f whatsapp-claude-channel` and KILLS what
//     it finds. An unguarded run severs the developer's live WhatsApp device link (JOBRUN_REAP_WHATSAPP=0).
//   * the ladder writes real launch agents through set-schedule.sh, so an unguarded run moves the
//     developer's actual 08:00 schedule (fake HOME + stubbed launchctl).
//   * job-run.sh fires desktop notifications (osascript) and holds the Mac awake (caffeinate).
//
// `claude` is stubbed too: a run costs money, and a test must not.
//
// Only server/dashboard.mjs honours JOBSEEKER_DATA_DIR; audit.mjs and record.mjs resolve data/ from
// __dirname/.. — so the sandbox has to be a real repo copy, not a redirected data directory.

// Windows: the same sandbox, OS-shaped bits swapped rather than skipped. Stubs become `.cmd` batch
// files, HOME *and* USERPROFILE are redirected, PATH is joined with path.delimiter, and every script
// runs through platform.scriptCommand() — imported FROM THE SANDBOX COPY so its ROOT is the sandbox
// and the PowerShell twin under scripts\win\ is what is exercised. The ladder there writes a real
// Task Scheduler task, so JOBSEEKER_TASK_NAME pins it to JobSeeker\JobRunTest (never the real
// \JobSeeker\JobRun) and cleanup unregisters it.

import { promises as fs } from "fs";
import { execFile } from "child_process";
import path from "path";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const WIN_TASK = "JobSeeker\\JobRunTest";
let plat;   // server/platform.mjs, loaded from the sandbox so ROOT is the sandbox
let pass = 0, fail = 0;
const ok = (n, x = "") => { pass++; console.log(`  ok    ${n}${x ? " — " + x : ""}`); };
const bad = (n, x = "") => { fail++; console.log(`  FAIL  ${n}${x ? " — " + x : ""}`); };
const check = (c, n, x = "") => (c ? ok(n, x) : bad(n, x));

const sh = (cmd, args, opts = {}) =>
  new Promise((res) => execFile(cmd, args, { maxBuffer: 8 << 20, ...opts }, (e, so, se) =>
    res({ code: e?.code ?? 0, out: String(so || ""), err: String(se || "") })));

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-runstate-"));
  for (const d of ["server", "scripts"]) await fs.cp(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  await fs.mkdir(path.join(dir, "config"), { recursive: true });
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  await fs.mkdir(path.join(dir, "home", "Library", "LaunchAgents"), { recursive: true });
  await fs.mkdir(path.join(dir, "bin"), { recursive: true });
  await fs.writeFile(path.join(dir, "config", "job-seeker.config.md"), "---\nmax_spend_per_run_usd: 5\n---\n");
  await fs.writeFile(path.join(dir, "data", "activity.md"),
    "# Activity\n\n| timestamp | type | detail |\n|-----------|------|--------|\n");
  await fs.writeFile(path.join(dir, "data", "boards.md"),
    "# Boards\n\n| company | access | careers_url | last_verified | dismissed |\n|---|---|---|---|---|\n");
  // job-run.sh re-probes the browser at the top of every run, which would overwrite the coverage
  // each case seeds — and when the probe finds nothing it sleeps 45s before retrying, which is what
  // made the first version of this suite time out. Both browser scripts become no-ops so the
  // seeded .browser-status.json is the only thing that decides coverage.
  for (const noop of ["browser-probe.mjs", "board-sweep.mjs", "chat-sweep.mjs"]) {
    await fs.writeFile(path.join(dir, "scripts", noop), "process.exit(0);\n");
  }
  // The macOS run shells out to these four; the Windows twin uses toast notifications and CIM
  // instead, but the stubs are written anyway so nothing can quietly fall through to a real one.
  for (const [n, code] of [
    ["launchctl", 0],
    ["osascript", 0],
    ["caffeinate", 0],
    ["pgrep", 1],
  ]) await writeStub(dir, n, `#!/bin/bash\nexit ${code}\n`, `@echo off\r\nexit /b ${code}\r\n`);
  return dir;
}

// A stub executable: a bash script on macOS, a .cmd batch file on Windows (an extensionless file is
// not executable there, and PATHEXT puts .cmd ahead of it anyway).
async function writeStub(dir, name, bash, cmd) {
  if (IS_WIN) await fs.writeFile(path.join(dir, "bin", `${name}.cmd`), cmd);
  else await fs.writeFile(path.join(dir, "bin", name), bash, { mode: 0o755 });
}

/** Run one of the repo's scripts — scripts/<name>.sh or scripts\win\<name>.ps1 — inside `dir`. */
const runScript = (dir, name, args = [], extraEnv = {}) => {
  const c = plat.scriptCommand(name, args);
  return sh(c.cmd, c.args, { cwd: dir, env: env(dir, extraEnv) });
};

// HOME is what the launchd path reads; USERPROFILE is what Windows reads. Both are redirected so
// neither OS can reach the developer's real home.
const env = (dir, extra = {}) => ({
  ...process.env,
  HOME: path.join(dir, "home"),
  USERPROFILE: path.join(dir, "home"),
  PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
  ...(IS_WIN ? { JOBSEEKER_TASK_NAME: WIN_TASK } : {}),
  JOBRUN_REAP_WHATSAPP: "0",
  JOBRUN_GUARD: "0",
  JOBRUN_ATTEMPTS: "1",
  JOBRUN_TIMEOUT_SECS: "60",
  ...extra,
});

// Put the sandbox into a named coverage state, then run job-run.sh and read back its verdict.
async function runWith(dir, { canRead, digest, exitCode = 0, boards = 0 }) {
  await fs.writeFile(path.join(dir, "data", ".browser-status.json"), JSON.stringify({
    chrome_running: true,
    capabilities: { read_page_content: canRead, read_mechanism: canRead ? "apple-events" : "none" },
    blockers: canRead ? [] : ["Allow JavaScript from Apple Events is off — Chrome ▸ View ▸ Developer."],
  }));
  const rows = Array.from({ length: boards }, (_, i) => `| Co${i} | browser | https://x/${i} | 2026-08-01 |  |`);
  await fs.writeFile(path.join(dir, "data", "boards.md"),
    "# Boards\n\n| company | access | careers_url | last_verified | dismissed |\n|---|---|---|---|---|\n" + rows.join("\n") + "\n");

  await fs.rm(path.join(dir, "data", ".last-digest.md"), { force: true });
  // The stub claude writes the digest, exactly as the real /job-run does — so "no digest" is a
  // genuine absence rather than a file the harness forgot to create.
  const bashStub = digest === null
    ? `#!/bin/bash\nprintf '{"result":"no digest","total_cost_usd":0}\\n'\nexit ${exitCode}\n`
    : `#!/bin/bash\ncat > "$(dirname "$0")/../data/.last-digest.md" <<'D'\n${digest}\n- something happened\nD\nprintf '{"result":"ran","total_cost_usd":0}\\n'\nexit ${exitCode}\n`;
  // Same stub as batch: same digest file, same JSON on stdout, same exit code. %~dp0 is bin\, and
  // the redirect goes before `echo` so no trailing space lands in the digest.
  const cmdStub = (digest === null
    ? ['@echo off', 'echo {"result":"no digest","total_cost_usd":0}']
    : ['@echo off',
       `> "%~dp0..\\data\\.last-digest.md" echo ${digest}`,
       `>> "%~dp0..\\data\\.last-digest.md" echo - something happened`,
       'echo {"result":"ran","total_cost_usd":0}']
  ).concat(`exit /b ${exitCode}`).join("\r\n") + "\r\n";
  await writeStub(dir, "claude", bashStub, cmdStub);

  await runScript(dir, "job-run");
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "data", ".job-run.status.json"), "utf8"));
  } catch (e) {
    return { state: "UNREADABLE", error: String(e.message) };
  }
}

// Seed activity.md with a dated row of a given type. Newest-first, as record.mjs writes it.
async function seedActivity(dir, rows) {
  const body = rows.map(([date, type]) => `| ${date}T09:00:00.000Z | ${type} | seeded |`).join("\n");
  await fs.writeFile(path.join(dir, "data", "activity.md"),
    "# Activity\n\n| timestamp | type | detail |\n|-----------|------|--------|\n" + body + "\n");
}
const ladder = (dir, today, args = []) =>
  sh(process.execPath, [path.join(dir, "server", "audit.mjs"), "--gaps", today], { cwd: dir, env: env(dir) })
    .then((r) => JSON.parse(r.out).schedule_ladder);

async function main() {
  const dir = await sandbox();
  // platform.mjs from the SANDBOX copy, so scriptCommand() resolves scripts inside it.
  plat = await import(pathToFileURL(path.join(dir, "server", "platform.mjs")).href);
  console.log("\nrun state\n");

  // ---- the state rule -------------------------------------------------------------------------
  let st = await runWith(dir, { canRead: true, digest: "delivered: whatsapp" });
  check(st.state === "ok" && Array.isArray(st.gaps) && st.gaps.length === 0, "clean run reports ok", st.state);

  st = await runWith(dir, { canRead: false, digest: "delivered: whatsapp", boards: 53 });
  check(st.state === "partial", "a run that could not read pages reports partial", st.state);
  check((st.gaps || []).includes("browser-read"), "…and names browser-read");
  check((st.gaps || []).includes("boards-queued"), "…and the boards it therefore could not drain");
  check(String(st.coverage?.blockers?.[0] || "").includes("Apple Events"), "…keeping the blocker text verbatim");

  st = await runWith(dir, { canRead: true, digest: "not-delivered: whatsapp mcp busy" });
  check(st.state === "partial" && (st.gaps || []).includes("digest-undelivered"),
    "a digest that never reached the user is partial", st.state);

  st = await runWith(dir, { canRead: true, digest: null });
  check(st.state === "failed", "no digest at all is a failure, not a success", st.state);

  st = await runWith(dir, { canRead: true, digest: "delivered: whatsapp", exitCode: 1 });
  check(st.state === "failed", "a non-zero exit is failed even with perfect coverage", st.state);

  // ---- the previous-run snapshot ----------------------------------------------------------------
  await runWith(dir, { canRead: true, digest: "delivered: whatsapp" });
  const prev = JSON.parse(await fs.readFile(path.join(dir, "data", ".job-run.last.json"), "utf8"));
  check(prev.state === "failed", "the previous run's verdict is kept, not overwritten", prev.state);

  console.log("\nschedule ladder\n");

  // ---- the day-one guard ------------------------------------------------------------------------
  await fs.rm(path.join(dir, "data", ".schedule-tier.json"), { force: true });
  await seedActivity(dir, [["2026-07-01", "proposal-dismissed"]]);   // two months of silence
  let l = await ladder(dir, "2026-08-30");
  check(l.armed === false && l.action === "none", "an unarmed ladder recommends nothing");

  await runScript(dir, "schedule-ladder", [], { FAKE_TODAY: "2026-08-30" });
  l = await ladder(dir, "2026-08-30");
  check(l.armed === true && l.tier === 1 && l.action === "none",
    "arming on a install with months of stale history still leaves it daily", `dry_days=${l.dry_days}`);

  // ---- warn, then act -----------------------------------------------------------------------------
  l = await ladder(dir, "2026-09-02");   // armed 08-30, so 3 dry days
  check(l.action === "warn" && l.next_tier === 2, "3 dry days warns first", l.why);

  let r = await runScript(dir, "schedule-ladder", [], { FAKE_TODAY: "2026-09-02" });
  const afterWarn = JSON.parse(await fs.readFile(path.join(dir, "data", ".schedule-tier.json"), "utf8"));
  check(afterWarn.tier === 1, "…and does not step down on the same run that warned", `tier=${afterWarn.tier}`);

  // curation resumes -> the counter resets and no warning stands
  await seedActivity(dir, [["2026-09-03", "proposal-dismissed"], ["2026-07-01", "proposal-dismissed"]]);
  l = await ladder(dir, "2026-09-03");
  check(l.dry_days === 0 && l.action !== "warn" && l.action !== "step",
    "reviewing a role resets the clock", `dry_days=${l.dry_days}`);

  // ---- and the step after the warning actually moves the schedule ---------------------------------
  // The ladder reads "today" from `date`, so this drives schedule-ladder.sh through audit with a
  // pinned date instead: seed a warning, then assert the next evaluation says `step`, and that
  // taking it rewrites the launch agent in the FAKE home.
  await seedActivity(dir, [["2026-09-01", "proposal-dismissed"]]);
  await fs.writeFile(path.join(dir, "data", ".schedule-tier.json"), JSON.stringify({
    tier: 1, warned_at: "2026-09-04", armed_on: "2026-08-30", why: "seeded",
  }));
  l = await ladder(dir, "2026-09-05");
  check(l.action === "step" && l.next_tier === 2, "a warned ladder steps down on the next run", l.why);

  await runScript(dir, "set-schedule", ["08:00", "1,4"]);
  const plist = path.join(dir, "home", "Library", "LaunchAgents", "com.jobseeker.jobrun.plist");
  // The artefact the schedule leaves behind: a plist in the sandboxed HOME on macOS, a registered
  // Task Scheduler task (JobSeeker\JobRunTest, never the real one) on Windows. Same assertion,
  // asked of whichever object the OS actually uses.
  const scheduleExists = async () =>
    IS_WIN
      ? (await sh("schtasks.exe", ["/Query", "/TN", WIN_TASK])).code === 0
      : await fs.access(plist).then(() => true, () => false);
  const shown = await runScript(dir, "set-schedule", ["--show"]);
  check(shown.out.trim() === "08:00 1,4", "tier 2 writes a Mon+Thu launch agent to the sandboxed HOME", shown.out.trim());
  check(await scheduleExists(), IS_WIN ? "…and the scheduled task really exists there" : "…and the plist really exists there");

  await runScript(dir, "set-schedule", ["--remove"]);
  check(!(await scheduleExists()), "tier 4 removes it again");

  // ---- abandonment turns it off -------------------------------------------------------------------
  // Reset warned_at explicitly: the previous case left one standing, and a test that inherits its
  // precondition from the case above is a test that passes for the wrong reason.
  await fs.writeFile(path.join(dir, "data", ".schedule-tier.json"), JSON.stringify({
    tier: 2, warned_at: null, armed_on: "2026-08-30", why: "seeded",
  }));
  await seedActivity(dir, [["2026-09-03", "task-done"]]);
  l = await ladder(dir, "2026-09-20");   // 17 days, nothing at all
  check(l.action === "warn" && l.next_tier === 4, "14 days of total silence warns before switch-off", l.why);

  await fs.writeFile(path.join(dir, "data", ".schedule-tier.json"), JSON.stringify({
    tier: 2, warned_at: "2026-09-19", armed_on: "2026-08-30", why: "seeded",
  }));
  l = await ladder(dir, "2026-09-20");
  check(l.action === "step" && l.next_tier === 4, "…and switches off only after that warning", l.why);

  // Abandonment must outrank the gentler curation ladder — it is the only step that stops the
  // system entirely, so it cannot be masked by a tier-2 step-down queued behind it.
  await seedActivity(dir, [["2026-09-03", "task-done"], ["2026-09-03", "proposal-dismissed"]]);
  l = await ladder(dir, "2026-09-20");
  check(l.next_tier === 4, "abandonment outranks a pending curation step", `next=${l.next_tier}`);

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} ok, ${fail} failed\n`);
  // On macOS the schedule lives inside the sandbox HOME and goes with it. On Windows it is
  // registered with the OS, so it has to be unregistered even though the last case removed it.
  if (IS_WIN) await sh("schtasks.exe", ["/Delete", "/TN", WIN_TASK, "/F"]).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
  return fail ? 1 : 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error("harness error:", e?.message || e);
  process.exit(1);
});
