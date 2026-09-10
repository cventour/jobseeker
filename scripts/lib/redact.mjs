#!/usr/bin/env node
// A filter: stdin in, redacted stdout out. Shared by scripts/collect-logs.sh and its Windows twin
// scripts/win/collect-logs.ps1, so the two cannot drift into redacting different things.
//
//   cat some.log | node scripts/lib/redact.mjs "$HOME"
//
// It is a filter rather than a sed chain because the rules need to know what they are NOT allowed
// to touch. A phone number and an ISO timestamp are both long runs of digits and separators, and
// the sed version replaced "2026-09-10T15:39:13Z" with "<redacted-phone>" — which destroys the one
// column every log is read by.
const home = process.argv[2] || "";

// Anything shaped like a date or a time is spoken for before the phone rule can see it: parked
// behind a sentinel no log contains, and put back once the other rules have run.
const DATEISH =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?|\d{2}:\d{2}:\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/g;

function redact(text) {
  const parked = [];
  let s = String(text).replace(DATEISH, (m) => "«D" + (parked.push(m) - 1) + "»");

  if (home) s = s.split(home).join("~");
  s = s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted-email>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<redacted-token>")
    .replace(/(token|secret|key|password|authorization)("?\s*[:=]\s*"?)[^\s",}]+/gi, "$1$2<redacted>")
    // A phone number: nine digits or more, with nothing word-like or dotted pressed against either
    // end. That last part is what keeps version strings, ports, byte counts and PIDs out of it.
    .replace(/(^|[^\w./])(\+?\d[\d\s()-]{7,}\d)(?![\w./])/g, (m, pre, num) =>
      num.replace(/\D/g, "").length >= 9 ? pre + "<redacted-phone>" : m);

  return s.replace(/«D(\d+)»/g, (_, i) => parked[Number(i)]);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", () => process.stdout.write(redact(buf)));
