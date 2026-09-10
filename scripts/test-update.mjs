// The update check, and the updater's guarantees.
//
// Two halves. The first is pure: version comparison, bullet parsing and grouping — the logic that
// decides whether anyone is offered anything, and what they read when they are.
//
// The second runs the REAL updater against a scratch install and a local archive, because the whole
// feature rests on one promise: it replaces the code and leaves the job search alone. That promise
// is only worth making if something checks it every time.
//
//   node scripts/test-update.mjs

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  groupBullets,
  parseBullets,
  TAG_OK,
} from "../server/update.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let ok = 0;
let bad = 0;
const check = (cond, what, detail = "") => {
  if (cond) {
    ok++;
    console.log(`  ok    ${what}`);
  } else {
    bad++;
    console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
  }
};
const run = (cmd, args, opts = {}) =>
  new Promise((resolve) =>
    execFile(cmd, args, { ...opts }, (e, out, err) => resolve({ code: e?.code ?? 0, out: String(out || ""), err: String(err || "") }))
  );

console.log("\nupdate check\n");

// ---------------------------------------------------------------- versions
check(compareVersions("0.10.0", "0.9.0") > 0, "0.10.0 is newer than 0.9.0, not older");
check(compareVersions("0.6.0", "0.7.0") < 0, "0.6.0 is older than 0.7.0");
check(compareVersions("1.0.0", "1.0.0") === 0, "the same version is neither");
check(compareVersions("v0.7.0", "0.7.0") === 0, "a leading v is ignored");
check(TAG_OK.test("v0.7.0") && !TAG_OK.test("main") && !TAG_OK.test("v0.7"), "only a full vX.Y.Z tag is acted on");
check(!TAG_OK.test("v0.7.0/../../etc"), "a tag carrying a path is refused");

// ---------------------------------------------------------------- release notes
{
  // The shape scripts/release-notes.mjs actually emits: bullets, a blank line, then install
  // instructions. Those instructions must never reach the modal as features.
  const body = [
    "- Added a check for new versions.",
    "- Fixed refreshing so it keeps your tab.",
    "",
    "---",
    "",
    "**Windows** — paste this into PowerShell:",
    "irm https://myjobseeker.ai/install.ps1 | iex",
  ].join("\n");
  const b = parseBullets(body);
  check(b.length === 2, "the install footer is not a bullet", `got ${b.length}`);
  check(!b.join(" ").includes("install.ps1"), "…and no install command reaches the list");

  const wrapped = parseBullets("- one bullet that\n  wraps onto a second line\n- another");
  check(wrapped.length === 2 && wrapped[0].endsWith("second line"), "a wrapped bullet is joined back together");
}

{
  const g = groupBullets([
    "Added a one-line install for Windows.",
    "Fixed a crash when the CV was missing.",
    "No longer opens popups off the edge.",
    "Settings splits into tabs.",
  ]);
  check(g.new.length === 1, "Added… is New");
  check(g.fixed.length === 2, "Fixed… and No longer… are Fixed");
  check(g.changed.length === 1, "anything else is Changed");
}

// ---------------------------------------------------------------- the updater itself
console.log("\nthe updater\n");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-update-"));
const inst = path.join(tmp, "inst");
const rel = path.join(tmp, "rel", "jobseeker-0.99.0");
const env = { ...process.env, JOBSEEKER_NO_LAUNCH: "1" };

