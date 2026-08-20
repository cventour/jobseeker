#!/usr/bin/env node
// Regression tests for two security properties that were verified EXPLOITABLE before they were
// fixed. Both are the kind of bug that reappears quietly during a refactor, which is why they get a
// test rather than a comment.
//
//   1. Record ids become filenames. `upsert-application {"id":"../../ESCAPED"}` returned
//      {"file":"../../ESCAPED.md"} and wrote outside data/. Reachable from untrusted input, because
//      ids reach record.mjs from agents parsing job posts, recruiter email and chat messages.
//   2. The dashboard had no CSRF protection: any web page you visited could POST to
//      localhost:4319 and dismiss proposals or rewrite records. A cross-origin form POST needs no
//      CORS permission, so loopback binding does not help.
//   3. The dashboard bound every interface. It was reachable from this machine's LAN address and
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

  // 5. Cross-site POSTs must be rejected, and same-origin/scripted ones must still work.
  const post = (headers) =>
    fetch(`http://127.0.0.1:${port}/add-task-nl`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: "nl=csrf probe",
      redirect: "manual",
    }).then((r) => r.status).catch(() => 0);

  check("cross-origin POST is rejected", (await post({ origin: "http://evil.example" })) === 403);
  check("Sec-Fetch-Site: cross-site is rejected", (await post({ "sec-fetch-site": "cross-site" })) === 403);
  // 3xx means the handler ran and redirected -- i.e. it was allowed through.
  const same = await post({ origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });
  check("same-origin POST is allowed", same >= 300 && same < 400, `status ${same}`);
  // curl/scripts send neither header; blocking them buys nothing, since anything able to make the
  // request already has local code execution.
  const scripted = await post({});
  check("scripted POST (no browser headers) is allowed", scripted >= 300 && scripted < 400, `status ${scripted}`);

  // 6. The page's own inline <script> must actually parse.
  //
  // The client JS lives inside a template literal in dashboard.mjs, so a backslash meant for the
  // BROWSER is eaten as a JS escape before it is ever served: `/^\/(a|b)$/` arrives as `/^/(a|b)$/`,
  // a SyntaxError. One bad character takes out the entire script block — every filter, every tab,
  // every row action — and the page still returns 200 and looks fine until something is clicked.
  // Exactly the silent-success failure this project keeps fighting, so it gets a test.
  const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  check("dashboard serves at least one inline script", blocks.length > 0, `${blocks.length} block(s)`);
  let scriptOk = true;
  let scriptErr = "";
  for (const src of blocks) {
    try {
      // Parse-only: never executed, just checked for syntactic validity.
      new (async function () {}.constructor)(src);
    } catch (e) {
      scriptOk = false;
      scriptErr = String(e?.message || e).slice(0, 120);
      break;
    }
  }
  check("inline dashboard JS parses", scriptOk, scriptErr);

  child.kill();
  await fs.rm(tmp, { recursive: true, force: true });

  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-security error:", e?.message || e);
  process.exit(1);
});
