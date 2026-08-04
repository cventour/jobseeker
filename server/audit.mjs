#!/usr/bin/env node
// Read-only coordination audit over data/. Prints JSON the supervisor agent interprets:
// duplicate applications/proposals, proposals that overlap an existing application (so we don't
// re-apply), pending approvals, and stale items (overdue tasks, past next-actions, aging proposals).
// Never writes anything. Dependency-free.

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readRecordDir, readTable, parseTable } from "./md.mjs";
import { findRepost, setCompanyAliases} from "./match.mjs";
import { companyAliases } from "./config.mjs";

setCompanyAliases(await companyAliases());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, "..", "data");

function appKey(company, role) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\b(inc|llc|ltd|gmbh|corp|co|the)\b/g, "")
      .replace(/[^a-z0-9]+/g, "")
      .trim();
  return `${norm(company)}::${norm(role)}`;
}

function groupDupes(records) {
  const byKey = new Map();
  for (const r of records) {
    const k = appKey(r.data.company, r.data.role);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ id: r.data.id, company: r.data.company, role: r.data.role, file: r.file });
  }
  return [...byKey.entries()].filter(([, v]) => v.length > 1).map(([key, items]) => ({ key, items }));
}

const daysBetween = (isoDate, todayStr) => {
  // Both YYYY-MM-DD; returns integer day difference (today - date). No Date.now/new Date() needed.
  const toN = (s) => {
    const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
    return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
  };
  return toN(todayStr) - toN(isoDate);
};

// How old a market's `last_reviewed` may get before it should be re-researched. The daily run
// used to decide "is this stale?" by judgement every morning; deriving it here makes the answer
// deterministic and identical across runs.
const MARKET_STALE_DAYS = 7;

// Which markets need a prioritization-agent pass, read from each data/markets/*.md header row.
async function staleMarkets(today) {
  const dir = path.join(DATA, "markets");
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
    const { rows } = parseTable(text);
    // A market file's freshness is the NEWEST last_reviewed in it.
    const dates = rows.map((r) => (r.last_reviewed || "").trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const newest = dates[dates.length - 1] || null;
    const age = newest ? daysBetween(newest, today) : null;
    out.push({
      market: f.replace(/\.md$/, ""),
      last_reviewed: newest,
      age_days: age,
      companies: rows.length,
      stale: age === null || age >= MARKET_STALE_DAYS,
    });
  }
  return out;
}

// How long has browser-only work been going unread?
//
// This exists because `state: "ok"` was actively misleading: runs completed successfully while
// reading no WhatsApp and no LinkedIn for days and skipping ~33 careers boards, and nothing
// anywhere computed that. Two things made the drought invisible:
//   * whatsapp/linkedin had no watermark rows at all, and record.mjs's getWatermark falls back to a
//     legacy file — so a channel never swept in a week still reported a timestamp. The fallback is
//     deliberately NOT honoured here; a missing row must read as "never", because that is the truth.
//   * boards needing a browser are queued, not failed, so they never surfaced as an error.
// Reported as data, not prose, so the digest cannot paraphrase it into something reassuring.
const BROWSER_CHANNELS = ["whatsapp", "linkedin"];

