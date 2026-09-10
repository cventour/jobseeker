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
// It is a filter rather than a sed chain because the rules need to know what they are NOT allowed
// to touch. A phone number and an ISO timestamp are both long runs of digits and separators, and
// the sed version replaced "2026-09-10T15:39:13Z" with "<redacted-phone>" — which destroys the one
// column every log is read by.

// Anything shaped like a date or a time is spoken for before the phone rule can see it: parked
// behind a sentinel no log contains, and put back once the other rules have run.
const DATEISH =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?|\d{2}:\d{2}:\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/g;

export function redactPatterns(text, home = "") {
  const parked = [];
  let s = String(text).replace(DATEISH, (m) => "«D" + (parked.push(m) - 1) + "»");

  if (home) s = s.split(home).join("~");
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

// Run directly (the two shell twins) rather than imported: behave as the stdin filter it was.
if (process.argv[1] && process.argv[1].endsWith("redact.mjs")) {
  const home = process.argv[2] || "";
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => process.stdout.write(redactPatterns(buf, home)));
}
