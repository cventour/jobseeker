#!/usr/bin/env node
// What is safe to send out of this machine, in one place.
//
// Imported as redactPatterns(text, home) by server/feedback.mjs (the dashboard's "Report a
// problem"), and run as a stdin filter by scripts/collect-logs.sh and its Windows twin
// scripts/win/collect-logs.ps1:
//
//   cat some.log | node server/redact.mjs "$HOME"
//
// Three callers, one set of rules, so none of them can drift into redacting something different.
// It lives under server/ rather than scripts/lib/ because the dashboard depends on it, and a
// server module reaching up into scripts/ points the dependency the wrong way -- server/ has to
// stand on its own (scripts/test-security.mjs runs it from a directory holding nothing else).
//
// Two layers. The SHAPES below work on any machine with no knowledge of anyone. The NAMES come
// from the user's own data/ — their contacts and the companies they are chasing — because no
// pattern can find "Aegis Networks" in a log line, and that is the layer that actually protects
// a job search rather than a mailbox.

import { promises as fs } from "fs";
import path from "path";
//
// It is a filter rather than a sed chain because the rules need to know what they are NOT allowed
// to touch. A phone number and an ISO timestamp are both long runs of digits and separators, and
// the sed version replaced "2026-09-10T15:39:13Z" with "<redacted-phone>" — which destroys the one
// column every log is read by.

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

// Anything shaped like a date or a time is spoken for before the phone rule can see it: parked
// behind a sentinel no log contains, and put back once the other rules have run.
const DATEISH =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?|\d{2}:\d{2}:\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/g;

export function redactPatterns(text, home = "") {
  const parked = [];
  let s = String(text).replace(DATEISH, (m) => "«D" + (parked.push(m) - 1) + "»");

  if (home) {
    s = s.split(home).join("~");
    // The bare username, on its own, with no path around it. `lsof -i` prints it in a USER column
    // and `ps` in another, so a report promising the home folder name is replaced was still
    // carrying it. Word-bounded so a username that happens to be a substring of something else
    // ("sam" inside "same") survives, and skipped when it is too short to be worth the false
    // positives it would cause.
    const user = home.split(/[\\/]/).filter(Boolean).pop() || "";
    if (user.length >= 3) {
      s = s.replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "<redacted-user>");
    }
  }
  s = s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted-email>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<redacted-token>")
    // Provider keys announce themselves with a prefix and are not otherwise long-hex, so the rule
    // above walks straight past them.
    .replace(/\b(?:sk|pk|ghp|gho|ghu|ghs|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, "<redacted-token>")
    .replace(/(token|secret|key|password|authorization)("?\s*[:=]\s*"?)[^\s",}]+/gi, "$1$2<redacted>")
    // A phone number: nine digits or more, with nothing word-like or dotted pressed against either
    // end. That last part is what keeps version strings, ports, byte counts and PIDs out of it.
    .replace(/(^|[^\w./])(\+?\d[\d\s()-]{7,}\d)(?![\w./])/g, (m, pre, num) =>
      num.replace(/\D/g, "").length >= 9 ? pre + "<redacted-phone>" : m);

  return s.replace(/«D(\d+)»/g, (_, i) => parked[Number(i)]);
}

const RX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** The shapes, then this user's own names. `dictionary` comes from buildDictionary(). */
export function redactAll(text, home = "", dictionary = []) {
  let out = redactPatterns(String(text ?? ""), home);
  for (const term of dictionary) {
    out = out.replace(new RegExp(term.replace(RX_ESCAPE, "\\$&"), "gi"), "<redacted-name>");
  }
  return out;
}

// Run directly (the two shell twins) rather than imported: behave as the stdin filter it was.
//   node server/redact.mjs "$HOME" [dataDir] [configFile]
//
// The optional data directory is what lets `npm run logs` mask names as well as shapes. Optional
// because the collector is sometimes emailed to a tester and run against an install this file knows
// nothing about — and a report with the shapes masked still beats no report at all.
if (process.argv[1] && process.argv[1].endsWith("redact.mjs")) {
  const home = process.argv[2] || "";
  const dataDir = process.argv[3] || "";
  const configFile = process.argv[4] || "";
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", async () => {
    let dict = [];
    if (dataDir) {
      try {
        dict = await buildDictionary(dataDir, configFile);
      } catch {
        /* nothing to build one from — the shape rules still apply */
      }
    }
    process.stdout.write(redactAll(buf, home, dict));
  });
}
