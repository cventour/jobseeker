// Bug reports, packaged for email.
//
// The dashboard has no telemetry and no outbound channel — by design. So "report a problem" cannot
// mean "send". It means: build one file the user can look at, and hand it to them. Everything here
// runs on the user's machine, writes exactly one file into their Downloads folder, and posts
// nothing anywhere.
//
// The screenshot is NOT an OS screen capture. The page renders its own DOM to a PNG in the browser
// and posts the bytes here (see FEEDBACK_JS in dashboard.mjs). That distinction is the whole reason
// JobSeeker still needs no Screen Recording permission on macOS: nothing outside the dashboard's
// own window is ever readable, not even in principle.
//
// What goes in:
//   feedback.txt   what the user wrote, plus version/OS/browser
//   app.log        the tail of every data/*.log, REDACTED (below)
//   screenshot.png only if they ticked the box and acknowledged what it can contain
//
// What never goes in: data/ tables, the CV, contacts, proposals, message text, any credential.

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import { redactPatterns } from "./redact.mjs";

const deflateRaw = promisify(zlib.deflateRaw);

// Every log the app writes. Named rather than globbed: a glob would sweep up whatever a future
// feature drops in data/, and this list is a promise about what leaves the machine.
export const LOG_FILES = [
  ".run-now.log",
  ".job-run.log",
  ".markets-run.log",
  ".approvals.log",
  ".bridge.log",
  ".spawn.log",
];

// Per log. Enough to see what a run did, small enough that nobody has to scroll for an hour.
const TAIL_LINES = 300;

/* ------------------------------------------------------------------ redaction */

// Two layers, and the order matters.
//
// 1. The SHAPES that are sensitive wherever they appear — an address, a phone number, a token, the
//    home directory. That layer is server/redact.mjs, already shared by `npm run logs` and its
//    Windows twin, and imported rather than reimplemented here: two answers to "what is safe to
//    send" is one too many, and the one that drifts is always the copy.
// 2. The NAMES that are only sensitive because they are this user's — their contacts, and the
//    companies they are chasing. No pattern can find "Aegis Networks" in a log line; a list built
//    from data/ can. This layer is new, and it is the one that actually protects a job search.
//
const GENERIC_WORDS = new Set(
  ("group holdings networks security systems solutions technologies technology software global " +
   "international limited digital services partners labs cyber data cloud consulting corporation " +
   "company ventures capital media health energy financial finance bank insurance retail " +
   // Second words that are also ordinary English. The distinctive half of the name is masked either
   // way, so dropping these costs no privacy and buys a log a person can still read.
   "trust protect shield guard point wave works edge core link gate prime next first vendor " +
   "example sample test demo")
    .split(" ")
);

// Table headers and record keys. They arrive looking exactly like a one-word value, and masking
// "name" or "status" would replace those words everywhere they legitimately appear in a log.
const COLUMN_WORDS = new Set(
  ("name date company role status notes type detail kind channel source market tier reason " +
   "timestamp title link stage venue owner action email phone")
    .split(" ")
);

/** Reject ids, timestamps, separator rules, and anything with no capital letter in it.
 *  A person or a company is a proper noun; everything a markdown table puts in the same position
 *  and is NOT sensitive — a column header, a record id, a date — is not. */
function looksLikeAName(t) {
  if (t.length < 4 || t.length > 80) return false;
  if (!/[A-Z]/.test(t)) return false;
  if (!/[A-Za-z]{3}/.test(t)) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return false; // a date or an ISO timestamp
  if (/^[a-z]+_[a-z0-9]+$/i.test(t)) return false; // app_ag02, comm_e1, contact_example
  if (/^-+$/.test(t)) return false; // a table rule
  if (COLUMN_WORDS.has(t.toLowerCase())) return false;
  return true;
}

/**
 * Strings that are only sensitive because they are THIS user's. Read from data/ and config/, never
 * guessed. Anything that does not look like a proper noun is dropped: masking "name" or "2026-08-01"
 * would shred the log into noise without protecting anything.
 */