async function browserDebt(today) {
  let watermarks = [];
  try {
    watermarks = (await readTable(path.join(DATA, "watermarks.md"))).rows;
  } catch {
    /* no file yet — every channel reads as never swept */
  }

  const channels = BROWSER_CHANNELS.map((channel) => {
    const row = watermarks.find((r) => r.channel === channel);
    const ts = row?.timestamp || null;
    return {
      channel,
      last_swept: ts,
      // Date-only slice keeps this on the same day granularity as daysBetween's other callers.
      days_since: ts ? daysBetween(String(ts).slice(0, 10), today) : null,
      never_swept: !ts,
    };
  });

  let boards = [];
  try {
    boards = (await readTable(path.join(DATA, "boards.md"))).rows;
  } catch {
    /* registry not built yet */
  }
  const queued = boards.filter((b) => b.access === "browser" || b.access === "blocked");

  // The single number the digest should lead with: worst channel age, with "never" ranking above
  // any finite age rather than sorting as 0 — a channel never swept is the worst case, not the best.
  const ages = channels.map((c) => (c.never_swept ? Infinity : c.days_since ?? 0));
  const worst = Math.max(...ages, 0);

  return {
    channels,
    worst_days: Number.isFinite(worst) ? worst : null,
    any_never_swept: channels.some((c) => c.never_swept),
    boards_needing_browser: queued.length,
    boards_by_access: queued.reduce((a, b) => ((a[b.access] = (a[b.access] || 0) + 1), a), {}),
    // Oldest verification first: these are the rows most likely to be stale guesses by now.
    oldest_queued_boards: queued
      .filter((b) => b.last_verified)
      .sort((a, b) => String(a.last_verified).localeCompare(String(b.last_verified)))
      .slice(0, 5)
      .map((b) => ({ company: b.company, access: b.access, last_verified: b.last_verified })),
  };
}

