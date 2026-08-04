#!/usr/bin/env node
// Re-validate every stored proposal job_url, concurrently. Read-only — prints JSON, writes nothing.
//
// AGENT-RULES §7 requires that a proposal's link be re-checked before it is surfaced again: ATS
// boards rot, and the nasty ones (Greenhouse, Check Point) serve HTTP 200 with a "role no longer
// available" body rather than a 404, so status code alone proves nothing. Having role-scout open
// 50 URLs itself costs a fetch + a page-read of tokens each. This does the mechanical sweep in
// about a second and hands back only the ones that need a human/agent decision.
//
// Usage:
//   node scripts/check-urls.mjs              # check all non-dismissed proposals
//   node scripts/check-urls.mjs --all        # include dismissed/applied
//   node scripts/check-urls.mjs --json       # machine output only (default is JSON anyway)

import path from "path";
import { fileURLToPath } from "url";
import { readRecordDir } from "../server/md.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, "..", "data");

const CONCURRENCY = 8;
const TIMEOUT_MS = 15_000;

// Soft-404 fingerprints: page loads 200 but the posting is gone. Extend this list as new boards
// are encountered — it is the cheap, deterministic half of the "is this posting live?" question.
const DEAD_PATTERNS = [
  /no longer (be )?(available|accepting)/i,
  /we couldn'?t find (the|that) (role|job|position)/i,
  /this (job|position|role|posting) (is )?(has )?(been )?(closed|expired|filled|removed)/i,
  /job (not found|no longer exists)/i,
  /oops!?[^<]{0,80}parameter is invalid/i, // Check Point's expired joborderid page
  /position (is )?(now )?closed/i,
  /sorry,? this job/i,
  /page not found/i,
  /404/,
];

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function checkOne(p) {
  const url = (p.data.job_url || "").trim();
  const base = {
    id: p.data.id,
    company: p.data.company,
    role: p.data.role,
    status: p.data.status,
    url_volatile: p.data.url_volatile,
    url,
  };
  if (!url) return { ...base, verdict: "no-url" };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      // Some ATS boards 403 an obviously-scripted agent; a normal UA keeps this a fair read of
      // the same public page a browser would get.
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36" },
    });
    const body = res.ok ? stripHtml(await res.text()).slice(0, 4000) : "";
    if (!res.ok) return { ...base, verdict: "dead", http: res.status, why: `HTTP ${res.status}` };
    const hit = DEAD_PATTERNS.find((re) => re.test(body));
    if (hit) return { ...base, verdict: "soft-404", http: res.status, why: `page text matched ${hit}` };
    // NOT a claim that the posting is right — only that it resolves and does not look dead.
    // Confirming title + location is still the agent's job (AGENT-RULES §7).
    return { ...base, verdict: "resolves", http: res.status, snippet: body.slice(0, 160) };
  } catch (e) {
    return { ...base, verdict: "unreachable", why: e.name === "AbortError" ? "timeout" : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// Simple worker pool — keeps a slow board from serialising the whole sweep.
async function pool(items, fn, n) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

async function main() {
  const includeAll = process.argv.includes("--all");
  const proposals = (await readRecordDir(path.join(DATA, "proposals"))).filter((p) => {
    if (includeAll) return true;
    const s = String(p.data.status || "").toLowerCase();
    return s !== "dismissed" && s !== "applied";
  });

  const results = await pool(proposals, checkOne, CONCURRENCY);
  const by = (v) => results.filter((r) => r.verdict === v);
  process.stdout.write(
    JSON.stringify(
      {
        checked: results.length,
        summary: {
          resolves: by("resolves").length,
          dead: by("dead").length,
          soft_404: by("soft-404").length,
          unreachable: by("unreachable").length,
          no_url: by("no-url").length,
        },
        // What an agent actually has to act on.
        needs_attention: [...by("dead"), ...by("soft-404"), ...by("unreachable"), ...by("no-url")],
        ok: by("resolves").map((r) => ({ id: r.id, company: r.company, role: r.role })),
      },
      null,
      2
    ) + "\n"
  );
}

main().catch((e) => {
  process.stderr.write("check-urls.mjs error: " + (e?.message || e) + "\n");
  process.exit(1);
});
