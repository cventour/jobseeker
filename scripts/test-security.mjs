#!/usr/bin/env node
// Regression tests for two security properties that were verified EXPLOITABLE before they were
// fixed. Both are the kind of bug that reappears quietly during a refactor, which is why they get a
// test rather than a comment.
//
//   1. Record ids become filenames. `upsert-application {"id":"../../ESCAPED"}` returned
//      {"file":"../../ESCAPED.md"} and wrote outside data/. Reachable from untrusted input, because
//      ids reach record.mjs from agents parsing job posts, recruiter email and chat messages.
//   2. The dashboard bound every interface. It was reachable from this machine's LAN address and
//      serves personal data with no authentication, so "loopback only" IS the authentication.
//
//   npm run test:security

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import net from "net";
import { fileURLToPath } from "url";
import { execFile, spawn } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

// Traversal shapes, absolute paths, and ids that merely *look* valid until a separator appears.
const MALICIOUS = [
  "../../ESCAPED",
  "../x",
  "/etc/passwd",
  "a/../../b",
  "app_ok/../../evil",
  "..",
  ".",
  "app_ok/../evil",
  "app ok",
  "APP_UPPER",
  "app_ok.md",
];

const LEGITIMATE = ["app_k2gjp9", "prop_abc123", "task_l2rwol", "comm_9tb0sq", "appr_example", "contact_example"];

async function main() {
  console.log("\nsecurity regressions\n");

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-sec-"));
  await fs.mkdir(path.join(tmp, "server"), { recursive: true });
  await fs.mkdir(path.join(tmp, "data"), { recursive: true });
  for (const f of await fs.readdir(path.join(REPO, "server"))) {
    if (f.endsWith(".mjs")) await fs.copyFile(path.join(REPO, "server", f), path.join(tmp, "server", f));
  }
  const rec = (...args) => run("node", [path.join(tmp, "server", "record.mjs"), ...args], { cwd: tmp });

  // 1. Every malicious id must be REJECTED, and must leave no file behind anywhere.
  let accepted = [];
  for (const id of MALICIOUS) {
    try {
      await rec("upsert-application", JSON.stringify({ id, company: "X", role: "Y" }));
      accepted.push(id); // resolving at all means it was not rejected
    } catch {
      /* expected */
    }
  }
  check("malicious ids are rejected", accepted.length === 0, accepted.length ? `accepted: ${accepted.join(", ")}` : "");

  // Belt and braces: prove nothing escaped the data dir even if a rejection were missed.
  const parent = path.dirname(tmp);
  const strays = (await fs.readdir(parent)).filter((f) => /^ESCAPED\.md$|^b\.md$|^evil\.md$/.test(f));
  check("no record escaped the data directory", strays.length === 0, strays.join(", "));

  // 2. Legitimate ids must still be accepted — a validator that breaks real data is not a fix.
  let rejected = [];
  for (const id of LEGITIMATE) {
    try {
      await rec("upsert-application", JSON.stringify({ id, company: `C-${id}`, role: "R" }));
    } catch (e) {
      rejected.push(id);
    }
  }
  check("legitimate ids are accepted", rejected.length === 0, rejected.join(", "));

  // An EMPTY id is not an attack and must not be treated as one: it is falsy, so it falls through
  // to newId(). Asserting it gets rejected would be wrong — assert it yields a safe generated id.
  const blank = JSON.parse(
    (await rec("upsert-application", JSON.stringify({ id: "", company: "Blank", role: "R" }))).stdout
  );
  check("empty id falls through to a generated safe id", /^app_[a-z0-9]+$/.test(blank.id), blank.id);

  // 3. Auto-generated ids must satisfy the same rule they are validated against.
  const out = JSON.parse((await rec("upsert-application", JSON.stringify({ company: "Auto", role: "R" }))).stdout);
  check("generated ids pass their own validator", /^[a-z][a-z0-9]{0,15}_[a-z0-9]{1,32}$/.test(out.id), out.id);

  // 4. The dashboard must bind loopback only.
  const port = 4599;
  const child = spawn("node", [path.join(tmp, "server", "dashboard.mjs")], {
    cwd: tmp,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 1500));

  const connect = (host) =>
    new Promise((resolve) => {
      const sock = net.connect({ host, port, timeout: 1500 });
      sock.on("connect", () => (sock.destroy(), resolve(true)));
      sock.on("error", () => resolve(false));
      sock.on("timeout", () => (sock.destroy(), resolve(false)));
    });

  check("dashboard is reachable on loopback", await connect("127.0.0.1"));

  // Find a non-loopback address for this host; skip honestly if the machine has none.
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((n) => n && n.family === "IPv4" && !n.internal)?.address;
  if (external) {
    check(`dashboard is NOT reachable on ${external}`, (await connect(external)) === false);
  } else {
    console.log("  skip  no non-loopback interface on this host — cannot test external binding");
  }

  child.kill();
  await fs.rm(tmp, { recursive: true, force: true });

  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-security error:", e?.message || e);
  process.exit(1);
});