// Did the last scheduled run finish? A run that dies silently is the failure mode you never
// notice — no digest arrives and nothing complains. scripts/job-run.sh writes this file.
async function lastRun() {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA, ".job-run.status.json"), "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const today = process.argv[2] || "1970-01-01"; // caller passes `date +%F`
  const applications = await readRecordDir(path.join(DATA, "applications"));
  const proposals = await readRecordDir(path.join(DATA, "proposals"));
  const approvals = await readRecordDir(path.join(DATA, "approvals"));
  const tasks = (await readTable(path.join(DATA, "tasks.md"))).rows;

  const appKeys = new Set(applications.map((a) => appKey(a.data.company, a.data.role)));

  // Proposals that duplicate an existing application (already applied / tracked).
  const proposalOverlapsApp = proposals
    .filter((p) => appKeys.has(appKey(p.data.company, p.data.role)))
    .map((p) => ({ id: p.data.id, company: p.data.company, role: p.data.role, status: p.data.status }));

  // Leads that an application has almost certainly replaced, but which record.mjs deliberately will
  // NOT auto-retire: a fuzzy company match (agency naming drifts — "Hays" vs "Hays (client: …)"), a
  // different explicit role title, or a lead already in a live stage. Auto-closing those could bury a
  // genuinely separate opportunity, so they surface here for a human call:
  //   node server/record.mjs supersede-lead <lead-id> <app-id>
  const normC = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const words = (s) =>
    new Set(
      String(s || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3 && !["role", "senior", "global", "with", "team"].includes(w))
    );
  const realApps = applications.filter((a) => String(a.data.kind || "").toLowerCase() === "application");
  const openLeads = applications.filter(
    (a) =>
      String(a.data.kind || "").toLowerCase() !== "application" &&
      !["dismissed", "withdrawn"].includes(String(a.data.status || "").toLowerCase()) &&
      !a.data.superseded_by
  );
  const supersedableLeads = [];
  for (const lead of openLeads) {
    const lc = normC(lead.data.company);
    for (const app of realApps) {
      const ac = normC(app.data.company);
      if (!lc || !ac) continue;
      if (!(lc === ac || lc.startsWith(ac) || ac.startsWith(lc))) continue;
      const lw = words(lead.data.role), aw = words(app.data.role);
      const shared = [...lw].filter((w) => aw.has(w));
      // Same company + any meaningful shared role word = worth a look. Exact/placeholder matches are
      // already handled automatically at write time, so anything landing here needs judgement.
      if (!shared.length && lc === ac) continue;
      supersedableLeads.push({
        lead_id: lead.data.id,
        lead_company: lead.data.company,
        lead_role: lead.data.role,
        lead_status: lead.data.status,
        application_id: app.data.id,
        application_company: app.data.company,
        application_role: app.data.role,
        application_status: app.data.status,
        shared_role_words: shared,
        why: lc === ac ? "same company, overlapping role wording" : "company name variant (agency/parent naming)",
        fix: `node server/record.mjs supersede-lead ${lead.data.id} ${app.data.id}`,
      });
      break;
    }
  }

  // Live proposals that look like a job already applied to — a repost gets a NEW requisition id, so
  // exact-key and req-id checks both miss it. Reported for the user to dismiss, never auto-closed.
  const REQ_PATTERNS = [/\bJR[-_ ]?(\d{4,})\b/gi, /\breq(?:uisition)?\.?\s*#?\s*(\d{3,})\b/gi, /\bR(\d{6,})\b/g, /\bjob\s*(?:id|order)?\s*#?\s*(\d{5,})\b/gi];
  const normReq = (x) => String(x).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const reqIndexOf = (r) => {
    const out = new Set();
    for (const t of String(r.req_id || "").split(/[,;/\s]+/)) { const n = normReq(t); if (n.length >= 3) out.add(n); }
    for (const t of [r.job_url, r.role, r.next_action]) {
      for (const re of REQ_PATTERNS) { re.lastIndex = 0; let m; while ((m = re.exec(String(t || "")))) out.add(normReq(m[0])); }
    }
    return [...out];
  };
  const appData = applications.map((a) => a.data);
  const repostedProposals = proposals
    .filter((p) => String(p.data.status || "").toLowerCase() === "proposed")
    .map((p) => {
      const m = findRepost(p.data, appData, { reqIndex: reqIndexOf });
      return m
        ? {
            proposal_id: p.data.id, company: p.data.company, role: p.data.role,
            matches_application: m.id, applied_role: m.role, application_status: m.status,
            confidence: m.confidence, why: m.why,
            fix: `node server/record.mjs upsert-proposal '{"company":"${p.data.company}","role":"${p.data.role}","status":"dismissed"}'`,
          }
        : null;
    })
    .filter(Boolean);

  const pendingApprovals = approvals
    .filter((a) => a.data.status === "pending")
    .map((a) => ({ id: a.data.id, kind: a.data.kind, summary: a.data.summary, created: a.data.created }));

  const overdueTasks = tasks
    .filter((t) => t.status === "open" && t.due_date && daysBetween(t.due_date, today) >= 0)
    .map((t) => ({ id: t.id, due_date: t.due_date, who: t.who, detail: t.detail, days_overdue: daysBetween(t.due_date, today) }));

  const pastNextActions = applications
    .filter((a) => a.data.next_action_date && daysBetween(a.data.next_action_date, today) > 0)
    .map((a) => ({ id: a.data.id, company: a.data.company, next_action: a.data.next_action, next_action_date: a.data.next_action_date }));

  const agingProposals = proposals
    .filter((p) => p.data.status === "proposed" && p.data.found_date && daysBetween(p.data.found_date, today) >= 7)
    .map((p) => ({ id: p.data.id, company: p.data.company, role: p.data.role, age_days: daysBetween(p.data.found_date, today) }));

  const report = {
    counts: {
      applications: applications.length,
      proposals: proposals.length,
      pending_approvals: pendingApprovals.length,
      open_tasks: tasks.filter((t) => t.status === "open").length,
    },
    duplicate_applications: groupDupes(applications),
    duplicate_proposals: groupDupes(proposals),
    proposals_overlapping_applications: proposalOverlapsApp,
    leads_superseded_by_application: supersedableLeads,
    reposted_proposals: repostedProposals,
    pending_approvals: pendingApprovals,
    overdue_tasks: overdueTasks,
    past_next_actions: pastNextActions,
    aging_proposals: agingProposals,
    markets: await staleMarkets(today),
    browser_debt: await browserDebt(today),
    last_scheduled_run: await lastRun(),
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write("audit.mjs error: " + (e?.message || e) + "\n");
  process.exit(1);
});
