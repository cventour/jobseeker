#!/usr/bin/env node
// The welcome wizard, end to end.
//
// It runs against a THROWAWAY COPY of the repo, and that is not fussiness. The wizard writes to
// config/job-seeker.config.md and templates/answers.md, which are resolved from the repo root and
// NOT from JOBSEEKER_DATA_DIR — so a test that merely redirects the data directory still overwrites
// the real ones. It also installs a launchd agent, so HOME is redirected too and `launchctl` is
// stubbed, or a test run would move the user's actual 08:00 schedule.
//
//   node scripts/test-welcome.mjs
//
// `claude` is stubbed as well: the CV step spends money, and a test must not.
//
// Windows: the same sandbox, with the OS-shaped bits swapped rather than skipped. The stubs are
// `.cmd` batch files (PATHEXT makes `claude` resolve to claude.cmd), HOME *and* USERPROFILE are
// redirected, PATH is joined with path.delimiter, and every script is invoked through
// platform.scriptCommand() — which is imported FROM THE SANDBOX COPY, so its ROOT is the sandbox
// and the PowerShell twin under scripts\win\ is what actually runs. The schedule the wizard
// installs is a real Task Scheduler task, so JOBSEEKER_TASK_NAME isolates it to
// JobSeeker\WelcomeTest and the cleanup below unregisters it.

import { promises as fs } from "fs";
import { spawn, execFile } from "child_process";
import path from "path";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
// One Task Scheduler task name for the whole suite, never the real \JobSeeker\JobRun.
const WIN_TASK = "JobSeeker\\WelcomeTest";
const PORT = 4400 + Math.floor(Math.random() * 80);
let sandbox, server, plat;
let pass = 0, fail = 0;

