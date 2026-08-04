// Cross-process advisory lock for data/ mutations.
//
// Why this exists: several writers touch data/ at the same time —
//   * /track and /job-run fan out inbox-tracker + chat-tracker in parallel,
//   * /curate and /job-run fan out one role-scout per market,
//   * the dashboard (server/dashboard.mjs) writes whenever you click a button.
// Each record.mjs command is a read-modify-write (read the table or the record dir, decide,
// write the whole file back). Two of those interleaving silently LOSES one writer's change:
// both read the same 40-row communications.md, both append their row, the second write wins
// and the first row is gone. Measured before this lock existed: 2 of 24 concurrent rows
// survived. Nothing errors — rows just vanish. See scripts/test-concurrency.mjs.
//
// The fix is a single mutex around every mutation. Commands are short (tens of ms), so
// contention is cheap, and one global lock keeps cross-file operations (upsert a record AND
// append to activity.md) atomic as a unit — which per-file locks would not.
//
// Mechanism: writeFile with flag "wx" creates-or-fails atomically, so the lock file's existence
// IS the mutex and its contents identify the holder in the same single step. (An earlier version
// used mkdir + a separate owner file; the gap between those two operations, combined with
// treating "lock absent" as "lock stale, delete it", let two processes enter at once — one
// acquired legitimately while another was still acting on a stale observation and deleted the
// fresh lock. Hence: absence is never a reason to delete anything.)

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const LOCK_FILE = path.join(DATA, ".lock");

// A holder that dies without releasing would block every later run forever, so a lock older
// than this is assumed dead and broken. Must comfortably exceed the slowest real command.
const STALE_MS = 60_000;
// Give up rather than hang a scheduled run behind a pathological holder.
const TIMEOUT_MS = 30_000;
const POLL_MS = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mintToken() {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

// Current holder + how long it has held, in ONE stat+read. Returns null when the lock is simply
// absent — which means "free", never "stale".
async function inspect(LOCK_FILE) {
  try {
    const [st, token] = await Promise.all([fs.stat(LOCK_FILE), fs.readFile(LOCK_FILE, "utf8")]);
    return { token, ageMs: Date.now() - st.mtimeMs };
  } catch {
    return null;
  }
}

async function acquire(LOCK_FILE, { staleMs, timeoutMs, label }) {
  const token = mintToken();
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(path.dirname(LOCK_FILE), { recursive: true });

  for (;;) {
    try {
      // Atomic create-exclusive: succeeds for exactly one process, and publishes the holder's
      // identity in the same operation.
      await fs.writeFile(LOCK_FILE, token, { flag: "wx" });
      return token;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }

    const held = await inspect(LOCK_FILE);
    // Absent → it was just released. Retry immediately; do NOT delete anything, or we would
    // destroy the lock of whoever acquired it in the meantime.
    if (held === null) continue;

    if (held.ageMs > staleMs) {
      // Presumed-dead holder. Re-verify immediately before acting so we cannot break a lock that
      // someone acquired since we looked: the token must be unchanged AND still old. A fresh
      // holder's lock has age ~0, so it can never satisfy this.
      const recheck = await inspect(LOCK_FILE);
      if (recheck && recheck.token === held.token && recheck.ageMs > staleMs) {
        // Rename-then-remove: rename is atomic, so if two processes both try to break the same
        // stale lock, only one wins and the loser's rename fails harmlessly.
        const dead = `${LOCK_FILE}.dead.${process.pid}`;
        try {
          await fs.rename(LOCK_FILE, dead);
          await fs.rm(dead, { force: true });
        } catch {
          /* another process broke it first */
        }
      }
      continue;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs / 1000}s waiting for the ${label} lock (held by ${held.token}). ` +
          `If nothing is running, remove ${LOCK_FILE}.`
      );
    }
    await sleep(POLL_MS + Math.random() * POLL_MS); // jitter so waiters don't sync up
  }
}

async function release(LOCK_FILE, token) {
  // Only release if we still hold it. If our lock was declared stale and broken, another process
  // may own it now — deleting that one would corrupt ITS critical section.
  const held = await inspect(LOCK_FILE);
  if (!held || held.token !== token) return;
  await fs.rm(LOCK_FILE, { force: true });
}

// Build a mutex over an arbitrary lock file. The browser needs one too — only one process may
// drive Chrome at a time (AGENT-RULES §13) — and it must be a SEPARATE lock from data/, or a slow
// browser sweep would block every unrelated record.mjs write for its whole duration.
export function createLock(lockFile, { staleMs = STALE_MS, timeoutMs = TIMEOUT_MS, label = lockFile } = {}) {
  return async function withThisLock(fn) {
    const token = await acquire(lockFile, { staleMs, timeoutMs, label });
    try {
      return await fn();
    } finally {
      await release(lockFile, token);
    }
  };
}

// Run `fn` holding the data/ lock. Always releases, including on throw.
export const withLock = createLock(LOCK_FILE, { label: "data/" });

// Driving Chrome is slow (page loads, human-paced reading), so it gets a long stale window and a
// long wait — the defaults tuned for tens-of-milliseconds record.mjs commands would break it.
export const BROWSER_LOCK_PATH = path.join(DATA, ".browser.lock");
export const withBrowserLock = createLock(BROWSER_LOCK_PATH, {
  staleMs: 15 * 60_000,
  timeoutMs: 10 * 60_000,
  label: "browser",
});

export const LOCK_PATH = LOCK_FILE;
