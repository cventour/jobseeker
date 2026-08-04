#!/usr/bin/env node
// Regression test for the data/ write lock (server/lock.mjs).
//
// The bug this guards against: every record.mjs command is a read-modify-write over a shared file.
// Before the lock, running the trackers or scouts in parallel silently LOST writes — measured at
// 2 of 24 rows surviving. Nothing errored; rows just vanished. That is invisible in normal use and
// catastrophic for a tracker, so it gets a test.
//
// Runs against a throwaway copy of server/ + an empty data/ — never touches real state.
//
//   npm run test:concurrency

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const WRITERS = 24;
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-conc-"));
  await fs.mkdir(path.join(tmp, "server"), { recursive: true });
  await fs.mkdir(path.join(tmp, "data"), { recursive: true });
  // Copy EVERY server module, not a hand-listed subset: the list silently rots the moment
  // record.mjs gains an import (adding server/match.mjs broke this test with ERR_MODULE_NOT_FOUND,
  // and the failure looked like a lock bug rather than a missing file).
  for (const f of await fs.readdir(path.join(REPO, "server"))) {
    if (!f.endsWith(".mjs")) continue;
    await fs.copyFile(path.join(REPO, "server", f), path.join(tmp, "server", f));
  }
  await fs.writeFile(
    path.join(tmp, "data", "tasks.md"),
    "# Tasks\n\n| id | due_date | type | who | related_id | status | detail |\n|----|----------|------|-----|------------|--------|--------|\n"
  );
  await fs.writeFile(
    path.join(tmp, "data", "activity.md"),
    "# Activity\n\n| timestamp | type | detail |\n|-----------|------|--------|\n"
  );

  const rec = (...args) => run("node", [path.join(tmp, "server", "record.mjs"), ...args], { cwd: tmp });

  console.log(`\nconcurrency: ${WRITERS} simultaneous writers\n`);

  // 1. Concurrent table appends must all survive.
  await Promise.all(
    Array.from({ length: WRITERS }, (_, i) =>
      rec("add-task", JSON.stringify({ type: "followup", who: `p${i}`, detail: `row ${i}` }))
    )
  );
  const tasks = await fs.readFile(path.join(tmp, "data", "tasks.md"), "utf8");
  const found = new Set([...tasks.matchAll(/row (\d+)\b/g)].map((m) => m[1]));
  check("all concurrent add-task rows survive", found.size === WRITERS, `${found.size}/${WRITERS} rows`);

  // 2. activity.md is a second shared table, and it is prepended to ("top") rather than appended —
  //    a different splice path, so it gets its own concurrent test.
  await Promise.all(
    Array.from({ length: WRITERS }, (_, i) => rec("log", "test", `entry ${i}`))
  );
  const activity = await fs.readFile(path.join(tmp, "data", "activity.md"), "utf8");
  const logged = new Set([...activity.matchAll(/entry (\d+)\b/g)].map((m) => m[1]));
  check("all concurrent log entries survive", logged.size === WRITERS, `${logged.size}/${WRITERS} rows`);

  // 3. The table must remain parseable — atomic writes mean no truncated/interleaved file.
  const headerOk = /\| id \| due_date \| type \| who \| related_id \| status \| detail \|/.test(tasks);
  const ragged = tasks
    .split("\n")
    .filter((l) => /^\s*\|/.test(l) && !/^\s*\|[-\s|:]+\|\s*$/.test(l))
    .filter((l) => l.split("|").length !== 9);
  check("tasks table stays well-formed", headerOk && ragged.length === 0, `${ragged.length} ragged rows`);

  // 4. Concurrent upserts of the SAME company+role must dedupe to one record. Without the lock
  //    both readers miss the existing file and each create one.
  await Promise.all(
    Array.from({ length: 8 }, () =>
      rec("upsert-application", JSON.stringify({ company: "Acme", role: "Solution Architect", status: "Saved" }))
    )
  );
  const apps = await fs.readdir(path.join(tmp, "data", "applications"));
  check("concurrent identical upserts create ONE record", apps.length === 1, `${apps.length} files`);

  // 5. No temp files left behind by the atomic-write path.
  const strays = (await fs.readdir(path.join(tmp, "data"))).filter((f) => f.endsWith(".tmp"));
  check("no .tmp files left behind", strays.length === 0, strays.join(", "));

  // 6. The lock is always released.
  const lockFile = path.join(tmp, "data", ".lock");
  let lockLeft = true;
  try {
    await fs.access(lockFile);
  } catch {
    lockLeft = false;
  }
  check("lock released after every command", !lockLeft);

  // 7. A crashed holder must not wedge the system forever: a lock older than the stale threshold
  //    gets broken and the command proceeds.
  await fs.writeFile(lockFile, "999999:0:deadproc");
  const old = new Date(Date.now() - 10 * 60_000);
  await fs.utimes(lockFile, old, old);
  const t0 = Date.now();
  await rec("add-task", JSON.stringify({ type: "followup", who: "after-crash", detail: "stale recovery" }));
  const recovered = (await fs.readFile(path.join(tmp, "data", "tasks.md"), "utf8")).includes("stale recovery");
  check("stale lock is broken and the write proceeds", recovered, `${Date.now() - t0}ms`);

  // 8. The inverse, and the bug this lock was rewritten to fix: a waiter must NEVER destroy a
  //    lock that is alive. Previously a process that observed "lock absent" concluded "stale" and
  //    deleted whatever it found later — clobbering a lock another process had just acquired, so
  //    two writers ran at once.
  await fs.writeFile(lockFile, "111111:0:liveholder"); // fresh mtime = a healthy holder
  const blocked = rec("add-task", JSON.stringify({ type: "followup", who: "barge", detail: "should not appear yet" }));
  blocked.catch(() => {}); // it will be killed below; don't surface the rejection
  await new Promise((r) => setTimeout(r, 2000));
  const stillForeign = (await fs.readFile(lockFile, "utf8")) === "111111:0:liveholder";
  const tasksNow = await fs.readFile(path.join(tmp, "data", "tasks.md"), "utf8");
  check("a live foreign lock is respected, not stolen", stillForeign && !tasksNow.includes("should not appear yet"));
  await fs.rm(lockFile, { force: true });
  await blocked.catch(() => {}); // let the waiter finish now that the lock is free

  await fs.rm(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-concurrency error:", e?.message || e);
  process.exit(1);
});