try {
  // A scratch "install": the tracked tree, no .git, plus files that belong to the user.
  await fs.mkdir(inst, { recursive: true });
  const tar = await run("bash", ["-c", `git archive --format=tar HEAD | tar x -C '${inst}'`], { cwd: ROOT });
  if (tar.code !== 0) throw new Error("could not build the scratch install");
  // Untracked-but-required: the updater is new, so git archive has not got it yet.
  for (const f of ["scripts/self-update.sh", "server/update.mjs"]) {
    await fs.copyFile(path.join(ROOT, f), path.join(inst, f));
  }
  await fs.chmod(path.join(inst, "scripts/self-update.sh"), 0o755);

  await fs.mkdir(path.join(inst, "templates/cv"), { recursive: true });
  await fs.mkdir(path.join(inst, "data/.setup"), { recursive: true });
  await fs.writeFile(path.join(inst, "templates/cv/mine.pdf"), "MY CV");
  await fs.writeFile(path.join(inst, "data/criteria.md"), "---\nmarkets: Cybersecurity\n---\n");
  await fs.writeFile(path.join(inst, "config/job-seeker.config.md"), "---\ndashboard_port: 4319\n---\n");
  await fs.writeFile(path.join(inst, ".claude/settings.local.json"), '{"local":"settings"}');
  await fs.writeFile(path.join(inst, "gone-upstream.txt"), "only in the old tree");

  // A release: the same tree at a higher version, with one example added and one file removed.
  await fs.mkdir(rel, { recursive: true });
  await run("bash", ["-c", `cp -R '${inst}/.' '${rel}/'`]);
  await fs.rm(path.join(rel, "gone-upstream.txt"), { force: true });
  await fs.rm(path.join(rel, "templates/cv"), { recursive: true, force: true });
  await fs.rm(path.join(rel, "data/criteria.md"), { force: true });
  await fs.rm(path.join(rel, ".claude/settings.local.json"), { force: true });
  await fs.rm(path.join(rel, "SECURITY.md"), { force: true });
  await fs.writeFile(path.join(rel, "data/.example/NEW-SAMPLE.md"), "# shipped in 0.99.0\n");
  const pkg = JSON.parse(await fs.readFile(path.join(rel, "package.json"), "utf8"));
  pkg.version = "0.99.0";
  await fs.writeFile(path.join(rel, "package.json"), JSON.stringify(pkg, null, 2));
  const archive = path.join(tmp, "rel", "src.tar.gz");
  await run("tar", ["czf", archive, "-C", path.join(tmp, "rel"), "jobseeker-0.99.0"]);

  const url = `file://${archive}`;
  const before = {
    cv: await fs.readFile(path.join(inst, "templates/cv/mine.pdf"), "utf8"),
    criteria: await fs.readFile(path.join(inst, "data/criteria.md"), "utf8"),
    config: await fs.readFile(path.join(inst, "config/job-seeker.config.md"), "utf8"),
    claude: await fs.readFile(path.join(inst, ".claude/settings.local.json"), "utf8"),
  };

  // --- a dry run changes nothing ---
  const dry = await run("bash", [path.join(inst, "scripts/self-update.sh"), "v0.99.0", "--check"], {
    cwd: inst,
    env: { ...env, JOBSEEKER_URL: url },
  });
  check(dry.code === 0, "--check succeeds", dry.err.slice(0, 120));
  const stillOld = JSON.parse(await fs.readFile(path.join(inst, "package.json"), "utf8")).version;
  check(stillOld !== "0.99.0", "…and replaces nothing", `version is ${stillOld}`);

  // --- the real thing ---
  const up = await run("bash", [path.join(inst, "scripts/self-update.sh"), "v0.99.0"], {
    cwd: inst,
    env: { ...env, JOBSEEKER_URL: url },
  });
  check(up.code === 0, "the update succeeds", up.err.slice(0, 200));

  const now = JSON.parse(await fs.readFile(path.join(inst, "package.json"), "utf8")).version;
  check(now === "0.99.0", "the code is the new version", `version is ${now}`);

  const same = async (rel_, was) => (await fs.readFile(path.join(inst, rel_), "utf8")) === was;
  check(await same("templates/cv/mine.pdf", before.cv), "the CV is untouched");
  check(await same("data/criteria.md", before.criteria), "criteria.md is untouched");
  check(await same("config/job-seeker.config.md", before.config), "the config is untouched");
  check(await same(".claude/settings.local.json", before.claude), "local Claude settings are untouched");

  const exists = (p) =>
    fs
      .access(path.join(inst, p))
      .then(() => true)
      .catch(() => false);
  check(await exists(".claude/AGENT-RULES.md"), "…while the agent playbooks beside them are replaced");
  check(await exists("data/.example/NEW-SAMPLE.md"), "a new sample inside data/ is refreshed");
  check(!(await exists("SECURITY.md")), "a file deleted upstream really goes");
  check(!(await exists("gone-upstream.txt")), "…and so does one the archive never had");
  check(await exists("server/dashboard.mjs"), "the dashboard survived the swap");

  const st = JSON.parse(await fs.readFile(path.join(inst, "data/.setup/update.json"), "utf8"));
  check(st.phase === "done" && st.ok === true, "the run reports itself finished", st.phase);

  // --- a developer's checkout is refused ---
  await fs.mkdir(path.join(inst, ".git"), { recursive: true });
  const refused = await run("bash", [path.join(inst, "scripts/self-update.sh"), "v0.99.0"], {
    cwd: inst,
    env: { ...env, JOBSEEKER_URL: url },
  });
  check(refused.code === 2, "a git checkout is refused", `exit ${refused.code}`);
  const st2 = JSON.parse(await fs.readFile(path.join(inst, "data/.setup/update.json"), "utf8"));
  check(st2.phase === "refused" && /git pull/.test(st2.error || ""), "…and says to use git pull");
} finally {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(bad ? `\nFAIL — ${ok} ok, ${bad} failed\n` : `\nPASS — ${ok} ok, 0 failed\n`);
process.exit(bad ? 1 : 0);
