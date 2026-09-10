#!/usr/bin/env node
// What a problem report must never leak, and must always be.
//
// The redaction here is the only thing standing between a bug report and a stranger reading the
// user's pipeline, so it is asserted rather than eyeballed. The zip is written by hand
// (server/feedback.mjs), so its container is asserted too — a file no unzip tool will open is the
// same as no report at all.

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildDictionary, redact, makeZip, collectLogs, bundleName } from "../server/feedback.mjs";
import { redactPatterns } from "../server/redact.mjs";

const run = promisify(execFile);
let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${cond || !detail ? "" : `\n         ${detail}`}`);
  if (!cond) failed++;
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jsfeedback-"));
const data = path.join(tmp, "data");
await fs.mkdir(path.join(data, "markets"), { recursive: true });

await fs.writeFile(
  path.join(data, "markets", "cybersecurity.md"),
  "| company | market |\n|---|---|\n| Sophos | Cybersecurity |\n| Darktrace | Cybersecurity |\n"
);
await fs.writeFile(
  path.join(data, "contacts.md"),
  "| id | name | company |\n|---|---|---|\n| c1 | Amanda Whitfield | Sophos |\n"
);
await fs.mkdir(path.join(data, "applications"), { recursive: true });
await fs.writeFile(
  path.join(data, "applications", "app_x1.md"),
  "---\nid: app_x1\ncompany: Aegis Networks\nreferrer: Dana Farrow\nstatus: Screening\n---\n"
);
const configFile = path.join(tmp, "job-seeker.config.md");
await fs.writeFile(configFile, "name: Christos Ventouris\n");

const dict = await buildDictionary(data, configFile);

console.log("\nredaction — the shape layer is server/redact.mjs, shared with `npm run logs`");
ok(
  "the shape layer really is the shared one",
  redact("mail a@b.com") === redactPatterns("mail a@b.com", os.homedir()),
  "server/feedback.mjs must not grow a second set of pattern rules"
);
ok("company names from data/markets are masked", !redact("Sophos rejected the fetch", dict).includes("Sophos"));
ok("contact names from data/contacts are masked", !redact("emailed Amanda Whitfield", dict).includes("Amanda"));
ok("the user's own name is masked", !redact("signed as Christos Ventouris", dict).includes("Ventouris"));
ok("email addresses are masked", redact("to ventouris@gmail.com now").includes("<redacted-email>"));
ok("phone numbers are masked", redact("rang +30 694 123 4567 twice").includes("<redacted-phone>"));
ok("token=... in a URL is masked", redact("GET https://x.test/a?token=abc123").includes("<redacted>"));
ok("provider keys are masked", redact("using sk-ab12cd34ef56gh78").includes("<redacted-token>"));
ok("the home directory becomes ~", redact(`read ${os.homedir()}/Downloads/x`).startsWith("read ~/"));
ok("short words survive", redact("the run had 2 ATS hits", dict).includes("ATS"), "3-letter terms must not be shredded");
ok("ordinary log text survives", redact("curate finished in 41s", dict) === "curate finished in 41s");
ok("companies in applications/ are masked", !redact("Aegis Networks returned 403", dict).includes("Aegis"));
ok("a referrer in applications/ is masked", !redact("chased Dana Farrow", dict).includes("Farrow"));
ok("half a company name is masked on its own", !redact("Aegis board is down", dict).includes("Aegis"));

// Everything below is a way the dictionary used to poison a log rather than protect it.
ok("table headers are not treated as names", redact("3 name fields, 1 date column", dict).includes("name"));
ok("table rules are not treated as names", redact("|------|------|", dict) === "|------|------|");
ok("record ids are not treated as names", redact("wrote app_x1", dict).includes("app_x1"));
ok("generic second words survive alone", redact("trust restored, systems green", dict).includes("trust"));
ok("ISO dates survive", redact("applied on 2026-08-04", dict).includes("2026-08-04"));
ok("ISO timestamps survive", redact("at 2026-08-01T09:12:00Z", dict).includes("2026-08-01T09:12:00Z"));
ok("clock times survive", redact("ran at 14:22", dict).includes("14:22"));
ok("a phone next to a date still goes", redact("on 2026-08-04 rang +30 694 123 4567", dict).includes("<redacted-phone>"));

console.log("\nlogs");
await fs.writeFile(path.join(data, ".run-now.log"), "starting curate\nSophos board returned 403\n");
const logs = await collectLogs(data, dict);
ok("a present log is included", logs.includes("starting curate"));
ok("a present log is redacted", !logs.includes("Sophos"));
ok("a missing log is named, not skipped", logs.includes(".bridge.log") && logs.includes("(not present)"));
ok("every known log is accounted for", (logs.match(/=====/g) || []).length === 12);

console.log("\nbundle");
ok("the name sorts and carries a timestamp", /^jobseeker-feedback-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/.test(bundleName()));

const png = Buffer.from("89504e470d0a1a0a" + "00".repeat(64), "hex");
const zip = await makeZip([
  { name: "feedback.txt", data: Buffer.from("hello\n".repeat(200), "utf8") },
  { name: "app.log", data: Buffer.from(logs, "utf8") },
  { name: "screenshot.png", data: png, store: true },
]);
const zipFile = path.join(tmp, "b.zip");
await fs.writeFile(zipFile, zip);

ok("it starts with the local-file signature", zip.readUInt32LE(0) === 0x04034b50);
ok("compressible text is actually compressed", zip.length < 1200 + png.length, `${zip.length} bytes`);

// The real test of a hand-written container: something else can open it.
let listed = "";
try {
  listed = (await run("unzip", ["-l", zipFile])).stdout;
} catch (e) {
  listed = "";
  console.log("       (unzip not available — skipping the round-trip check)");
}
if (listed) {
  ok("unzip lists all three entries", ["feedback.txt", "app.log", "screenshot.png"].every((n) => listed.includes(n)));
  const out = path.join(tmp, "out");
  await run("unzip", ["-q", zipFile, "-d", out]);
  const back = await fs.readFile(path.join(out, "screenshot.png"));
  ok("the PNG survives the round trip byte for byte", back.equals(png));
  const text = await fs.readFile(path.join(out, "app.log"), "utf8");
  ok("the log survives the round trip", text === logs);
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed\n` : "\nall good\n");
process.exit(failed ? 1 : 0);
