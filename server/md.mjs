// Dependency-free Markdown helpers for the local job-seeker state (data/*.md).
// Two formats only:
//   1. Frontmatter records  — a `---` fenced block of flat `key: value` lines + a body.
//   2. Table logs           — a standard Markdown table (append = add a row).
// Kept tiny and free of any npm dependency so server/dashboard.mjs runs on plain Node.

import { promises as fs } from "fs";
import path from "path";

// ---------- Atomic writes ----------

// Write via a temp file + rename. rename() is atomic on POSIX, so a reader (or a crash) never
// sees a half-written table — it sees either the old file or the new one. Plain writeFile
// truncates first, so an interrupted write would leave a corrupt table that nothing can parse.
export async function writeFileAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Temp file must live in the same directory — rename() is only atomic within a filesystem.
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

// ---------- Frontmatter records ----------

// Parse `---\nkey: value\n---\nbody` into { data: {..}, body: "" }. Flat values only
// (strings); lists are left as raw comma strings for the caller to split.
export function parseFrontmatter(text) {
  const data = {};
  let body = text ?? "";
  const m = /^﻿?---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text ?? "");
  if (m) {
    body = m[2] ?? "";
    for (const line of m[1].split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) data[key] = value;
    }
  }
  return { data, body: body.replace(/^\n+/, "") };
}

// Serialize back to `---` frontmatter + body. `order` optionally fixes key order.
export function stringifyFrontmatter(data, body = "", order = null) {
  const keys = order ?? Object.keys(data);
  const lines = keys.map((k) => `${k}: ${data[k] ?? ""}`);
  return `---\n${lines.join("\n")}\n---\n\n${(body ?? "").trim()}\n`;
}

// Read every `<id>.md` in a directory as a frontmatter record. Returns [] if dir is absent.
export async function readRecordDir(dir) {
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    if (!f.endsWith(".md") || f.startsWith(".")) continue;
    const text = await fs.readFile(path.join(dir, f), "utf8");
    const { data, body } = parseFrontmatter(text);
    out.push({ file: f, id: data.id ?? f.replace(/\.md$/, ""), data, body });
  }
  return out;
}

// Record ids become FILENAMES, so an id is an untrusted path component and must be validated as
// one. Verified exploitable before this existed: upsert-application with {"id":"../../ESCAPED"}
// returned {"file":"../../ESCAPED.md"} and wrote outside data/.
//
// This is reachable from untrusted input, which is what makes it serious rather than theoretical:
// ids reach record.mjs from agents that parse job posts, recruiter email and chat messages. A
// prompt injection in any of those would otherwise chain into arbitrary .md write/overwrite
// anywhere the process can reach.
//
// Allowlist, not a blocklist: matching newId()'s own shape (prefix_suffix, lowercase alphanumerics)
// rejects "..", "/", NUL, absolute paths and unicode lookalikes without needing to enumerate them.
const ID_RE = /^[a-z][a-z0-9]{0,15}_[a-z0-9]{1,32}$/;

export function assertSafeId(id, what = "id") {
  const s = String(id ?? "");
  if (!ID_RE.test(s)) {
    throw new Error(
      `Unsafe ${what}: ${JSON.stringify(s).slice(0, 80)}. ` +
        `Ids must match ${ID_RE} (e.g. app_k2gjp9) — they are used as filenames.`
    );
  }
  return s;
}

export async function writeRecord(dir, id, data, body = "", order = null) {
  assertSafeId(id);
  const file = path.join(dir, `${id}.md`);
  await writeFileAtomic(file, stringifyFrontmatter({ id, ...data }, body, order));
  return file;
}

// ---------- Table logs ----------

const splitRow = (line) =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());

// Parse the first Markdown table found. Returns { headers, rows } where each row is an
// object keyed by header. Separator row (---|---) is skipped.
export function parseTable(text) {
  const lines = (text ?? "").split("\n");
  let headers = null;
  const rows = [];
  for (const line of lines) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = splitRow(line);
    if (!headers) {
      headers = cells;
      continue;
    }
    if (cells.every((c) => /^-{2,}$|^:?-+:?$|^$/.test(c))) continue; // separator
    const row = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    rows.push(row);
  }
  return { headers: headers ?? [], rows };
}

export async function readTable(file) {
  try {
    return parseTable(await fs.readFile(file, "utf8"));
  } catch {
    return { headers: [], rows: [] };
  }
}

// Append a row (object keyed by the file's existing headers) to a Markdown-table file.
// `where` = "top" inserts just under the header (for newest-first logs), else appended.
export async function appendTableRow(file, rowObj, where = "bottom") {
  const text = await fs.readFile(file, "utf8");
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l));
  if (headerIdx === -1) throw new Error(`No table found in ${file}`);
  const headers = splitRow(lines[headerIdx]);
  const cells = headers.map((h) => sanitizeCell(rowObj[h] ?? ""));
  const newRow = `| ${cells.join(" | ")} |`;
  // Data rows start after header + separator line.
  let insertAt = headerIdx + 2;
  if (where !== "top") {
    insertAt = headerIdx + 2;
    while (insertAt < lines.length && /^\s*\|/.test(lines[insertAt])) insertAt++;
  }
  lines.splice(insertAt, 0, newRow);
  await writeFileAtomic(file, lines.join("\n"));
  return newRow;
}

// Table cells can't contain raw pipes or newlines — escape/flatten defensively.
export function sanitizeCell(v) {
  return String(v ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

// ---------- ids ----------

let counter = 0;
export function newId(prefix = "id") {
  // Time-based-ish but deterministic within a process; good enough for local record ids.
  counter += 1;
  const rand = Math.abs(hashStr(`${prefix}${counter}${process.hrtime.bigint()}`)).toString(36);
  return `${prefix}_${rand.slice(0, 8)}`;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
