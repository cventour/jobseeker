// Is there a newer JobSeeker, and what is in it?
//
// This module only ever ANSWERS that question. It never downloads code and never replaces anything
// -- scripts/self-update.sh and its Windows twin do that, detached, after the user has said yes.
//
// Where "latest" comes from, and why: GitHub Releases. An install pulls a tarball of a TAG, so the
// user only ever lands on a version someone decided to release. Checking `main` instead would have
// been less work and would have offered people whatever was half-finished on the branch that
// morning.
//
// The check is background-only. It runs on server start and every few hours, writes its answer to
// data/.update-check.json, and the page reads that file. Nothing in a page request ever waits on
// api.github.com -- an offline laptop or a slow GitHub must never be able to delay the dashboard.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const CHECK_FILE = path.join(DATA, ".update-check.json");

const REPO = process.env.JOBSEEKER_REPO_SLUG || "cventour/jobseeker";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

// Six hours. A release is a rare event and this is a courtesy, not a heartbeat: checking more often
// spends someone's battery and GitHub's rate limit to learn nothing.
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------- versions

/**
 * Compare two dotted versions numerically. Returns >0 when a is newer.
 *
 * String comparison gets this wrong at exactly the moment it matters: "0.10.0" < "0.9.0" is true
 * as text and false as a version, and 0.10.0 is the release nobody would have been offered.
 */
export function compareVersions(a, b) {
  const parts = (v) =>
    String(v || "")
      .trim()
      .replace(/^v/, "")
      .split(/[.\-+]/)
      .map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
  const A = parts(a);
  const B = parts(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** A tag we are willing to act on. Anything else is ignored rather than guessed at. */
export const TAG_OK = /^v\d+\.\d+\.\d+$/;

export async function localVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
    return String(pkg.version || "").trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------- release notes

/**
 * Sort a release's bullets into New / Changed / Fixed by the verb they open with.
 *
 * CHANGELOG.md is deliberately one flat list of plain-language bullets -- categories are a
 * developer's way of filing work, and the changelog is written for the person using the thing. So
 * the grouping is inferred here rather than stored, which means the FIRST WORD of a bullet decides
 * where it lands. That is a convention CONTRIBUTING.md documents; a line that starts some other way
 * falls to Changed, which is the honest default for "something is different".
 */
export function groupBullets(bullets) {
  const out = { new: [], changed: [], fixed: [] };
  for (const raw of bullets || []) {
    const b = String(raw || "").trim();
    if (!b) continue;
    if (/^(added|new\b|you can now|jobseeker now (?:checks|offers))/i.test(b)) out.new.push(b);
    else if (/^(fixed|stopped|no longer|corrected)/i.test(b)) out.fixed.push(b);
    else out.changed.push(b);
  }
  return out;
}

/**
 * Pull bullets out of a release body.
 *
 * Same shape scripts/release-notes.mjs writes, because that is what generates the body: "- " lines,
 * with a wrapped continuation joined back onto the line it belongs to. Anything that is not a
 * bullet (the install instructions the generator appends) is dropped.
 */
export function parseBullets(body) {
  const items = [];
  let inList = false;
  for (const line of String(body || "").split("\n")) {
    const t = line.trim();
    if (t.startsWith("- ")) {
      items.push(t.slice(2).trim());
      inList = true;
    } else if (!t) {
      // A blank line ENDS the list. release-notes.mjs appends install instructions after one, and
      // without this they arrived as bullets: a "what's new" modal offering the user a curl command
      // as a feature.
      inList = false;
    } else if (inList) {
      // A wrapped bullet, joined back onto the line it belongs to.
      items[items.length - 1] += " " + t;
    }
  }
  return items.filter(Boolean);
}

// ---------------------------------------------------------------------------- the check

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(CHECK_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * What the page should show. Reads the cache only -- never the network.
 *
 * `available` is the single question the UI asks, and it is answered here rather than in the
 * renderer so the dashboard and the Settings row can never disagree about it.
 */
export async function updateState() {
  const [mine, cached] = await Promise.all([localVersion(), readCache()]);
  const theirs = cached?.version || "";
  const available = Boolean(mine && theirs && compareVersions(theirs, mine) > 0);
  return {
    current: mine,
    latest: theirs,
    tag: cached?.tag || "",
    date: cached?.date || "",
    url: cached?.url || "",
    checkedAt: cached?.checkedAt || "",
    groups: available ? groupBullets(cached?.bullets || []) : { new: [], changed: [], fixed: [] },
    available,
  };
}

/**
 * Ask GitHub. Writes the answer to the cache and returns it.
 *
 * Unauthenticated: the repository is public, and 60 requests an hour per address is far more than a
 * six-hourly check needs. A failure is not an error anyone needs to see -- it is recorded in the
 * cache so the Settings row can say when it last managed to look, and otherwise ignored.
 */
export async function checkNow({ timeoutMs = 8000 } = {}) {
  const started = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const prev = (await readCache()) || {};
  const write = async (patch) => {
    const next = { ...prev, ...patch, checkedAt: started };
    await fs.mkdir(DATA, { recursive: true }).catch(() => {});
    await fs.writeFile(CHECK_FILE, JSON.stringify(next, null, 2)).catch(() => {});
    return next;
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(LATEST_URL, {
      signal: ac.signal,
      headers: { accept: "application/vnd.github+json", "user-agent": "jobseeker-update-check" },
    });
    // 404 is the ordinary answer before the first release is ever cut, not a fault.
    if (!res.ok) return await write({ error: `github said ${res.status}` });

    const rel = await res.json();
    const tag = String(rel?.tag_name || "").trim();
    // The tag reaches a URL and a file path in the updater, so it is validated the moment it
    // arrives rather than anywhere later.
    if (!TAG_OK.test(tag)) return await write({ error: `ignoring tag ${JSON.stringify(tag).slice(0, 40)}` });

    return await write({
      version: tag.replace(/^v/, ""),
      tag,
      date: String(rel?.published_at || "").slice(0, 10),
      url: String(rel?.html_url || ""),
      bullets: parseBullets(rel?.body),
      error: "",
    });
  } catch (e) {
    return await write({ error: e?.name === "AbortError" ? "the check timed out" : String(e?.message || e) });
  } finally {
    clearTimeout(timer);
  }
}

/** Kick off a check now and every CHECK_EVERY_MS, without ever blocking the caller. */
export function startChecking() {
  const run = () => {
    checkNow().catch(() => {});
  };
  // A few seconds after boot: starting the dashboard should not wait on a network round trip, and
  // the page that opens immediately reads the previous answer meanwhile.
  setTimeout(run, 4000).unref?.();
  setInterval(run, CHECK_EVERY_MS).unref?.();
}
