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
import { execFile, spawn } from "node:child_process";
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

  // A release body is Markdown and the dialog renders text, so the markers have to go — and they
  // matter twice, because groupBullets reads the first word to sort New from Changed from Fixed.
  const md = parseBullets(
    "- **Report a problem** is now a bug icon\n- Added `npm run logs` and a [link](https://x.test)\n- Fixed: your *username* leaked\n"
  );
  check(md[0] === "Report a problem is now a bug icon", "bold markers are stripped", md[0]);
  check(md[1] === "Added npm run logs and a link", "code spans and links are flattened", md[1]);
  check(md[2] === "Fixed: your username leaked", "italics are stripped", md[2]);
  const g = groupBullets(md);
  check(g.new.length === 1 && g.fixed.length === 1 && g.changed.length === 1,
    "a bullet opening with emphasis is grouped on its words, not its asterisks",
    JSON.stringify(g));
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

// ---------------------------------------------------------------- stopping the dashboard
//
// The updater cannot replace the code while the old code is still answering, so scripts/stop.sh is
// load-bearing: an update whose stop step misses the server fails with "the dashboard is still
// answering on port 4319 — nothing was changed", which is what users saw. The two cases that
// matter pull opposite ways, so both are checked here.
if (process.platform !== "win32") {
  console.log("\nstopping the dashboard\n");
  const st = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-stop-"));
  const repo = path.join(st, "repo");
  const alive = (procId) => {
    try {
      process.kill(procId, 0);
      return true;
    } catch {
      return false;
    }
  };
  const settle = async (procId, want) => {
    for (let i = 0; i < 40; i++) {
      if (alive(procId) === want) return want;
      await new Promise((r) => setTimeout(r, 100));
    }
    return alive(procId);
  };
  try {
    await fs.mkdir(path.join(repo, "server"), { recursive: true });
    await fs.mkdir(path.join(repo, "data/.setup"), { recursive: true });
    await fs.copyFile(path.join(ROOT, "scripts/stop.sh"), path.join(st, "stop.sh"));
    // A stand-in dashboard: what matters is only that it is a node running THIS path.
    await fs.writeFile(path.join(repo, "server/dashboard.mjs"), "setInterval(() => {}, 1000);\n");
    const stop = () => run("bash", [path.join(st, "stop.sh")], { env: { ...process.env, JOBSEEKER_REPO: repo } });

    const none = await stop();
    check(none.code === 0 && /was not running/.test(none.out), "with nothing running, stop says so", none.out.trim());

    // The case that broke the update: a server nothing recorded. Started by hand, by
    // `npm run dashboard`, or by an app instance that has since gone — no pid file, no watchdog.
    const ghost = spawn(process.execPath, [path.join(repo, "server/dashboard.mjs")], {
      detached: true,
      stdio: "ignore",
    });
    ghost.unref();
    await new Promise((r) => setTimeout(r, 300));
    const swept = await stop();
    check(!(await settle(ghost.pid, false)), "a dashboard no pid file names is found and stopped");
    check(swept.code === 0 && /Stopped JobSeeker/.test(swept.out), "…and it says which pid", swept.out.trim());
    if (alive(ghost.pid)) process.kill(ghost.pid, "SIGKILL");

    // The same install under its OTHER true name. On a Mac os.tmpdir() is /var/folders/…, which is
    // really /private/var/folders/… — so a dashboard started with one spelling has to be recognised
    // by a stop asked about the other, or it survives an update that then swaps the code out from
    // under it.
    const realRepo = await fs.realpath(repo);
    if (realRepo !== repo) {
      const twin = spawn(process.execPath, [path.join(realRepo, "server/dashboard.mjs")], {
        detached: true,
        stdio: "ignore",
      });
      twin.unref();
      await new Promise((r) => setTimeout(r, 300));
      await stop();
      check(!(await settle(twin.pid, false)), "the same install under a symlinked path is still ours");
      if (alive(twin.pid)) process.kill(twin.pid, "SIGKILL");
    }

    // The opposite failure: a pid file that outlived its process, its number handed to a stranger.
    // Killing that stranger would be far worse than failing to stop anything.
    const bystander = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    bystander.unref();
    await fs.writeFile(path.join(repo, "data/.setup/server.pid"), String(bystander.pid));
    const reused = await stop();
    check(alive(bystander.pid), "a reused pid is left alone", reused.out.trim());
    check(reused.code === 0 && /belongs to something else/.test(reused.out), "…and stop says why", reused.out.trim());
    check(
      !(await fs.access(path.join(repo, "data/.setup/server.pid")).then(() => true).catch(() => false)),
      "…and the stale pid file is cleared"
    );
    process.kill(bystander.pid, "SIGKILL");
  } finally {
    await fs.rm(st, { recursive: true, force: true }).catch(() => {});
  }
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
  for (const f of ["scripts/self-update.sh", "scripts/stop.sh", "server/update.mjs"]) {
    await fs.copyFile(path.join(ROOT, f), path.join(inst, f));
  }
  await fs.chmod(path.join(inst, "scripts/self-update.sh"), 0o755);
  await fs.chmod(path.join(inst, "scripts/stop.sh"), 0o755);

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

// ---------------------------------------------------------------- what "Not now" means
//
// The behaviour the whole dialog turns on, and the one that cannot be checked by reading the code:
// saying Not now must ANSWER the question, and a new release must ask it again.
//
// It is tested through a real dashboard because the failure mode is a disagreement between two
// files -- the key the dialog writes and the allowlist that accepts it. Get those out of step and
// the POST is rejected, the dismissal never lands, and the dialog returns on every single launch
// with nothing in any log to say why.
{
  const home = path.join(tmp, "dlg");
  const dataDir = path.join(home, "data");
  await fs.mkdir(dataDir, { recursive: true });

  // What the background check would have written, for a version that will never exist.
  const offer = async (version) =>
    fs.writeFile(
      path.join(dataDir, ".update-check.json"),
      JSON.stringify({
        version,
        tag: `v${version}`,
        date: "2099-01-01",
        url: "https://example.invalid/r",
        bullets: ["Added a thing.", "Fixed another thing."],
        checkedAt: new Date().toISOString(),
      })
    );
  await offer("99.0.0");

  // Enough of a job search to be past the first-run wizard: an empty data/ redirects to /welcome,
  // and the dialog is a dashboard dialog.
  await fs.writeFile(
    path.join(dataDir, "criteria.md"),
    "---\nmarkets: Cybersecurity\nroles: Product Management\n---\n"
  );

  const port = 4607;
  const child = spawn("node", [path.join(ROOT, "server", "dashboard.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      JOBSEEKER_DATA_DIR: dataDir,
      // The background check fires four seconds after boot. Pointed at the real repository it would
      // overwrite the offer this test just seeded, and the test would pass or fail on how fast the
      // machine is. A slug that cannot exist makes the check a no-op: a failed check keeps the last
      // good answer, which is exactly the one under test.
      JOBSEEKER_REPO_SLUG: "cventour/jobseeker-no-such-repo-for-tests",
    },
    stdio: "ignore",
  });
  try {
    // Wait for it to answer rather than guessing at a delay.
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      up = await fetch(`http://127.0.0.1:${port}/_whoami`).then((r) => r.ok).catch(() => false);
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    check(up, "a dashboard came up for the dialog tests");

    // The signal the client reads to decide whether to open the dialog.
    const signal = async (p = "/") => {
      const html = await fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.text());
      const m = /window\.__UPDATE__=(\{.*?\});/.exec(html);
      return m ? JSON.parse(m[1]) : null;
    };
    const dismiss = (key, summary) =>
      fetch(`http://127.0.0.1:${port}/dismiss-notice`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `key=${encodeURIComponent(key)}&summary=${encodeURIComponent(summary)}`,
        redirect: "manual",
      }).then((r) => r.status);

    const first = await signal();
    check(first?.version === "99.0.0" && first.dismissed === false, "a new version is offered", JSON.stringify(first));

    const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    check(/name="key" value="update:99\.0\.0"/.test(html), "the dialog writes the version's own key");
    check(/>Not now</.test(html) && !/>Later</.test(html), "the button says Not now");

    const status = await dismiss("update:99.0.0", "JobSeeker 99.0.0 is available");
    check(status >= 300 && status < 400, "the dismissal is accepted, not rejected as an unknown key", `status ${status}`);

    const after = await signal();
    check(after?.dismissed === true, "…and the offer is not put in front of the user again", JSON.stringify(after));

    // The point of keying it to the version: the next release is a different question.
    await offer("99.1.0");
    const next = await signal();
    check(next?.version === "99.1.0" && next.dismissed === false, "a NEWER release asks again by itself", JSON.stringify(next));

    // And the standing offer is still reachable, both by asking and from Settings.
    await dismiss("update:99.1.0", "JobSeeker 99.1.0 is available");
    const forced = await signal("/settings?upd=1");
    check(forced?.forced === true && forced.dismissed === true,
      "Check for updates opens the dialog anyway", JSON.stringify(forced));
    const settings = await fetch(`http://127.0.0.1:${port}/settings`).then((r) => r.text());
    check(/99\.1\.0 available/.test(settings), "…and Settings still carries the offer");

    // A dismissed offer must not reload the page under someone to show a dialog that declines to open.
    const rs = await fetch(`http://127.0.0.1:${port}/run-state`).then((r) => r.json());
    check(rs.update === "", "/run-state stops advertising an answered offer", JSON.stringify(rs.update));
  } finally {
    child.kill("SIGKILL");
  }
}
} finally {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(bad ? `\nFAIL — ${ok} ok, ${bad} failed\n` : `\nPASS — ${ok} ok, 0 failed\n`);
process.exit(bad ? 1 : 0);
