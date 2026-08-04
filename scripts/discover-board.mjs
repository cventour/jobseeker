#!/usr/bin/env node
// Find a company's careers board, mechanically. Run automatically when a company is added from the
// dashboard, so a new entry arrives with its board already worked out instead of waiting for the
// next scout run to go hunting.
//
// This is the cheap, deterministic half of what role-scout does by hand: derive candidate ATS slugs
// from the company name and probe the four boards that expose stateless JSON, then fall back to
// looking for a careers page. It does NOT try to be clever — a miss here is fine and expected, and
// it is recorded as a miss so the company surfaces in the dashboard's "website not found" queue for
// a human to paste the real URL. Guessing and recording a wrong endpoint would be worse than
// admitting ignorance (AGENT-RULES §12).
//
// Usage:
//   node scripts/discover-board.mjs "Broadcom" [market]
//   node scripts/discover-board.mjs "Broadcom" Cybersecurity --dry-run   # print, don't write
//
// Writes through `record.mjs upsert-board` (never directly), so it takes the data/ lock like every
// other writer. Safe to run while the dashboard or an agent is writing.

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const TIMEOUT_MS = 12_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

// Candidate slugs, most-likely first. ATS slugs are almost always the brand name with punctuation
// stripped; the variants cover the common suffix habits ("-inc", "careers", first-word-only).
function slugs(company) {
  const base = String(company || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")                       // drop parenthetical suffixes, e.g. "(EMEA)"
    .replace(/\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|the|plc|sa|nv|bv|ag)\b/g, " ")
    .replace(/&/g, " and ")
    .trim();
  const compact = base.replace(/[^a-z0-9]+/g, "");
  const hyphen = base.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const first = base.split(/\s+/)[0]?.replace(/[^a-z0-9]+/g, "") || "";
  const out = [compact, hyphen, `${compact}inc`, `${compact}careers`, `${compact}-careers`, first];
  return [...new Set(out.filter((s) => s && s.length >= 2))];
}