export async function buildDictionary(dataDir, configFile) {
  const terms = new Set();
  const add = (s) => {
    const t = String(s || "").trim().replace(/^\[|\]$/g, "");
    if (!looksLikeAName(t)) return;
    terms.add(t);
    // "Aegis Networks" in the log is easy; "Aegis" on its own is the one that gets missed.
    if (t.includes(" ")) {
      for (const word of t.split(/\s+/)) {
        const w = word.replace(/[^\w&-]/g, "");
        if (w.length >= 4 && /[A-Z]/.test(w) && !GENERIC_WORDS.has(w.toLowerCase())) terms.add(w);
      }
    }
  };

  const readSafe = async (p) => {
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      return "";
    }
  };

  // Companies, from the markets tables.
  const marketsDir = path.join(dataDir, "markets");
  let marketFiles = [];
  try {
    marketFiles = (await fs.readdir(marketsDir)).filter((f) => f.endsWith(".md"));
  } catch {
    /* no markets yet */
  }
  for (const f of marketFiles) {
    for (const line of (await readSafe(path.join(marketsDir, f))).split("\n")) {
      const m = /^\|\s*([^|]+?)\s*\|/.exec(line); // first cell of each row is the company
      if (m) add(m[1]);
    }
  }

  // Companies and referrers from every application, lead and proposal. These matter most: a company
  // you are actively applying to is the one a run's log will be full of, and it reaches data/
  // through the records long before it reaches a market table.
  for (const sub of ["applications", "proposals"]) {
    let files = [];
    try {
      files = (await fs.readdir(path.join(dataDir, sub))).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      const text = await readSafe(path.join(dataDir, sub, f));
      for (const m of text.matchAll(/^\s*(?:company|referrer|contact|recruiter|employer)\s*:\s*(.+)$/gim)) {
        add(m[1].replace(/["']/g, ""));
      }
    }
  }

  // People, and whatever the tables put beside them.
  for (const file of ["contacts.md", "communications.md", "applications.md"]) {
    for (const line of (await readSafe(path.join(dataDir, file))).split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (cells.length < 3) continue;
      add(cells[1]);
      add(cells[2]);
    }
  }

  const cfg = await readSafe(configFile);
  for (const m of cfg.matchAll(/^\s*[-*]?\s*(?:name|full_name|company|employer)\s*:\s*(.+)$/gim)) {
    add(m[1].replace(/["']/g, ""));
  }
  // company_aliases folds alternate spellings into one entry; every spelling is a real company name.
  for (const m of cfg.matchAll(/^\s*[-*]\s*(.+?)\s*:\s*(.+)$/gm)) {
    add(m[1]);
    for (const alt of m[2].split(",")) add(alt);
  }

  return [...terms].sort((a, b) => b.length - a.length); // longest first, so "Aegis Networks" beats "Aegis"
}

const RX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** The shared shape rules first, then this user's own names. */
export function redact(text, dictionary = []) {
  let out = redactPatterns(String(text ?? ""), os.homedir());
  for (const term of dictionary) {
    out = out.replace(new RegExp(term.replace(RX_ESCAPE, "\\$&"), "gi"), "<redacted-name>");
  }
  return out;
}

/* ------------------------------------------------------------------ logs */

function tail(text, lines) {
  const all = text.split("\n");
  return all.length <= lines ? text : all.slice(-lines).join("\n");
}

/** Every log's tail, redacted, with a header per file. Missing logs are named, not skipped —
 *  "this log does not exist" is itself a useful fact in a bug report. */
export async function collectLogs(dataDir, dictionary) {
  const parts = [];
  for (const name of LOG_FILES) {
    const file = path.join(dataDir, name);
    let body;
    try {
      const raw = await fs.readFile(file, "utf8");
      body = raw.trim() ? tail(raw.trimEnd(), TAIL_LINES) : "(empty)";
    } catch {
      body = "(not present)";
    }
    parts.push(`===== ${name} — last ${TAIL_LINES} lines =====\n${redact(body, dictionary)}`);
  }
  return parts.join("\n\n") + "\n";
}

/* ------------------------------------------------------------------ zip */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// DOS date/time. Pre-1980 timestamps cannot be represented; the clock would have to be badly wrong.
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * A ZIP, written by hand.
 *
 * Shelling out to `zip` / `Compress-Archive` would mean a bash script and a PowerShell twin to keep
 * in step for something Node can already do: zlib gives us DEFLATE, and the container is a few
 * dozen bytes of header. One implementation, identical output on both platforms, nothing to install.
 *
 * @param {{name: string, data: Buffer, store?: boolean}[]} entries — `store` skips compression for
 *   data that is already compressed (a PNG), where DEFLATE only costs time.
 */
export async function makeZip(entries, when = new Date()) {
  const { time, date } = dosTime(when);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const compressed = entry.store ? raw : await deflateRaw(raw, { level: 9 });
    // Compression that made it bigger is compression not worth doing.
    const useStore = entry.store || compressed.length >= raw.length;
    const body = useStore ? raw : compressed;
    const method = useStore ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }

  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, dirBuf, end]);
}

/* ------------------------------------------------------------------ the bundle */

/** `jobseeker-feedback-2026-09-09-1742.zip` — sortable, and unmistakable in a Downloads folder. */
export function bundleName(when = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `jobseeker-feedback-${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}-${p(
    when.getHours()
  )}${p(when.getMinutes())}.zip`;
}

/**
 * Where the browser would have put it. `~/Downloads` exists on both platforms out of the box; if it
 * has been moved or deleted we fall back to the home directory rather than failing the report — the
 * point is to end up with a file the user can find, and the dialog tells them where it went.
 */
export async function downloadsDir() {
  const candidate = path.join(os.homedir(), "Downloads");
  try {
    const st = await fs.stat(candidate);
    if (st.isDirectory()) return candidate;
  } catch {
    /* no Downloads folder */
  }
  return os.homedir();
}

const MAX_PNG_BYTES = 12 * 1024 * 1024;

/**
 * Build the bundle and write it.
 *
 * @param {object} o
 * @param {string} o.message   what the user typed
 * @param {Buffer|null} o.png  the page's own render, or null if they declined
 * @param {object} o.meta      version, platform, user agent, which page they were on
 * @param {string} o.dataDir
 * @param {string} o.configFile
 */
export async function buildBundle({ message, png, meta, dataDir, configFile, when = new Date() }) {
  const dictionary = await buildDictionary(dataDir, configFile);

  const text =
    [
      "JobSeeker problem report",
      "",
      `Reported:   ${when.toISOString()}`,
      `Version:    ${meta.version}`,
      `Platform:   ${meta.platform}`,
      `Node:       ${meta.node}`,
      `Browser:    ${meta.userAgent}`,
      `Page:       ${meta.page}`,
      `Screenshot: ${png ? "included, with the reporter's consent" : "not included"}`,
      "",
      "--- what happened -------------------------------------------------------",
      "",
      String(message || "").trim() || "(nothing written)",
      "",
      "--- note ----------------------------------------------------------------",
      "",
      "app.log is redacted: names, email addresses, phone numbers, company names and",
      "the home directory are masked. No data/ table, CV, contact or message body is",
      "in this file. The screenshot, if present, is a render of the dashboard page",
      "itself and will show whatever was on it.",
      "",
    ].join("\n") + "\n";

  const entries = [
    { name: "feedback.txt", data: Buffer.from(text, "utf8") },
    { name: "app.log", data: Buffer.from(await collectLogs(dataDir, dictionary), "utf8") },
  ];
  if (png && png.length && png.length <= MAX_PNG_BYTES) {
    entries.push({ name: "screenshot.png", data: png, store: true });
  }

  const zip = await makeZip(entries, when);
  const dir = await downloadsDir();
  const file = path.join(dir, bundleName(when));
  await fs.writeFile(file, zip);

  return { file, dir, bytes: zip.length, entries: entries.map((e) => e.name) };
}