const ok = (name, extra = "") => { pass++; console.log(`  ok    ${name}${extra ? " — " + extra : ""}`); };
const bad = (name, extra = "") => { fail++; console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`); };
const check = (cond, name, extra = "") => (cond ? ok(name, extra) : bad(name, extra));

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => execFile(cmd, args, { ...opts }, (e, out) => resolve(String(out || ""))));

async function makeSandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-welcome-"));
  for (const d of ["server", "scripts"]) await fs.cp(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  await fs.mkdir(path.join(dir, "config"), { recursive: true });
  await fs.mkdir(path.join(dir, "templates", "cv"), { recursive: true });
  await fs.mkdir(path.join(dir, "data", "markets"), { recursive: true });
  await fs.mkdir(path.join(dir, "home", "Library", "LaunchAgents"), { recursive: true });
  await fs.mkdir(path.join(dir, "bin"), { recursive: true });
  await fs.writeFile(path.join(dir, "config", "job-seeker.config.md"), "---\napproval_channels: chat\n---\n\n# Notes\n");
  await fs.writeFile(path.join(dir, "data", "criteria.md"), "---\nmarkets:\nroles:\nlocations:\nseniority:\n---\n\n# Notes\n");
  await fs.writeFile(path.join(dir, "data", "profile.md"), "---\ntitles:\n---\n\n# Summary\n\nNo CV parsed yet.\n");
  await fs.writeFile(path.join(dir, "data", "activity.md"), "# Activity\n\n| timestamp | type | detail |\n|-----------|------|--------|\n");

  // Stubs. launchctl must never address the real domain; claude must never be called for real.
  await writeStub(dir, "launchctl", "#!/bin/bash\nexit 0\n", "@echo off\r\nexit /b 0\r\n");
  await writeStub(
    dir,
    "claude",
    `#!/bin/bash
cat > data/profile.md <<'PROF'
${PROFILE_LINES.join("\n")}
PROF
printf '{"result":"stub","total_cost_usd":0}\\n'
`,
    // The batch twin writes the same profile.md, byte for byte, and echoes the same JSON.
    // %~dp0 is bin\, so ..\data\profile.md is the sandbox's own copy whatever the cwd is.
    ["@echo off", ...PROFILE_LINES.map((l, i) => cmdWrite("%~dp0..\\data\\profile.md", l, i === 0)),
     'echo {"result":"stub","total_cost_usd":0}'].join("\r\n") + "\r\n"
  );
  return dir;
}

// The profile the stubbed `claude` parse writes. Shared so the bash and batch stubs cannot drift.
const PROFILE_LINES = [
  "---",
  "titles: Solution Architect, Pre-sales Manager",
  "seniority: Senior",
  "skills: Cybersecurity, Pre-sales",
  "domains: Cybersecurity",
  "locations: Dubai, UAE; Remote",
  "---",
  "",
  "# Summary",
  "",
  "Stubbed parse.",
];

// One line of a here-doc, as batch. The redirect goes FIRST so no trailing space is echoed, and an
// empty line is `echo(` — plain `echo` with nothing after it prints the echo state instead.
const cmdWrite = (file, line, first) =>
  `${first ? ">" : ">>"} "${file}" echo${line === "" ? "(" : " " + line}`;

// A stub executable: a bash script on macOS, a .cmd batch file on Windows (cmd is ahead of the
// extensionless file in PATHEXT, and an extensionless file is not executable there at all).
async function writeStub(dir, name, bash, cmd) {
  if (IS_WIN) await fs.writeFile(path.join(dir, "bin", `${name}.cmd`), cmd);
  else await fs.writeFile(path.join(dir, "bin", name), bash, { mode: 0o755 });
}

// HOME is what the launchd path reads; USERPROFILE is what Windows reads. Both point at the
// sandbox so neither OS can touch the developer's real home.
const sandboxEnv = (extra = {}) => ({
  ...process.env,
  HOME: path.join(sandbox, "home"),
  USERPROFILE: path.join(sandbox, "home"),
  PATH: `${path.join(sandbox, "bin")}${path.delimiter}${process.env.PATH}`,
  ...(IS_WIN ? { JOBSEEKER_TASK_NAME: WIN_TASK } : {}),
  ...extra,
});

const url = (p) => `http://127.0.0.1:${PORT}${p}`;

async function get(p) {
  const r = await fetch(url(p), { redirect: "manual" });
  return { status: r.status, location: r.headers.get("location") || "", body: r.status === 200 ? await r.text() : "" };
}

async function post(p, fields) {
  const body = new URLSearchParams(fields).toString();
  const r = await fetch(url(p), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${PORT}` },
    body,
  });
  return { status: r.status, location: r.headers.get("location") || "" };
}

const read = (rel) => fs.readFile(path.join(sandbox, rel), "utf8").catch(() => "");

async function main() {
  sandbox = await makeSandbox();
  // platform.mjs from the SANDBOX, so scriptCommand() resolves scripts inside the throwaway copy.
  plat = await import(pathToFileURL(path.join(sandbox, "server", "platform.mjs")).href);
  server = spawn(process.execPath, [path.join(sandbox, "server", "dashboard.mjs")], {
    cwd: sandbox,
    env: { ...sandboxEnv(), PORT: String(PORT) },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(url("/welcome")); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  console.log("\nwelcome wizard\n");

  // --- a machine with nothing set up is taken to the wizard ---
  check((await get("/")).location.endsWith("/welcome"), "a fresh install is taken to the wizard");

  // A machine with no config FILE at all is the case the wizard was written for, and it was the one
  // case that never reached it: an older redirect sent a config-less install to Settings before the
  // wizard's own gate ran. The sandbox writes a config file, so nothing here ever exercised it.
  {
    const cfgPath = path.join(sandbox, "config", "job-seeker.config.md");
    const saved = await read("config/job-seeker.config.md");
    await fs.rm(cfgPath);
    check((await get("/")).location.endsWith("/welcome"), "a machine with no config file still reaches the wizard");
    await fs.writeFile(cfgPath, saved);
  }
  for (const step of ["start", "cv", "chrome", "markets", "roles", "seniority", "locations", "finish"]) {
    const r = await get(`/welcome?step=${step}`);
    check(r.status === 200 && r.body.includes("</html>"), `step renders: ${step}`);
  }

  // --- the CV step gates Continue until there is a CV ---
  const cv = await get("/welcome?step=cv");
  check(/value="next" disabled/.test(cv.body), "Continue is disabled with no CV");
  check(cv.body.includes("Skip your CV?"), "skipping the CV explains what it costs");

  // --- skipping is recorded, and doing the step later takes it back ---
  await post("/welcome-step", { step: "cv", action: "skip" });
  check((await read("config/job-seeker.config.md")).includes("welcome_skipped: cv"), "a skip is recorded");

  // --- the progress bar ---
  const prog = await get("/welcome?step=locations");
  check(/class="wprogress"/.test(prog.body), "the wizard shows a progress bar");
  check(/aria-valuenow="86"/.test(prog.body), "the bar reflects how far in you are", (prog.body.match(/aria-valuenow="\d+"/) || [])[0]);
  check(/Step 6 of 7/.test(prog.body), "and says so in words");

  // --- the Chrome step records the decision for both browser-only channels ---
  await post("/welcome-step", { step: "chrome", action: "next", chrome: "no" });
  let cfgNow = await read("config/job-seeker.config.md");
  check(/whatsapp_web_enabled: false/.test(cfgNow) && /linkedin_enabled: false/.test(cfgNow), "declining Chrome turns both browser channels off");
  await post("/welcome-step", { step: "chrome", action: "next", chrome: "yes" });
  cfgNow = await read("config/job-seeker.config.md");
  check(/whatsapp_web_enabled: true/.test(cfgNow) && /linkedin_enabled: true/.test(cfgNow), "accepting turns both on");

  // --- the four criteria steps must not blank each other ---
  await post("/welcome-step", { step: "markets", action: "next", markets: "Cybersecurity, Fintech" });
  await post("/welcome-step", { step: "roles", action: "next", roles: "Solution Architect" });
  await post("/welcome-step", { step: "seniority", action: "next", seniority: "Senior" });
  await post("/welcome-step", { step: "locations", action: "next", locations: "Dubai, UAE; Remote" });
  const crit = await read("data/criteria.md");
  check(
    /markets: Cybersecurity, Fintech/.test(crit) && /roles: Solution Architect/.test(crit) &&
      /seniority: Senior/.test(crit) && /locations: Dubai, UAE; Remote/.test(crit),
    "all four criteria steps survive each other"
  );
  check(/locations: Dubai, UAE; Remote/.test(crit), "a semicolon-separated location is not split on its comma");
  // The separator used to be inferred from the STORED value, so on an empty field a single
  // "Dubai, UAE" was stored comma-first and read back as two places.
  await post("/welcome-step", { step: "locations", action: "next", locations: "Dubai, UAE" });
  check(/locations: Dubai, UAE$/m.test(await read("data/criteria.md")), "one location typed into an empty field stays one location");
  await post("/welcome-step", { step: "locations", action: "next", locations: "Dubai, UAE; Remote" });
  check(/weight_market: 0.4/.test(crit), "scoring weights are seeded, not asked for");
  const marketFiles = await fs.readdir(path.join(sandbox, "data", "markets"));
  check(marketFiles.length === 2, "a market file is created per market", marketFiles.join(", "));

  // --- the answer library, now reached on its own from Settings rather than in the flow ---
  await post("/welcome-step", {
    step: "answers", action: "next", _standalone: "1",
    visa: "__other", visa_other: "Golden visa, self-sponsored",
    notice: "1 month", relocate: "", heard: "LinkedIn", salary: "open", pitch: "Two lines.",
  });
  const ans = await read("templates/answers.md");
  check(ans.includes("| work authorization / visa | Golden visa, self-sponsored |"), '"Something else" is written as the answer');
  check(!/\| willing to relocate \|/.test(ans), "an unanswered question is left out rather than written blank");
  check(ans.trim().endsWith("Two lines."), "the summary is kept");

  // --- channels, also reached on its own now ---
  await post("/welcome-step", { step: "channels", action: "next", whatsapp_web_enabled: "on", ignored_chats: "Family, Football", approval_channels: "chat" });
  const cfg = await read("config/job-seeker.config.md");
  check(/whatsapp_web_enabled: true/.test(cfg) && /linkedin_enabled: false/.test(cfg), "an unticked channel is written off, not left alone");
  check(/ignored_chats: Family, Football/.test(cfg), "the never-log list is saved");

  // --- a schedule that could never fire is refused ---
  // set-schedule.sh on macOS, scripts\win\set-schedule.ps1 on Windows — same command, same output.
  const showSched = () => {
    const c = plat.scriptCommand("set-schedule", ["--show"]);
    return run(c.cmd, c.args, { cwd: sandbox, env: sandboxEnv() }).then((x) => x.trim());
  };

  let r = await post("/welcome-step", { step: "finish", action: "next", cadence: "custom", time: "07:30" });
  check(decodeURIComponent(r.location).includes("Pick at least one day"), "a schedule with no days is refused");
  r = await post("/welcome-step", { step: "finish", action: "next", cadence: "daily", time: "99:99" });
  check(decodeURIComponent(r.location).includes("is not a time"), "a nonsense time is refused");
  r = await post("/welcome-step", { step: "finish", action: "next", cadence: "nonsense", time: "07:30" });
  check(decodeURIComponent(r.location).includes("Unknown schedule"), "an unknown cadence is refused");

  // --- every cadence reaches launchd as the right day list ---
  await post("/welcome-step", { step: "finish", action: "next", cadence: "weekdays", time: "07:30", start_now: "no" });
  check((await showSched()) === "07:30 1,2,3,4,5", "weekdays reaches launchd as Monday to Friday", await showSched());
  await post("/welcome-step", { step: "finish", action: "next", cadence: "twice", time: "07:30", start_now: "no" });
  check((await showSched()) === "07:30 1,4", "twice a week reaches launchd as Mon and Thu", await showSched());
  await post("/welcome-step", { step: "finish", action: "next", cadence: "weekly", weekday: "3", time: "07:30", start_now: "no" });
  check((await showSched()) === "07:30 3", "once a week uses the day you picked", await showSched());
  await post("/welcome-step", { step: "finish", action: "next", cadence: "daily", time: "07:30", start_now: "no" });
  check((await showSched()) === "07:30", "every day is the plain schedule, with no day list", await showSched());

  // --- every other day is the daily plist plus a gate, because launchd cannot express 48 hours ---
  await post("/welcome-step", { step: "finish", action: "next", cadence: "alt", time: "07:30", start_now: "no" });
  check((await showSched()) === "07:30", "every other day installs the daily schedule");
  check(/min_hours_between_runs: 40/.test(await read("config/job-seeker.config.md")), "…and records the gap the run itself enforces");

  // --- the chosen cadence is recorded as the ladder's baseline ---
  await post("/welcome-step", { step: "finish", action: "next", cadence: "twice", time: "07:30", start_now: "no" });
  check(/schedule_days: 1,4/.test(await read("config/job-seeker.config.md")), "the cadence is stored so the ladder never speeds it back up");
  check(!/min_hours_between_runs: 40/.test(await read("config/job-seeker.config.md")), "…and the every-other-day gate is cleared when it no longer applies");

  // --- "only when I ask" removes it ---
  await post("/welcome-step", { step: "finish", action: "next", cadence: "off", start_now: "no" });
  check((await showSched()) === "not scheduled", "only-when-I-ask unschedules it", await showSched());

  // --- finishing, and the handoff ---
  r = await post("/welcome-step", { step: "finish", action: "next", cadence: "weekdays", time: "07:30", start_now: "no" });
  check((r.location || "").includes("welcome=done"), "finishing lands on Today");
  check((r.location || "").includes("hint=runnow"), "declining the first run arms the pointer at Run now");
  check((await showSched()) === "07:30 1,2,3,4,5", "the chosen days reach launchd", await showSched());
  check((await read("config/job-seeker.config.md")).includes("welcome_done:"), "setup is recorded as finished");

  // --- saying yes starts the run through the same path the dashboard uses ---
  r = await post("/welcome-step", { step: "finish", action: "next", cadence: "weekdays", time: "07:30", start_now: "yes" });
  check((r.location || "").includes("welcome=done") && !(r.location || "").includes("hint=runnow"), "saying yes goes to Today with no pointer");
  const pending = await read("data/.run-now.pending.json");
  check(/"slug":"job-run"/.test(pending), "…and a run is actually claimed", pending.slice(0, 80));
  try {
    const pid = JSON.parse(pending).pid;
    if (pid) process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  check(!(await get("/")).location.includes("welcome"), "a finished install is never bounced back into the wizard");

  // --- Today asks about the markets nobody has researched ---
  const today = await get("/");
  check(today.body.includes("Shall I research"), "Today asks whether to research a market");
  await post("/defer-market-ask", { market: "cybersecurity" });
  await post("/defer-market-ask", { market: "fintech" });
  const after = await get("/");
  check(!after.body.includes("Shall I research"), '"Not now" retires the card');
  check(/has not been researched|have not been researched/.test(after.body), "…but leaves a line saying why Today is empty");
  const evil = await post("/defer-market-ask", { market: "../../etc/passwd" });
  check(decodeURIComponent(evil.location).includes("Unknown market"), "an unknown market name is refused");

  // --- one step, on its own: the way you change something months later --------------------------
  for (const step of ["cv", "chrome", "markets", "roles", "seniority", "locations", "answers", "channels", "finish"]) {
    const r = await get(`/setup-step?step=${step}&back=settings`);
    check(r.status === 200 && !r.body.includes('class="wprogress"'), `standalone step has no progress bar: ${step}`);
  }
  const solo = await get("/setup-step?step=cv&back=settings");
  check(!/value="skip"/.test(solo.body) && !/value="leave"/.test(solo.body), "standalone has no Skip or Leave — there is no flow to leave");

  // saving from standalone returns you where you came from, and never claims setup finished
  let solor = await post("/welcome-step", { step: "roles", action: "next", return: "standalone", back: "settings", roles: "Architect" });
  check(solor.location.includes("/settings"), "saving a standalone step returns you where you came from");
  solor = await post("/welcome-step", { step: "finish", action: "next", return: "standalone", back: "settings", cadence: "off" });
  check(solor.location.includes("/settings") && !solor.location.includes("welcome=done"), "a standalone schedule save does not claim setup is finished");

  // `back` is an allow-list, not a URL anyone can aim
  solor = await post("/welcome-step", { step: "roles", action: "next", return: "standalone", back: "https://evil.example", roles: "Architect" });
  check(!/evil\.example/.test(solor.location) && solor.location.includes("/settings"), "an off-site `back` is ignored", solor.location);
  check((await get("/setup-step?step=nonsense")).location.includes("/settings"), "an unknown standalone step goes back to Settings");

  // --- replacing a CV shows what changed, once ----------------------------------------------------
  await fs.writeFile(path.join(sandbox, "data", "profile.md"),
    "---\nsource_cv: templates/cv/old.pdf\ntitles: Pre-sales Engineer\nseniority: Mid\ndomains: Networking\n---\n\n# Summary\n\nOld.\n");
  const repl = await get("/setup-step?step=cv&back=settings");
  check(repl.body.includes("Replace your CV"), "a CV that already parsed is a REPLACEMENT, not an addition");
  check(repl.body.includes("What JobSeeker knows now"), "…and shows what is about to be overwritten");
  await fs.writeFile(path.join(sandbox, "data", "profile.md"),
    "---\nsource_cv: templates/cv/old.pdf\ntitles: Pre-sales Engineer\nseniority: Mid\ndomains: Networking\n---\n\n# Summary\n\nOld.\n");
  await fs.writeFile(path.join(sandbox, "templates", "cv", "old.pdf"), "%PDF-1.4\n");
  await fetch(url("/welcome-parse"), { method: "POST", headers: { origin: `http://127.0.0.1:${PORT}` } });
  // Poll rather than sleep a fixed span. The parse is detached, and starting PowerShell costs far
  // more than starting bash -- a 2.5s wait passed on macOS and expired on Windows before the twin
  // had written profile.md. The assertion below is unchanged: if the re-read never lands, the last
  // body polled still has no "What changed" and the check fails as it always would.
  let changed = await get("/setup-step?step=cv&back=settings");
  for (let i = 0; i < 60 && !changed.body.includes("What changed"); i++) {
    await new Promise((r) => setTimeout(r, 500));
    changed = await get("/setup-step?step=cv&back=settings");
  }
  // When this fails there is nothing on screen to explain why, and the work happened in a detached
  // process on another machine. Say what the parse itself reported.
  let why = "";
  if (!changed.body.includes("What changed")) {
    for (const f of [".cv-parse.status.json", ".cv-parse.log"]) {
      try {
        why += ` | ${f}: ${(await fs.readFile(path.join(sandbox, "data", f), "utf8")).trim().replace(/\s+/g, " ").slice(0, 400)}`;
      } catch {
        why += ` | ${f}: absent`;
      }
    }
    // Nothing written at all means the script never started, which the detached spawn cannot
    // report. Run the same command in the foreground and quote whatever it says.
    try {
      const c = plat.scriptCommand("parse-cv");
      const scriptPath = c.args[c.args.length - (c.cmd === "bash" ? 1 : 1)];
      const present = await fs.access(c.args.find((a) => /\.(sh|ps1)$/.test(a)) || scriptPath)
        .then(() => "present").catch(() => "MISSING");
      const out = await new Promise((res) =>
        execFile(c.cmd, c.args, { cwd: sandbox, timeout: 60_000, env: sandboxEnv() }, (e, so, se) =>
          res(`exit ${e ? e.code : 0}; stderr=${JSON.stringify(String(se || "").trim().slice(0, 300))}; stdout=${JSON.stringify(String(so || "").trim().slice(0, 300))}`)
        )
      );
      // Decisive split: if this probe also comes back silent with exit 0, the host itself is not
      // running anything and the script is innocent.
      const sp = c.args.find((a) => /\.ps1$/.test(a)) || scriptPath;
      const probe = await new Promise((res) =>
        execFile(c.cmd, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
          `$ErrorActionPreference='Continue'; ` +
          `$r = (Resolve-Path (Join-Path (Split-Path '${sp}') '..\\..')).Path; ` +
          `Write-Output ('repo=' + $r); ` +
          `Write-Output ('pdfs=' + ((Get-ChildItem (Join-Path $r 'templates\\cv\\*.pdf') -File -ErrorAction SilentlyContinue).Count)); ` +
          `& '${sp}'; Write-Output ('rc=' + $LASTEXITCODE); ` +
          `Write-Output ('status_at_repo=' + (Test-Path (Join-Path $r 'data\\.cv-parse.status.json'))); ` +
          `$Error | ForEach-Object { Write-Output ('ERR: ' + $_.ToString()) }`],
          { cwd: sandbox, timeout: 60_000, env: sandboxEnv() },
          (e, so, se) => res(`exit ${e ? e.code : 0}; out=${JSON.stringify(String(so || "").trim().slice(0, 600))}; err=${JSON.stringify(String(se || "").trim().slice(0, 400))}`))
      );
      why += ` | cmd=${c.cmd} script=${present} | ${out.replace(/\s+/g, " ")} | invoked with -Command: ${probe}`;
    } catch (e) {
      why += ` | could not run it directly: ${e.message}`;
    }
  }
  check(changed.body.includes("What changed") && changed.body.includes("Pre-sales Engineer"),
    "a re-read shows the old values beside the new ones", why);
  check(changed.body.includes("keep the score they were given") || changed.body.includes("only future hunts"),
    "…and says what a re-read does not change");
  await post("/welcome-step", { step: "cv", action: "next", return: "standalone", back: "settings" });
  check(!(await get("/setup-step?step=cv&back=settings")).body.includes("What changed"),
    "…and stops showing them once you have seen them");

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} ok, ${fail} failed\n`);
}

try {
  await main();
} catch (e) {
  console.error("\nharness error:", e?.message || e);
  fail++;
} finally {
  server?.kill();
  // The wizard's last act installs a schedule. On macOS that is a plist inside the sandbox HOME and
  // goes with the directory; on Windows it is a real Task Scheduler task, which has to be removed.
  if (IS_WIN && sandbox && plat) {
    const c = plat.scriptCommand("set-schedule", ["--remove"]);
    await run(c.cmd, c.args, { cwd: sandbox, env: sandboxEnv() }).catch(() => {});
  }
  if (sandbox) await fs.rm(sandbox, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
