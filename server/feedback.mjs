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

const deflateRaw = promisify(zlib.deflateRaw);

/* ------------------------------------------------------------------ the log body */

// One collector, two doors.
//
// scripts/collect-logs.sh (and its Windows twin) is what `npm run logs` and the Settings button
// already run, and it answers questions this module never could: which Claude CLI is on PATH and
// whether a GUI app could see it, what the updater did, whether the app bundle was rebuilt. It also
// redacts on the way out, through server/redact.mjs, with the name dictionary now passed in.
//
// So this does not gather logs itself. It runs that script, pointed at a temp file instead of the
// Desktop (JOBSEEKER_LOGS_OUT, which also suppresses the Finder reveal), and puts the text it wrote
// into the bundle. Duplicating any of it here would mean two collectors drifting apart on what a
// bug report is worth reading.
export async function collectLogs({ runScript, timeoutMs = 180_000 } = {}) {
  const file = path.join(os.tmpdir(), `jobseeker-report-${Date.now()}.txt`);
  try {
    await runScript("collect-logs", [], { timeout: timeoutMs, env: { JOBSEEKER_LOGS_OUT: file } });
    const text = await fs.readFile(file, "utf8");
    if (text.trim()) return text;
    return "The log collector produced nothing.\n";
  } catch (e) {
    // A report that says the collector failed is worth more than no report: the message the user
    // typed is still the point, and "collect-logs would not run" is itself a bug worth hearing.
    return `The log collector could not be run, so this report has no logs in it.\n\n${e?.message || e}\n`;
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
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
export async function buildBundle({ message, png, meta, runScript, when = new Date() }) {
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
      "app.log is the same report `npm run logs` writes, redacted the same way:",
      "names, email addresses, phone numbers, company names and the home directory",
      "are masked. No data/ table, CV, contact or message body is in it. The",
      "screenshot, if present, is a render of the dashboard page itself and will",
      "show whatever was on it.",
      "",
    ].join("\n") + "\n";

  const entries = [
    { name: "feedback.txt", data: Buffer.from(text, "utf8") },
    { name: "app.log", data: Buffer.from(await collectLogs({ runScript }), "utf8") },
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
