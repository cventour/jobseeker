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

import { promises as fs } from "fs";
import { spawn, execFile } from "child_process";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4400 + Math.floor(Math.random() * 80);
let sandbox, server;
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
  await fs.writeFile(path.join(dir, "bin", "launchctl"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(
    path.join(dir, "bin", "claude"),
    `#!/bin/bash
cat > data/profile.md <<'PROF'
---
titles: Solution Architect, Pre-sales Manager
seniority: Senior
skills: Cybersecurity, Pre-sales
domains: Cybersecurity
locations: Dubai, UAE; Remote
---

# Summary

Stubbed parse.
PROF
printf '{"result":"stub","total_cost_usd":0}\\n'
`,
    { mode: 0o755 }
  );
  return dir;
}

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
  server = spawn("node", [path.join(sandbox, "server", "dashboard.mjs")], {
    cwd: sandbox,
    env: { ...process.env, PORT: String(PORT), HOME: path.join(sandbox, "home"), PATH: `${path.join(sandbox, "bin")}:${process.env.PATH}` },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(url("/welcome")); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  console.log("\nwelcome wizard\n");

  // --- a machine with nothing set up is taken to the wizard ---
  check((await get("/")).location.endsWith("/welcome"), "a fresh install is taken to the wizard");
  for (const step of ["start", "cv", "targets", "markets", "answers", "channels", "schedule"]) {
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

  // --- the two criteria steps must not blank each other ---
  await post("/welcome-step", { step: "targets", action: "next", roles: "Solution Architect", locations: "Dubai, UAE; Remote", seniority: "Senior" });
  await post("/welcome-step", { step: "markets", action: "next", markets: "Cybersecurity, Fintech" });
  const crit = await read("data/criteria.md");
  check(/roles: Solution Architect/.test(crit) && /markets: Cybersecurity, Fintech/.test(crit), "both criteria steps survive each other");
  check(/locations: Dubai, UAE; Remote/.test(crit), "a semicolon-separated location is not split on its comma");
  check(/weight_market: 0.4/.test(crit), "scoring weights are seeded, not asked for");
  const marketFiles = await fs.readdir(path.join(sandbox, "data", "markets"));
  check(marketFiles.length === 2, "a market file is created per market", marketFiles.join(", "));

  // --- the answer library, including the escape hatch ---
  await post("/welcome-step", {
    step: "answers", action: "next",
    visa: "__other", visa_other: "Golden visa, self-sponsored",
    notice: "1 month", relocate: "", heard: "LinkedIn", salary: "open", pitch: "Two lines.",
  });
  const ans = await read("templates/answers.md");
  check(ans.includes("| work authorization / visa | Golden visa, self-sponsored |"), '"Something else" is written as the answer');
  check(!/\| willing to relocate \|/.test(ans), "an unanswered question is left out rather than written blank");
  check(ans.trim().endsWith("Two lines."), "the summary is kept");

  // --- channels ---
  await post("/welcome-step", { step: "channels", action: "next", whatsapp_web_enabled: "on", ignored_chats: "Family, Football", approval_channels: "chat" });
  const cfg = await read("config/job-seeker.config.md");
  check(/whatsapp_web_enabled: true/.test(cfg) && /linkedin_enabled: false/.test(cfg), "an unticked channel is written off, not left alone");
  check(/ignored_chats: Family, Football/.test(cfg), "the never-log list is saved");

  // --- a schedule that could never fire is refused ---
  let r = await post("/welcome-step", { step: "schedule", action: "next", mode: "daily", time: "07:30" });
  check(decodeURIComponent(r.location).includes("Pick at least one day"), "a schedule with no days is refused");
  r = await post("/welcome-step", { step: "schedule", action: "next", mode: "daily", time: "99:99", day: "1" });
  check(decodeURIComponent(r.location).includes("is not a time"), "a nonsense time is refused");

  // --- finishing ---
  const body = new URLSearchParams([["step", "schedule"], ["action", "next"], ["mode", "daily"], ["time", "07:30"], ...[1, 2, 3, 4, 5].map((d) => ["day", String(d)])]);
  r = await fetch(url("/welcome-step"), {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${PORT}` },
    body: body.toString(),
  });
  check((r.headers.get("location") || "").includes("welcome=done"), "finishing lands on Today");
  const sched = await run("bash", [path.join(sandbox, "scripts", "set-schedule.sh"), "--show"], {
    cwd: sandbox, env: { ...process.env, HOME: path.join(sandbox, "home"), PATH: `${path.join(sandbox, "bin")}:${process.env.PATH}` },
  });
  check(sched.trim() === "07:30 1,2,3,4,5", "the chosen days reach launchd", sched.trim());
  check((await read("config/job-seeker.config.md")).includes("welcome_done:"), "setup is recorded as finished");
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
  for (const step of ["cv", "targets", "markets", "answers", "channels", "schedule"]) {
    const r = await get(`/setup-step?step=${step}&back=settings`);
    check(r.status === 200 && !r.body.includes('<div class="wsteps">'), `standalone step has no stepper: ${step}`);
  }
  const solo = await get("/setup-step?step=cv&back=settings");
  check(!/value="skip"/.test(solo.body) && !/value="leave"/.test(solo.body), "standalone has no Skip or Leave — there is no flow to leave");

  // saving from standalone returns you where you came from, and never claims setup finished
  let solor = await post("/welcome-step", { step: "targets", action: "next", return: "standalone", back: "settings", roles: "Architect", locations: "Dubai", seniority: "Senior" });
  check(solor.location.includes("/settings"), "saving a standalone step returns you where you came from");
  solor = await post("/welcome-step", { step: "schedule", action: "next", return: "standalone", back: "settings", mode: "manual" });
  check(solor.location.includes("/settings") && !solor.location.includes("welcome=done"), "a standalone schedule save does not claim setup is finished");

  // `back` is an allow-list, not a URL anyone can aim
  solor = await post("/welcome-step", { step: "targets", action: "next", return: "standalone", back: "https://evil.example", roles: "Architect" });
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
  await new Promise((r) => setTimeout(r, 2500));
  const changed = await get("/setup-step?step=cv&back=settings");
  check(changed.body.includes("What changed") && changed.body.includes("Pre-sales Engineer"),
    "a re-read shows the old values beside the new ones");
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
  if (sandbox) await fs.rm(sandbox, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
