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

import { promises as fs, existsSync } from "fs";
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

// Put the sandbox into a named coverage state. Split out from runWith so the run-now cases can
// stage exactly the same run and then start it through the other entry point.
async function seedRun(dir, { canRead, digest, exitCode = 0, boards = 0 }) {
  await fs.writeFile(path.join(dir, "data", ".browser-status.json"), JSON.stringify({
    chrome_running: true,
    capabilities: { read_page_content: canRead, read_mechanism: canRead ? "apple-events" : "none" },
    blockers: canRead ? [] : ["Allow JavaScript from Apple Events is off — Chrome ▸ View ▸ Developer."],
  }));
  const rows = Array.from({ length: boards }, (_, i) => `| Co${i} | browser | https://x/${i} | 2026-08-01 |  |`);
  await fs.writeFile(path.join(dir, "data", "boards.md"),
    "# Boards\n\n| company | access | careers_url | last_verified | dismissed |\n|---|---|---|---|---|\n" + rows.join("\n") + "\n");

  await fs.rm(path.join(dir, "data", ".last-digest.md"), { force: true });
  // The stub claude writes the digest, exactly as the real /jobseeker job-run does — so "no digest" is a
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
}

// …then run job-run.sh and read back its verdict.
async function runWith(dir, opts) {
  await seedRun(dir, opts);
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
  // When the verdict is wrong, the verdict alone says nothing about why. Show what the run
  // actually measured, and the tail of its own log.
  const why = async () => {
    const tail = await fs.readFile(path.join(dir, "data", ".job-run.log"), "utf8")
      .then((t) => t.trim().split("\n").slice(-8).join(" / ")).catch(() => "no log");
    return `state=${st.state} gaps=${JSON.stringify(st.gaps)} coverage=${JSON.stringify(st.coverage)} log: ${tail}`;
  };
  check(st.state === "partial", "a run that could not read pages reports partial",
    st.state === "partial" ? st.state : await why());
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

  console.log("\nrun now — the verdict the dashboard shows\n");

  // The dashboard's "Run now" pill is rendered from data/.run-now.status.json, and for job-run that
  // file used to be written from job-run's EXIT CODE alone. job-run deliberately exits 0 while
  // recording `failed` for a run that wrote no digest, so the pill read "Full daily run — finished"
  // over a run whose own status file, one directory along, said the deliverable was missing. Every
  // case below asserts the two files agree.
  const runNowWith = async (opts) => {
    await seedRun(dir, opts);
    await runScript(dir, "run-now", ["job-run"]);
    try {
      return JSON.parse(await fs.readFile(path.join(dir, "data", ".run-now.status.json"), "utf8"));
    } catch (e) {
      return { state: "UNREADABLE", error: String(e.message) };
    }
  };

  let rn = await runNowWith({ canRead: true, digest: "delivered: whatsapp" });
  check(rn.state === "ok", "a clean run is reported as ok", rn.state);

  rn = await runNowWith({ canRead: true, digest: null });
  check(rn.state === "failed", "a run that wrote no digest is NOT reported as finished", rn.state);
  check(/no digest/i.test(String(rn.detail || "")), "…and the pill carries job-run's own words", rn.detail);

  rn = await runNowWith({ canRead: false, digest: "delivered: whatsapp" });
  check(rn.state === "partial", "a run that could not read pages is reported as partial", rn.state);

  // Freshness. A job-run that dies before writing anything must not hand back the verdict of the
  // run before it — "ok" from an hour ago is a worse answer than no answer at all.
  {
    await seedRun(dir, { canRead: true, digest: "delivered: whatsapp" });
    await runScript(dir, "run-now", ["job-run"]);   // leaves a genuine `ok` on disk
    // The script's own path, found by name rather than by position. On macOS the command is
    // `bash <script>`, so it is args[0]; on Windows it is `powershell -NoProfile ... -File <script>`,
    // and args[0] is "-NoProfile". Taking args[0] made this suite open a file called "-NoProfile" and
    // die with a harness error -- on every Windows run from v0.7.4 on, silently skipping everything
    // below this point, market research and the schedule ladder included.
    const jobRun = plat.scriptCommand("job-run").args.find((a) => /job-run\.(sh|ps1)$/.test(a));
    if (!jobRun) throw new Error("could not find the job-run script in scriptCommand's arguments");
    const saved = await fs.readFile(jobRun, "utf8");
    await fs.writeFile(jobRun, IS_WIN ? "exit 3\r\n" : "#!/usr/bin/env bash\nexit 3\n");
    try {
      await runScript(dir, "run-now", ["job-run"]);
      const after = JSON.parse(await fs.readFile(path.join(dir, "data", ".run-now.status.json"), "utf8"));
      check(after.state === "failed", "a job-run that wrote nothing does not inherit the last verdict", after.state);
    } finally {
      await fs.writeFile(jobRun, saved);
    }
  }

  console.log("\nmarket research\n");

  // Researching a market is spawned detached with its output discarded, so this status file is the
  // only thing that can ever reach the screen. Before it existed the button promised the companies
  // would appear on reload and then said nothing whatsoever, however the pass ended.
  const researchWith = async (extraEnv = {}) => {
    await fs.rm(path.join(dir, "data", ".markets-run.status.json"), { force: true });
    await runScript(dir, "research-market", ["Fintech"], extraEnv);
    try {
      return JSON.parse(await fs.readFile(path.join(dir, "data", ".markets-run.status.json"), "utf8"));
    } catch (e) {
      return { state: "UNREADABLE", error: String(e.message) };
    }
  };

  // A pass "worked" only if the list it exists to produce now has companies in it. Exiting 0 is not
  // the same claim, and the two came apart badly: four consecutive runs were refused every tool
  // they needed, wrote nothing, exited 0, and were each recorded as "Fintech researched" while the
  // market file sat at its empty scaffold. So the working stub writes rows, as a working agent does.
  const MARKET_FILE = path.join(dir, "data", "markets", "fintech.md");
  const SCAFFOLD = "# Market: Fintech\n\n| company | tier | hq | why | careers_url | linkedin_url | last_reviewed | notes |\n|---------|------|----|-----|-------------|--------------|---------------|-------|\n";
  const ROW = "| Acme | 1 | Dubai | fits | https://acme.example/careers | | 2026-09-10 | |\n";
  const seedMarket = async (body) => {
    await fs.mkdir(path.dirname(MARKET_FILE), { recursive: true });
    await fs.writeFile(MARKET_FILE, body);
  };

  await seedMarket(SCAFFOLD);
  // Every stub answers --help as the real CLI does: the scripts ask once whether this CLI can be
  // told what it may do, and a stub that says nothing is correctly treated as one that cannot.
  const HELP_SH = `if [ "$1" = "--help" ]; then echo '  --allowedTools <tools...>'; echo '  --permission-mode <mode>'; exit 0; fi\n`;
  const HELP_CMD = 'if "%1"=="--help" (echo   --allowedTools ^<tools...^>& echo   --permission-mode ^<mode^>& exit /b 0)\r\n';
  await fs.writeFile(path.join(dir, "bin", "row.txt"), ROW.replace(/\n$/, "\r\n"));
  const writesRows = `#!/bin/bash\n${HELP_SH}printf '%s' '${ROW.trim()}' >> data/markets/fintech.md\nprintf '\\n' >> data/markets/fintech.md\nprintf '{"result":"ranked","total_cost_usd":0}\\n'\nexit 0\n`;
  await writeStub(dir, "claude", writesRows,
    // The Windows stub copies a row file the test writes, rather than echoing the row: cmd reads every
    // | as a pipe, and escaping them with ^| still left the "worked" pass writing no row on Windows.
    // `type` of a file has nothing on its command line for cmd to reinterpret. %~dp0 is the stub's
    // own directory, bin\ -- outside data/markets, so the row file is never mistaken for a market.
    `@echo off\r\n${HELP_CMD}type "%~dp0row.txt" >> data\\markets\\fintech.md\r\necho {"result":"ranked","total_cost_usd":0}\r\nexit /b 0\r\n`);
  let mk = await researchWith();
  check(mk.state === "ok", "a research pass that worked says so", mk.detail ? `${mk.state} — ${mk.detail}` : mk.state);
  check(mk.market === "Fintech", "…and names the market it was asked for", mk.market);

  // The regression that made "markets scan does not work" unanswerable: the run finishes clean and
  // writes nothing, and the screen says ok.
  await seedMarket(SCAFFOLD);
  await writeStub(dir, "claude", `#!/bin/bash\n${HELP_SH}printf '{"result":"ranked","total_cost_usd":0}\\n'\nexit 0\n`,
    `@echo off\r\n${HELP_CMD}echo {"result":"ranked","total_cost_usd":0}\r\nexit /b 0\r\n`);
  mk = await researchWith();
  check(mk.state === "failed", "a pass that exits clean but writes no companies is not a success", mk.state);
  check(/wrote no companies/i.test(String(mk.detail || "")), "…and says the list is still empty", mk.detail);

  // And the cause underneath it: a headless run is refused the tools its agents need, and says so
  // in the response rather than in its exit code.
  await writeStub(dir, "claude",
    `#!/bin/bash\n${HELP_SH}printf '{"result":"blocked","total_cost_usd":0,"permission_denials":[{"tool_name":"Write"},{"tool_name":"WebSearch"}]}\\n'\nexit 0\n`,
    `@echo off\r\n${HELP_CMD}echo {"result":"blocked","total_cost_usd":0,"permission_denials":[{"tool_name":"Write"},{"tool_name":"WebSearch"}]}\r\nexit /b 0\r\n`);
  mk = await researchWith();
  check(mk.state === "failed", "a pass refused its tools reports failed, not ok", mk.state);
  check(/Write, WebSearch/.test(String(mk.detail || "")), "…and names the tools it was refused", mk.detail);

  // -p mode abandons background subagents after ~10 minutes and ends the turn anyway, so a fan-out
  // of research agents is cut off mid-work and nothing is written. The runner raises that ceiling;
  // this proves the value actually reaches the CLI, since it travels in the environment and is
  // therefore invisible in every log we keep.
  await writeStub(dir, "claude",
    `#!/bin/bash\n${HELP_SH}printf '%s' "$CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS" > data/.bgceiling\nprintf '{"result":"ranked","total_cost_usd":0}\\n'\nexit 0\n`,
    `@echo off\r\n${HELP_CMD}echo %CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS%> data\\.bgceiling\r\necho {"result":"ranked","total_cost_usd":0}\r\nexit /b 0\r\n`);
  await researchWith();
  const ceiling = (await fs.readFile(path.join(dir, "data", ".bgceiling"), "utf8").catch(() => "")).trim();
  check(Number(ceiling) >= 1_800_000, "a fan-out gets longer than the 10-minute default to finish in", `${ceiling}ms`);

  // A CLI too old to be told what it may do is its own cause, and its own instruction. It used to
  // be reported as a mysterious block, because the warning about it contains the word "permission".
  await writeStub(dir, "claude", `#!/bin/bash\nif [ "$1" = "--help" ]; then echo '  -p, --print'; exit 0; fi\nprintf '{"result":"ranked","total_cost_usd":0}\\n'\nexit 0\n`,
    '@echo off\r\nif "%1"=="--help" (echo   -p, --print& exit /b 0)\r\necho {"result":"ranked","total_cost_usd":0}\r\nexit /b 0\r\n');
  mk = await researchWith();
  check(/too old/i.test(String(mk.detail || "")), "a CLI too old to be told what it may do says exactly that", mk.detail);

  // Whatever the dashboard shows, the activity log has to carry it too — that is where somebody
  // looks when a button did nothing.
  const activity = await fs.readFile(path.join(dir, "data", "activity.md"), "utf8").catch(() => "");
  check(/markets-failed/.test(activity), "…and a failure reaches the activity log", activity.split("\n").find((l) => l.includes("markets-failed"))?.slice(0, 80) || "(absent)");

  // The run lock, which this script never took: a research pass on top of a daily run put two
  // agents in the same Chrome, which is the one thing AGENT-RULES §13 exists to forbid.
  await fs.writeFile(path.join(dir, "data", ".run-now.lock"), `${process.pid} job-run 2026-09-10T07:00:00Z\n`);
  mk = await researchWith();
  await fs.rm(path.join(dir, "data", ".run-now.lock"), { force: true });
  check(mk.state === "skipped-busy", "a pass refused because something else holds the lock says so", mk.state);

  // The failure that started all this: `claude` not on the PATH a GUI app hands its children. Only
  // skipped where a system-wide install would make the stub-free PATH reach a REAL claude — the
  // test must never spend money to prove a point about not spending money.
  const systemClaude = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
    .filter((p) => existsSync(p));
  if (systemClaude.length) {
    console.log(`  skip  claude-not-found case — a real claude at ${systemClaude[0]} would be found and run`);
  } else {
    await fs.rm(path.join(dir, "bin", IS_WIN ? "claude.cmd" : "claude"), { force: true });
    mk = await researchWith({ PATH: `${path.join(dir, "bin")}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${IS_WIN ? "C:\\Windows\\System32" : "/usr/bin:/bin"}` });
    check(mk.state === "failed", "a pass that could not find claude reports failed, not silence", mk.state);
    check(/Claude Code CLI/i.test(String(mk.detail || "")), "…and says that is why", mk.detail);
  }

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