async function get(url, { json = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: json ? "application/json" : "text/html,*/*" },
    });
    const body = res.ok ? await res.text() : "";
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: "", err: e.name === "AbortError" ? "timeout" : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// Each probe returns a count of postings it could actually parse. A 200 that yields no parseable
// job array is NOT a hit — that is how you end up recording an endpoint that returns nothing.
const ATS = [
  {
    name: "greenhouse",
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    count: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
  },
  {
    name: "lever",
    url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    count: (j) => (Array.isArray(j) ? j.length : null),
  },
  {
    name: "ashby",
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    count: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
  },
  {
    name: "smartrecruiters",
    url: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=10`,
    count: (j) => (typeof j?.totalFound === "number" ? j.totalFound : Array.isArray(j?.content) ? j.content.length : null),
    // SmartRecruiters answers 200 + {"totalFound":0,"content":[]} for a company that does not
    // exist — verified against a nonsense slug — so an empty result proves nothing here and would
    // otherwise record a fabricated endpoint. Greenhouse, Lever and Ashby all 404 properly, so for
    // those an empty board is genuinely an empty board and still worth recording.
    requirePostings: true,
  },
];

async function probeATS(company) {
  const tried = [];
  const refused = [];
  for (const slug of slugs(company)) {
    for (const ats of ATS) {
      const url = ats.url(slug);
      const r = await get(url, { json: true });
      if (!r.ok) {
        tried.push(`${ats.name}/${slug}=${r.status || r.err}`);
        // 404 = no such board. 401/403/429/5xx = a board that refuses scripts — worth a browser.
        if (browserWorthy(r)) refused.push({ url, why: r.status ? `HTTP ${r.status}` : r.err });
        continue;
      }
      let n = null;
      try {
        n = ats.count(JSON.parse(r.body));
      } catch {
        n = null;
      }
      if (n === null) {
        tried.push(`${ats.name}/${slug}=200 but unparseable`);
        continue;
      }
      if (ats.requirePostings && n === 0) {
        tried.push(`${ats.name}/${slug}=200 but empty (this board 200s for unknown slugs — not a hit)`);
        continue;
      }
      // For the boards that 404 properly, zero live postings is still a real board worth recording.
      return { hit: { ats: ats.name, endpoint: url, postings: n, slug }, tried, refused };
    }
  }
  return { hit: null, tried, refused };
}

// A status that means "something IS here but it will not talk to a script" — as opposed to 404,
// which means nothing is there. These are worth a browser pass; 404s are not. TLS failures count:
// Microsoft's careers host presents a cert whose altnames are *.azureedge.net, so curl and fetch
// both refuse it while a browser loads it fine.
const BROWSER_WORTHY = new Set([401, 402, 403, 405, 406, 407, 423, 429, 500, 502, 503, 504, 520, 521, 522, 523, 525, 530]);
const TLS_ERR = /certificate|cert|tls|ssl|EPROTO|ERR_TLS|altname|self.signed|unable to verify/i;
function browserWorthy(r) {
  return BROWSER_WORTHY.has(r.status) || (!!r.err && TLS_ERR.test(r.err));
}

// No ATS match — is there at least a careers page? Every candidate is tried to the end rather than
// bailing on the first refusal: a 403 on /careers says nothing about /jobs, and short-circuiting
// used to throw away the rest of the candidates.
async function probeCareers(company) {
  const s = slugs(company)[0];
  const hosts = [`https://www.${s}.com`, `https://${s}.com`, `https://careers.${s}.com`, `https://www.${s}.ae`];
  const paths = ["/careers", "/en/careers", "/company/careers", "/about/careers", "/careers/jobs", "/jobs"];
  const tried = [];
  const refused = [];
  for (const h of hosts) {
    for (const p of paths) {
      const url = h + p;
      const r = await get(url);
      if (r.ok && r.body.length > 500) {
        // One fetch cannot tell whether the listing itself is JS-rendered, so this is recorded as
        // html WITH that caveat rather than asserted as readable.
        return { hit: { endpoint: url, bytes: r.body.length }, tried, refused };
      }
      tried.push(`${url}=${r.status || r.err}`);
      if (browserWorthy(r)) refused.push({ url, why: r.status ? `HTTP ${r.status}` : r.err });
    }
  }
  return { hit: null, tried, refused };
}

function record(json) {
  return new Promise((resolve) => {
    const child = spawn("node", [path.join(ROOT, "server", "record.mjs"), "upsert-board", JSON.stringify(json)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const dry = process.argv.includes("--dry-run");
  const company = args[0];
  const market = args[1] || "";
  if (!company) {
    process.stderr.write('Usage: discover-board.mjs "<company>" [market] [--dry-run]\n');
    process.exit(2);
  }

  const ats = await probeATS(company);
  let row;
  if (ats.hit) {
    row = {
      company,
      market,
      ats: ats.hit.ats,
      endpoint: ats.hit.endpoint,
      access: "json",
      notes: `AUTO-DISCOVERED ${new Date().toISOString().slice(0, 10)}: slug "${ats.hit.slug}" on ${ats.hit.ats}, ${ats.hit.postings} postings live. Verify the postings are real target roles before proposing.`,
    };
  } else {
    const careers = await probeCareers(company);
    if (careers.hit) {
      row = {
        company,
        market,
        ats: "unknown",
        endpoint: careers.hit.endpoint,
        access: "html",
        notes: `AUTO-DISCOVERED ${new Date().toISOString().slice(0, 10)}: no ATS slug matched (${ats.tried.length} probes); careers page fetched OK. NOT confirmed machine-readable — the listing may still be JS-rendered. A scout should confirm and reclassify.`,
      };
    } else if (careers.refused.length || ats.refused.length) {
      // Something is there, it just will not serve a script. That is a browser job, NOT a dead end —
      // `blocked` puts it in the browser queue that role-scout works when Chrome is available.
      const all = [...ats.refused, ...careers.refused];
      const best = careers.refused[0] || ats.refused[0];
      row = {
        company,
        market,
        ats: "unknown",
        endpoint: best.url,
        access: "blocked",
        notes: `AUTO-DISCOVERY ${new Date().toISOString().slice(0, 10)}: REFUSED SCRIPTED ACCESS, not absent — ${all
          .slice(0, 4)
          .map((x) => `${x.url} ${x.why}`)
          .join("; ")}${all.length > 4 ? ` (+${all.length - 4} more)` : ""}. → ESCALATE TO BROWSER: retry with claude-in-chrome, then reclassify. Do not record this as "no board".`,
      };
    } else {
      row = {
        company,
        market,
        ats: "none",
        endpoint: "",
        access: "none",
        notes: `AUTO-DISCOVERY ${new Date().toISOString().slice(0, 10)} FOUND NOTHING — every probe 404'd or the host did not resolve; nothing refused us, so a browser is unlikely to help either. Tried ${ats.tried.length} ATS probes (greenhouse/lever/ashby/smartrecruiters across ${slugs(company).length} slug variants) and ${careers.tried.length} careers-page paths. Paste the real careers URL in Settings.`,
      };
    }
  }

  if (dry) {
    process.stdout.write(JSON.stringify({ dry_run: true, row, ats_tried: ats.tried }, null, 2) + "\n");
    return;
  }
  const res = await record(row);
  process.stdout.write(JSON.stringify({ company, access: row.access, endpoint: row.endpoint, recorded: res }) + "\n");
}

main().catch((e) => {
  process.stderr.write("discover-board.mjs error: " + (e?.message || e) + "\n");
  process.exit(1);
});
