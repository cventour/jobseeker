#!/usr/bin/env node
// Safe, dedup-aware write CLI for the local Markdown state. ALL agents mutate data/ through
// this — never by hand-formatting Markdown (which risks corrupting tables). Dependency-free.
//
// Usage:
//   node server/record.mjs upsert-application '<json>'   -> dedup by company+role, merge status forward
//   node server/record.mjs upsert-proposal   '<json>'   -> dedup by company+role
//   node server/record.mjs add-communication '<json>'   -> dedup by thread_url
//   node server/record.mjs add-contact       '<json>'   -> dedup by email (or name)
//   node server/record.mjs add-task          '<json>'
//   node server/record.mjs complete-task <id> [note]    -> mark a task done (reconciliation)
//   node server/record.mjs task-status <id> <status> [note]
//   node server/record.mjs add-approval      '<json>'
//   node server/record.mjs approve <id>                 -> mark an approval approved
//   node server/record.mjs reject  <id>                 -> mark an approval rejected
//   node server/record.mjs edit-approval <id> <text...> -> mark edited + replace the preview
//   node server/record.mjs log <type> <detail...>
//   node server/record.mjs dismissal-patterns          -> why roles get rejected, so scouts stop repeating them
//   node server/record.mjs list-keys                    -> dedupe keys, skip flags, seen_req_ids, repost_of
//   node server/record.mjs list-proposals [--since d] [--limit n] [--status s] -> digest rows with exact job_url
//   node server/record.mjs add-spend '<json>'          -> record what a run cost
//   node server/record.mjs list-spend [--month YYYY-MM] [--limit n] -> month total + recent runs
//   node server/record.mjs get-watermark <channel>      -> last swept timestamp for gmail|whatsapp|linkedin
//   node server/record.mjs set-watermark <channel> <iso> [note]
//   node server/record.mjs list-boards [access|needs-browser] [--include-dismissed] -> the registry
//   node server/record.mjs dismiss-board '<company>' [reason] -> stop surfacing a board
//   node server/record.mjs restore-board '<company>'          -> undo that
//   node server/record.mjs get-board <company>          -> one company's board + how to read it
//   node server/record.mjs upsert-board '<json>'        -> record what you learned about a board
//
// Every command prints a one-line JSON result to stdout so the calling agent can read it.

import { promises as fs, default as fsSync } from "fs";
import { companyAliases } from "./config.mjs";
import path from "path";
import { fileURLToPath } from "url";
import {
  parseFrontmatter,
  stringifyFrontmatter,
  readRecordDir,
  readTable,
  appendTableRow,
  sanitizeCell,
  newId,
  writeFileAtomic,
  assertSafeId,
} from "./md.mjs";
import { withLock } from "./lock.mjs";
import { findRepost, setCompanyAliases} from "./match.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");

// ---- dedupe helpers ----

const STATUS_RANK = {
  Saved: 0,
  Applied: 1,
  Screening: 2,
  // Multi-round interviews get their own stages so progression (and the dashboard "Advance" button)
  // is captured per round. Legacy "Interview" is kept as an alias for "Interview 1".
  Interview: 3,
  "Interview 1": 3,
  "Interview 2": 4,
  "Interview 3": 5,
  "Interview 4": 6,
  Offer: 7,
  Rejected: 8,
  Withdrawn: 8,
};

function appKey(company, role) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\b(inc|llc|ltd|gmbh|corp|co|the)\b/g, "")
      .replace(/[^a-z0-9]+/g, "")
      .trim();
  return `${norm(company)}::${norm(role)}`;
}

function mergeStatus(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;
  if ((STATUS_RANK[incoming] ?? 0) >= (STATUS_RANK[current] ?? 0)) return incoming;
  return current;
}

const today = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();

// Canonical company names so an employer known by two names does not become two records (an
// acquisition, a rebrand, an agency trading name). The mapping is PERSONAL, so it is configured in
// the gitignored config/job-seeker.config.md rather than hardcoded here — see server/config.mjs.
const COMPANY_ALIASES = await companyAliases();
setCompanyAliases(COMPANY_ALIASES);
function canonicalCompany(name) {
  const key = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  return COMPANY_ALIASES[key] || name;
}

const APPLICATION_ORDER = [
  "id", "company", "role", "kind", "channel", "referrer", "location", "status", "source",
  "applied_date", "last_update", "next_action", "next_action_date", "contact", "job_url", "req_id",
  // Stage-advance detection: when a thread shows evidence of progressing (interview invite, next round,
  // offer, etc.) an agent leaves the current `status` as-is but records the DETECTED next stage in
  // `pending_stage` with `pending_note` = the evidence + next step. The dashboard shows an "Advance"
  // button on that line; one click applies pending_stage to status and clears the pending fields.
  "pending_stage", "pending_note",
  // When the pending advance was first detected. Set automatically on the transition into
  // pending_stage, so the dashboard can show how old the evidence is — a note written days ago can
  // describe a situation that has since moved on (observed: a "further round offered" note still
  // showing after the round had been scheduled).
  "pending_since",
  // A pending advance the user explicitly rejected. Kept (rather than just cleared) so agents can
  // tell "never proposed" from "proposed and declined" and do not re-raise the same advance on the
  // same evidence tomorrow.
  "advance_dismissed_stage", "advance_dismissed_date", "advance_dismissed_note",
  "dismiss_reason",
  // Set when an application replaced this lead — see supersedeLeadsFor(). Keeps the audit trail
  // while dropping the lead out of the active Leads list.
  "superseded_by",
];
const PROPOSAL_ORDER = [
  "id", "company", "role", "location", "market", "source", "job_url", "req_id", "verified",
  "url_volatile", "company_rank", "role_fit", "cv_match", "priority", "status", "seen", "found_date",
  // Why the user rejected this. `dismiss_tags` is a short controlled vocabulary so the reasons can
  // actually be counted and learned from; `dismiss_reason` is their free text. Both optional.
  "dismiss_tags", "dismiss_reason",
];

// The reasons a role gets rejected, as pickable tags. Deliberately a SHORT closed list: free text
// alone cannot be aggregated, and a long list just gets ignored. Mirrored in the dashboard chips.
export const DISMISS_TAGS = {
  seniority: "Too junior / wrong level",
  location: "Wrong location",
  domain: "Not my domain",
  comp: "Comp too low",
  company: "Company not a fit",
  duplicate: "Already applied / duplicate",
  dead: "Role closed or dead link",
  // Set automatically when a whole vertical is dropped from criteria, never picked by hand. It is
  // deliberately its OWN tag rather than reusing `domain`: these roles were not judged a bad fit,
  // the market simply stopped being targeted. Filing them under `domain` would feed their titles
  // into the do-not-propose list in dismissalPatterns() and suppress unrelated roles that happen to
  // share a word with a fintech posting.
  market: "Market no longer targeted",
};

async function ensureTable(file, template) {
  try {
    await fs.access(file);
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, template, "utf8");
  }
}

async function logActivity(type, detail) {
  const file = path.join(DATA, "activity.md");
  await ensureTable(file, "# Activity\n\n| timestamp | type | detail |\n|-----------|------|--------|\n");
  await appendTableRow(file, { timestamp: nowISO(), type, detail: sanitizeCell(detail) }, "top");
}

// ---- commands ----

// ---- leads superseded by an application ----
// A lead is a PRECURSOR to an application: "CV sent", "referral offered", "role TBD". Once the
// application for that role exists, the lead is history and must not keep sitting in the Leads
// list as if it were still an open thread. Two records exist in the first place because the lead
// was logged with a placeholder role ("Role via referral (TBD)") and the application later got the
// real title — different dedupe key, so nothing connected them.
//
// Superseding sets the lead to Dismissed with `superseded_by`, which drops it out of the Leads
// list's default "Active" filter while keeping it recoverable under "Dismissed". Nothing is deleted.
const normRole = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const normComp = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// "Role TBD", "(unknown …)", "Conversation (TBD)", "Role via referral" — a lead with no real title.
// These are the ones that become an application under a different name.
function isPlaceholderRole(role) {
  const s = String(role || "").toLowerCase();
  if (!s.trim()) return true;
  return /\btbd\b|\bunknown\b|conversation|role via|\(referral\)|open to /.test(s);
}

// Agency/parent naming drifts ("Hays" vs "Hays (client: unnamed financial institution)"), so a
// prefix match counts as the same company.
function sameCompany(a, b) {
  const x = normComp(a), y = normComp(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

// Only AUTO-supersede when it is unambiguous. A lead with its own explicit, different role title, or
// one already progressing through a live stage, is a separate opportunity — those are reported as
// candidates for a human to confirm, never closed automatically.
const ACTIVE_LEAD_STAGES = new Set(["screening", "interview", "interview 1", "interview 2", "interview 3", "interview 4", "offer"]);
function autoSupersedable(lead, appCompany, appRole) {
  if (String(lead.data.kind || "").toLowerCase() === "application") return false;
  if (["dismissed", "withdrawn"].includes(String(lead.data.status || "").toLowerCase())) return false;
  if (ACTIVE_LEAD_STAGES.has(String(lead.data.status || "").toLowerCase())) return false;
  if (!sameCompany(lead.data.company, appCompany)) return false;
  return normRole(lead.data.role) === normRole(appRole) || isPlaceholderRole(lead.data.role);
}

async function supersedeLeadsFor(dir, existing, appId, appCompany, appRole) {
  const done = [];
  for (const lead of existing) {
    if (!autoSupersedable(lead, appCompany, appRole)) continue;
    const data = {
      ...lead.data,
      status: "Dismissed",
      superseded_by: appId,
      last_update: today(),
      dismiss_reason: `Superseded by application ${appId} (${appCompany} — ${appRole}) on ${today()}. The lead was the precursor to that application; kept for history, removed from the active Leads list.`,
    };
    await writeFileAtomic(path.join(dir, lead.file), stringifyFrontmatter(data, lead.body, APPLICATION_ORDER));
    await logActivity(
      "lead-superseded",
      `${lead.data.id} (${lead.data.company} — ${lead.data.role}) superseded by application ${appId} (${appCompany} — ${appRole})`
    );
    done.push(lead.data.id);
  }
  return done;
}

async function upsertApplication(input) {
  input = { ...input, company: canonicalCompany(input.company) };
  const dir = path.join(DATA, "applications");
  const existing = await readRecordDir(dir);
  const key = appKey(input.company, input.role);
  const match = existing.find((r) => appKey(r.data.company, r.data.role) === key);

  if (match) {
    const merged = { ...match.data, ...stripEmpty(input) };
    merged.status = mergeStatus(match.data.status, input.status);
    merged.last_update = input.last_update || today();
    // Stamp the transition into a pending advance; clear it when the advance goes away.
    if (merged.pending_stage && !match.data.pending_stage) merged.pending_since = today();
    if (!merged.pending_stage) merged.pending_since = "";
    const body = input.notes != null ? String(input.notes) : match.body;
    await writeFileAtomic(
      path.join(dir, match.file),
      stringifyFrontmatter(merged, body, APPLICATION_ORDER)
    );
    await logActivity(input._activity_type || "track", `Updated application: ${merged.company} — ${merged.role} [${merged.status}]`);
    // Retire any precursor lead once this record IS an application (it may only have become one now).
    const superseded =
      String(merged.kind || "").toLowerCase() === "application"
        ? await supersedeLeadsFor(dir, existing.filter((r) => r.file !== match.file), merged.id, merged.company, merged.role)
        : [];
    return { action: "updated", id: match.data.id, file: match.file, ...(superseded.length ? { superseded_leads: superseded } : {}) };
  }

  const id = input.id ? assertSafeId(input.id) : newId("app");
  const data = {
    id,
    company: input.company || "",
    role: input.role || "",
    // Conservative default: a new entry is a LEAD until there is application evidence.
    // Only set kind:"application" when there's a confirmation (ATS/"we received your application").
    kind: input.kind || "lead",
    channel: input.channel || "",
    referrer: input.referrer || "",
    location: input.location || "",
    status: input.status || "Saved",
    source: input.source || "Manual",
    applied_date: input.applied_date || "",
    last_update: input.last_update || today(),
    next_action: input.next_action || "",
    next_action_date: input.next_action_date || "",
    contact: input.contact || "",
    job_url: input.job_url || "",
    // detected next stage awaiting a one-click confirm on the dashboard (see APPLICATION_ORDER note)
    pending_stage: input.pending_stage || "",
    pending_note: input.pending_note || "",
    pending_since: input.pending_stage ? today() : "",
  };
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, `${id}.md`), stringifyFrontmatter(data, input.notes || "", APPLICATION_ORDER));
  await logActivity(input._activity_type || "track", `New application: ${data.company} — ${data.role} [${data.status}]`);
  // A new APPLICATION retires the lead it grew out of, so the same opportunity is not tracked twice.
  const superseded =
    String(data.kind).toLowerCase() === "application"
      ? await supersedeLeadsFor(dir, existing, id, data.company, data.role)
      : [];
  return { action: "created", id, file: `${id}.md`, ...(superseded.length ? { superseded_leads: superseded } : {}) };
}

// Manually retire a lead that an application has replaced, for the cases auto-supersede
// deliberately will not touch: a different explicit role title, a fuzzy company match, or a lead
// already in a live stage. Reversible — the record keeps its history and stays under "Dismissed".
async function supersedeLead(leadId, appId, note) {
  if (!leadId || !appId) throw new Error("Usage: supersede-lead <lead-id> <application-id> [note]");
  const dir = path.join(DATA, "applications");
  const existing = await readRecordDir(dir);
  const lead = existing.find((r) => r.data.id === leadId);
  if (!lead) throw new Error(`No record ${leadId}`);
  const app = existing.find((r) => r.data.id === appId);
  if (!app) throw new Error(`No record ${appId}`);
  if (String(lead.data.kind || "").toLowerCase() === "application") {
    throw new Error(`${leadId} is an application, not a lead — refusing to supersede it`);
  }
  const data = {
    ...lead.data,
    status: "Dismissed",
    superseded_by: appId,
    last_update: today(),
    dismiss_reason:
      note ||
      `Superseded by application ${appId} (${app.data.company} — ${app.data.role}) on ${today()}.`,
  };
  await writeFileAtomic(path.join(dir, lead.file), stringifyFrontmatter(data, lead.body, APPLICATION_ORDER));
  await logActivity(
    "lead-superseded",
    `${leadId} (${lead.data.company} — ${lead.data.role}) superseded by ${appId} (${app.data.company} — ${app.data.role})${note ? ` — ${note}` : ""}`
  );
  return { action: "superseded", lead: leadId, by: appId };
}

// Apply a detected stage advance: move `status` to `pending_stage` (forward-only), fold the
// evidence note into `next_action`, and clear the pending fields. Triggered by the dashboard's
// one-click "Advance" button (or `advance-app-stage <id> [target-stage]`).
async function advanceAppStage(id, targetOverride) {
  const dir = path.join(DATA, "applications");
  const existing = await readRecordDir(dir);
  const match = existing.find((r) => r.data.id === id);
  if (!match) return { action: "not-found", id };
  const d = match.data;
  const target = targetOverride || d.pending_stage;
  if (!target) return { action: "no-pending-stage", id };
  const newStatus = mergeStatus(d.status, target); // forward-only guard
  const merged = {
    ...d,
    status: newStatus,
    last_update: today(),
    next_action: d.pending_note || d.next_action || "",
    pending_stage: "",
    pending_note: "",
    pending_since: "",
    // Taking the advance supersedes any earlier rejection of it.
    advance_dismissed_stage: "", advance_dismissed_date: "", advance_dismissed_note: "",
  };
  await writeFileAtomic(path.join(dir, match.file), stringifyFrontmatter(merged, match.body, APPLICATION_ORDER));
  await logActivity("stage-advance", `Advanced ${merged.company} — ${merged.role} → ${newStatus} (confirmed)`);
  return { action: "advanced", id, status: newStatus };
}

// Reject a detected stage advance. Clears the pending fields so it leaves the Today queue, and
// RECORDS the rejection so an agent seeing the same evidence tomorrow does not raise it again.
// The note is optional by design — forcing a reason just produces empty reasons.
async function dismissAdvance(id, note) {
  const dir = path.join(DATA, "applications");
  const existing = await readRecordDir(dir);
  const match = existing.find((r) => r.data.id === id);
  if (!match) return { action: "not-found", id };
  const d = match.data;
  const stage = d.pending_stage;
  if (!stage) return { action: "no-pending-stage", id };
  const merged = {
    ...d,
    last_update: today(),
    pending_stage: "",
    pending_note: "",
    pending_since: "",
    advance_dismissed_stage: stage,
    advance_dismissed_date: today(),
    advance_dismissed_note: note || "",
  };
  await writeFileAtomic(path.join(dir, match.file), stringifyFrontmatter(merged, match.body, APPLICATION_ORDER));
  await logActivity(
    "advance-dismissed",
    `${merged.company} — ${merged.role}: declined the advance to ${stage}${note ? ` — ${note}` : " (no reason given)"}`
  );
  return { action: "advance-dismissed", id, stage };
}

async function upsertProposal(input) {
  input = { ...input, company: canonicalCompany(input.company) };
  const dir = path.join(DATA, "proposals");
  const existing = await readRecordDir(dir);
  const key = appKey(input.company, input.role);
  // Match by normalized company+role OR by the same job posting URL. The URL match catches the case
  // where the scout re-finds a role the user dismissed but the posting TITLE was reworded between
  // runs (different company+role text → would otherwise create a brand-new proposal that reappears).
  // Normalize a posting URL for comparison: lowercase, drop the hash, drop only VOLATILE tracking
  // params (LinkedIn refId/trackingId, utm_*, etc.) while KEEPING meaningful job-id params (e.g.
  // Check Point joborderid, Greenhouse gh_jid) so different roles on the same ATS don't collide.
  const TRACK = new Set(["refid","trackingid","trk","src","position","originaltype","savedsearchid","alternatechannel","eu_consent","lipi","utm_source","utm_medium","utm_campaign","utm_content","utm_term","gh_src"]);
  const normUrl = (u) => {
    let s = String(u || "").trim().toLowerCase().replace(/#.*$/, "");
    if (!s) return "";
    const qi = s.indexOf("?");
    if (qi === -1) return s.replace(/\/+$/, "");
    const base = s.slice(0, qi).replace(/\/+$/, "");
    const params = s.slice(qi + 1).split("&").map((kv) => kv.split("="))
      .filter(([k]) => k && !TRACK.has(k)).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((kv) => kv.join("="));
    return params.length ? base + "?" + params.join("&") : base;
  };
  const inUrl = normUrl(input.job_url);
  const match = existing.find(
    (r) => appKey(r.data.company, r.data.role) === key || (inUrl && normUrl(r.data.job_url) === inUrl)
  );
  if (match) {
    const merged = { ...match.data, ...stripEmpty(input) };
    // Sticky decisions: re-curation must NOT resurrect a proposal the user dismissed, nor undo an
    // "applied" one. role-scout re-passes status:"proposed" every run when it re-finds the same role;
    // without this guard that flips a dismissed proposal back to active the next day. A real restore
    // goes through the dashboard's /set-proposal-status (handleSetProposalStatus), not this path.
    const cur = String(match.data.status || "proposed").toLowerCase();
    if (cur === "dismissed" || cur === "applied") merged.status = match.data.status;
    await writeFileAtomic(path.join(dir, match.file), stringifyFrontmatter(merged, input.rationale ?? match.body, PROPOSAL_ORDER));
    return { action: "updated", id: match.data.id, file: match.file };
  }
  const id = input.id ? assertSafeId(input.id) : newId("prop");
  const data = {
    id,
    company: input.company || "",
    role: input.role || "",
    location: input.location || "",
    market: input.market || "",
    source: input.source || "",
    job_url: input.job_url || "",
    // "verified" is ONLY "yes" when the posting link was OPENED and its title+location confirmed.
    verified: input.verified || "no",
    // "url_volatile":"yes" → the job_url uses a short-lived/rotating token (e.g. Check Point joborderid)
    // that silently dies; dashboard shows it red with a re-search disclaimer. Put the stable Job ID in rationale.
    url_volatile: input.url_volatile || "no",
    company_rank: input.company_rank ?? "",
    role_fit: input.role_fit ?? "",
    cv_match: input.cv_match ?? "",
    priority: input.priority ?? "",
    status: input.status || "proposed",
    // "seen":"no" marks a freshly-found role → highlighted on the dashboard until the user reviews/actions it.
    seen: input.seen || "no",
    found_date: input.found_date || today(),
  };
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, `${id}.md`), stringifyFrontmatter(data, input.rationale || "", PROPOSAL_ORDER));
  await logActivity("curate", `New proposal: ${data.company} — ${data.role}`);
  return { action: "created", id, file: `${id}.md` };
}

async function addCommunication(input) {
  const file = path.join(DATA, "communications.md");
  await ensureTable(file, "# Communications\n\n| id | date | source | from | subject | summary | related_application_id | thread_url |\n|----|------|--------|------|---------|---------|------------------------|------------|\n");
  const table = await readTable(file);
  if (input.thread_url && table.rows.some((r) => r.thread_url === input.thread_url)) {
    return { action: "skipped-duplicate", thread_url: input.thread_url };
  }
  const id = input.id ? assertSafeId(input.id) : newId("comm");
  await appendTableRow(file, {
    id,
    date: input.date || nowISO(),
    source: input.source || "",
    from: sanitizeCell(input.from),
    subject: sanitizeCell(input.subject),
    summary: sanitizeCell(input.summary),
    related_application_id: input.related_application_id || "",
    thread_url: input.thread_url || "",
  });
  return { action: "added", id };
}

async function addContact(input) {
  const file = path.join(DATA, "contacts.md");
  await ensureTable(file, "# Contacts\n\n| id | name | company | role | email | linkedin_url | notes |\n|----|------|---------|------|-------|--------------|-------|\n");
  const table = await readTable(file);
  const dup = table.rows.find(
    (r) => (input.email && r.email === input.email) || (!input.email && r.name === input.name)
  );
  if (dup) return { action: "skipped-duplicate", id: dup.id };
  const id = input.id ? assertSafeId(input.id) : newId("contact");
  await appendTableRow(file, {
    id,
    name: sanitizeCell(input.name),
    company: sanitizeCell(input.company),
    role: sanitizeCell(input.role),
    email: sanitizeCell(input.email),
    linkedin_url: sanitizeCell(input.linkedin_url),
    notes: sanitizeCell(input.notes),
  });
  return { action: "added", id };
}

// A task is ONE ACTION, and its detail is the line the user reads on the Today page. It is not a
// place to park research: details reached 4,161 characters and a single row swallowed five separate
// tasks, which made Today unreadable and the work harder to act on, not easier.
//
// Context belongs where it can be read properly — in the linked application or proposal's notes
// body — and `related_id` connects the two. So this is a hard cap that REJECTS rather than
// truncating: silently cutting text loses information, while an error makes the caller split the
// task or move the context, which is the behaviour we actually want.
const TASK_DETAIL_MAX = 200;

function assertShortDetail(detail) {
  const d = String(detail ?? "");
  if (d.length > TASK_DETAIL_MAX) {
    throw new Error(
      `Task detail is ${d.length} characters; the limit is ${TASK_DETAIL_MAX}. ` +
        `A task is one action — put the reasoning in the linked application/proposal notes and ` +
        `reference it with related_id, or split this into several tasks. First 120 chars: ` +
        JSON.stringify(d.slice(0, 120))
    );
  }
  return d;
}

async function addTask(input) {
  const file = path.join(DATA, "tasks.md");
  await ensureTable(file, "# Tasks\n\n| id | due_date | type | who | related_id | status | detail |\n|----|----------|------|-----|------------|--------|--------|\n");
  const id = input.id ? assertSafeId(input.id) : newId("task");
  await appendTableRow(file, {
    id,
    due_date: input.due_date || "",
    type: input.type || "followup",
    who: sanitizeCell(input.who),
    related_id: input.related_id || "",
    status: input.status || "open",
    detail: sanitizeCell(assertShortDetail(input.detail)),
  });
  return { action: "added", id };
}

async function addApproval(input) {
  const dir = path.join(DATA, "approvals");
  const id = input.id ? assertSafeId(input.id) : newId("appr");
  const data = {
    id,
    kind: input.kind || "message",
    status: "pending",
    created: nowISO(),
    related_id: input.related_id || "",
    channels: input.channels || "whatsapp, chat",
    summary: sanitizeCell(input.summary),
  };
  await fs.mkdir(dir, { recursive: true });
  const body = input.preview || "## Preview\n\n_(no preview)_\n";
  await writeFileAtomic(path.join(dir, `${id}.md`), stringifyFrontmatter(data, body, Object.keys(data)));
  await logActivity("approval-request", `${data.kind} approval requested: ${data.summary}`);
  return { action: "created", id, file: `${id}.md` };
}

async function setTaskStatus(id, status, note) {
  const file = path.join(DATA, "tasks.md");
  const text = await fs.readFile(file, "utf8");
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l));
  if (headerIdx === -1) throw new Error("No tasks table");
  const headers = lines[headerIdx].replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const idIdx = headers.indexOf("id");
  const stIdx = headers.indexOf("status");
  const detIdx = headers.indexOf("detail");
  let changed = false;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const cells = lines[i].replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    if (cells[idIdx] === id) {
      cells[stIdx] = status;
      if (note && detIdx >= 0) cells[detIdx] = `${cells[detIdx]} — ${sanitizeCell(note)}`;
      lines[i] = `| ${cells.join(" | ")} |`;
      changed = true;
      break;
    }
  }
  if (!changed) throw new Error(`Task not found: ${id}`);
  await writeFileAtomic(file, lines.join("\n"));
  await logActivity("task-" + status, `Task ${id} → ${status}${note ? " (" + note + ")" : ""}`);
  return { action: status, id };
}

async function setApprovalStatus(id, status, newPreview) {
  assertSafeId(id);
  const file = path.join(DATA, "approvals", `${id}.md`);
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(`Approval not found: ${id}`);
  }
  const { data, body } = parseFrontmatter(text);
  data.status = status;
  data.decided = nowISO();
  const finalBody = newPreview != null ? newPreview : body;
  await writeFileAtomic(file, stringifyFrontmatter(data, finalBody, Object.keys(data)));
  await logActivity("approval-" + status, `${data.kind || "action"} ${status}: ${data.summary || id} (${id})`);
  return { action: status, id };
}

// Everything already proposed or applied to, as ONE JSON blob. role-scout used to read every
// file in data/proposals/ + data/applications/ (80+ reads, every run, per market) just to avoid
// re-proposing. This gives it the same answer in a single call — and, critically, exposes the
// `skip` flag so a role the user DISMISSED is never re-proposed by a scout that forgot the rule.
// A requisition id is the only STABLE identity a posting has. Titles get rewritten, URLs rotate,
// and an application recorded early often carries a placeholder role ("Cybersecurity role
// (referral)") that can never match the real posting title — which is exactly how Palo Alto's
// Domain Consultant req 47263 came back as a fresh 0.93-priority proposal after being auto-rejected
// on it. So req ids are extracted from the structured field AND mined out of prose, and matched
// independently of company+role.
const REQ_PATTERNS = [
  /\bJR[-_ ]?(\d{4,})\b/gi,          // Workday: JR-016576
  /\breq(?:uisition)?\.?\s*#?\s*(\d{3,})\b/gi, // "req 3447", "Req. 2008947"
  /\bR(\d{6,})\b/g,                  // Qualys: R0004693
  /\bjob\s*(?:id|order)?\s*#?\s*(\d{5,})\b/gi, // "job 47263"
];

const normReq = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");

// `reqField` is the explicit `req_id` frontmatter value and is AUTHORITATIVE: every token in it is
// indexed verbatim, because a bare id like "47263" matches none of the prose patterns (they require
// a "job"/"req"/"JR" lead-in, deliberately, so prose mining does not hoover up every number it
// sees). Only `texts` go through pattern matching.
function extractReqIds(reqField, ...texts) {
  const out = new Set();
  for (const tok of String(reqField || "").split(/[,;/\s]+/)) {
    const n = normReq(tok);
    if (n.length >= 3) out.add(n);
  }
  for (const t of texts) {
    const s = String(t || "");
    for (const re of REQ_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) out.add(normReq(m[0]));
    }
  }
  return [...out];
}

// What has the user been rejecting, and why? Read this BEFORE proposing so the same kind of role is
// not surfaced week after week. Counts tags, and returns the most recent free-text reasons verbatim
// because the specific wording ("VAD not vendor", "Egypt travel") carries more than the tag does.
// Words that appear in every other job title and therefore distinguish nothing. Stripping them is
// what turns "Principal / Senior Red Team Services Consultant" into the part that actually caused
// the rejection — "red team" — rather than "senior" and "consultant", which describe half the
// market and would suppress good roles.
const TITLE_NOISE = new Set([
  "senior","sr","junior","jr","principal","lead","head","chief","staff","director","vp","vice",
  "president","manager","management","engineer","engineering","consultant","consulting","specialist",
  "architect","analyst","officer","executive","associate","intern","of","and","the","for","a","an",
  // "team" is deliberately NOT here. It reads like filler ("team lead"), but it is load-bearing in
  // exactly the titles this is meant to catch — "red team", "blue team" — and listing it as noise
  // dropped the clearest signal in the data.
  "to","in","at","on","with","group","services","service","solutions","solution","technical",
  "global","regional","mea","meta","emea","apac","uae","dubai","remote","hybrid","onsite","i","ii",
  "iii","new","role","job","position","opportunity",
]);

// Turn a set of rejected titles into the terms worth avoiding: single words and adjacent pairs that
// survive the noise list. Pairs matter — "red" and "team" separately are meaningless, "red team" is
// the whole signal.
function titleTerms(titles, protectedWords = new Set()) {
  const single = {};
  const pair = {};
  for (const t of titles) {
    const words = String(t || "")
      .toLowerCase()
      .replace(/[^a-z0-9+ ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    const kept = words.filter((w) => w.length > 2 && !TITLE_NOISE.has(w));
    for (const w of kept) single[w] = (single[w] || 0) + 1;
    // Pairs come from the ORIGINAL sequence, so "red team" survives even though "team" is noise on
    // its own; a pair is only kept if at least one half is meaningful.
    for (let i = 0; i < words.length - 1; i++) {
      const a = words[i];
      const b = words[i + 1];
      if (a.length < 3 || b.length < 3) continue;
      // BOTH halves must be meaningful. Allowing one noise word produced junk like "consultant
      // client" and "cloud technical" — fragments of a title rather than the thing being rejected.
      if (TITLE_NOISE.has(a) || TITLE_NOISE.has(b)) continue;
      pair[`${a} ${b}`] = (pair[`${a} ${b}`] || 0) + 1;
    }
  }
  const rank = (o, min) =>
    Object.entries(o)
      .filter(([, n]) => n >= min)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([term, n]) => ({ term, seen: n }));
  // Pairs need only one sighting: a two-word phrase repeating at all is already specific. Single
  // words need two, or every one-off title would contribute noise.
  const pairs = [...rank(pair, 2), ...rank(pair, 1).filter((p) => p.seen === 1)];
  // A single word already carried by a pair adds nothing and is broader: with "red team" present,
  // a bare "team" would also suppress "Team Lead" roles that were never rejected.
  const inAPair = new Set(pairs.flatMap((p) => p.term.split(" ")));
  const singles = rank(single, 2).filter((s) => !inAPair.has(s.term));

  // NEVER avoid a word the user is actively targeting. Two "Product Manager" roles rejected for
  // domain would otherwise put "product" on the avoid list — and Product Management is this user's
  // primary target, so the feature would suppress precisely what they are looking for. The rejection
  // was about the specific role, not the word; criteria.md is the authority on what they want.
  const safe = (t) => !t.term.split(" ").some((w) => protectedWords.has(w));
  return [...pairs, ...singles].filter(safe).slice(0, 25);
}

async function dismissalPatterns() {
  // The user's own target roles are off-limits as avoid-terms — see titleTerms().
  let protectedWords = new Set();
  try {
    const { data } = parseFrontmatter(await fs.readFile(path.join(DATA, "criteria.md"), "utf8"));
    protectedWords = new Set(
      String(data.roles || "")
        .toLowerCase()
        .replace(/[^a-z0-9+ ]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  } catch {
    /* no criteria yet — nothing to protect */
  }
  const proposals = await readRecordDir(path.join(DATA, "proposals"));
  const dismissed = proposals.filter((p) => String(p.data.status || "").toLowerCase() === "dismissed");
  const tally = {};
  const byCompany = {};
  const reasons = [];
  const titlesByTag = {};
  for (const p of dismissed) {
    for (const t of String(p.data.dismiss_tags || "").split(/[,\s]+/).filter(Boolean)) {
      tally[t] = (tally[t] || 0) + 1;
      if (p.data.role) (titlesByTag[t] = titlesByTag[t] || []).push(String(p.data.role));
    }
    const c = canonicalCompany(p.data.company);
    if (c) byCompany[c] = (byCompany[c] || 0) + 1;
    if (String(p.data.dismiss_reason || "").trim()) {
      reasons.push({
        company: p.data.company, role: p.data.role,
        tags: p.data.dismiss_tags || "", reason: p.data.dismiss_reason,
      });
    }
  }
  return {
    dismissed_total: dismissed.length,
    with_a_recorded_reason: reasons.length,
    tag_counts: Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1])),
    // Companies dismissed 3+ times — proposing another of these needs a reason.
    repeatedly_dismissed_companies: Object.entries(byCompany)
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1])
      .map(([company, n]) => ({ company, dismissed: n })),
    recent_reasons: reasons.slice(-25),
    tags: DISMISS_TAGS,
    // The shape of role being rejected, per reason — the thing tag counts alone could never say.
    // "domain: 8" tells a scout nothing actionable; "domain: red team, pentest, DEX" tells it
    // exactly what to stop surfacing. Titles are returned verbatim alongside the extracted terms,
    // because a human-readable list is what lets a judgement call be made about an edge case.
    //
    // `domain` and `location` are called out as DO NOT PROPOSE rather than merely "evidence":
    // those two are statements about the user, not about one posting. Someone who is not a red
    // teamer this week is not one next week either, whereas a `comp` or `dead` rejection says
    // nothing about the next role with the same title.
    rejected_role_shapes: Object.fromEntries(
      Object.entries(titlesByTag)
        // ONLY the tags where the TITLE is what was wrong.
        //
        // `location` is the trap: those roles were rejected for where they are, not what they are.
        // Mining their titles produced "avoid: threat intelligence" from a Threat Intelligence
        // Consultant that was simply in the wrong city — which would have suppressed exactly the
        // kind of role the user wants. `dead` is link rot and `duplicate` is bookkeeping; neither
        // says anything about the shape of the job. `company` is already covered by
        // repeatedly_dismissed_companies.
        .filter(([tag]) => tag === "domain" || tag === "seniority")
        .map(([tag, titles]) => [
          tag,
          {
            label: DISMISS_TAGS[tag] || tag,
            // `domain` is a statement about the user, not the posting: someone who is not a red
            // teamer this week will not be one next week. `seniority` is softer — a title can be
            // the right shape at the wrong level — so it stays advisory.
            treat_as: tag === "domain" ? "do-not-propose" : "evidence",
            count: titles.length,
            avoid_terms: titleTerms(titles, protectedWords).map((x) => x.term),
            titles: [...new Set(titles)],
          },
        ])
    ),
  };
}

// The digest needs company, role and the EXACT posting URL for the roles a run just found. It used
// to assemble that by reading the proposal files itself, which is how a plausible-but-wrong link
// reaches a phone: the user taps it to apply and lands on the wrong job, or nothing.
//
// So the URL comes from here, verbatim, and never from anything reconstructed. Note that query
// strings are preserved: `?gh_jid=` is Greenhouse's job id, not tracking, and stripping it breaks
// the link entirely.
//
//   node server/record.mjs list-proposals [--since <iso-or-date>] [--limit N] [--status s]
async function listProposals({ since = null, limit = 0, status = "proposed" } = {}) {
  const records = await readRecordDir(path.join(DATA, "proposals"));
  let rows = records.map((r) => r.data).filter((d) => d && d.id);

  if (status && status !== "any") rows = rows.filter((d) => String(d.status || "") === status);
  if (since) {
    const cut = String(since).slice(0, 10);
    rows = rows.filter((d) => String(d.found_date || "").slice(0, 10) >= cut);
  }
  // A repost of something already applied to is not a new posting; the digest must not offer it.
  rows = rows.filter((d) => !d.repost_of);

  rows.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  if (limit > 0) rows = rows.slice(0, limit);

  return {
    count: rows.length,
    proposals: rows.map((d) => ({
      id: d.id,
      company: d.company || "",
      role: d.role || "",
      location: d.location || "",
      priority: Number(d.priority || 0),
      found_date: d.found_date || "",
      // Verbatim. Do not normalise, shorten or strip parameters.
      job_url: d.job_url || "",
    })),
  };
}

async function listKeys() {
  const applications = await readRecordDir(path.join(DATA, "applications"));
  const proposals = await readRecordDir(path.join(DATA, "proposals"));
  // An application means "already in flight or already closed" — never re-propose that role. This
  // flag did not exist before: only proposals carried `skip`, so a REJECTED application was
  // invisible to a scout unless it happened to guess the same role wording.
  const appRows = applications.map((a) => {
    const st = String(a.data.status || "").toLowerCase();
    const isApp = String(a.data.kind || "").toLowerCase() === "application";
    const closed = ["rejected", "withdrawn", "dismissed"].includes(st);
    return {
      key: appKey(a.data.company, a.data.role),
      id: a.data.id, company: a.data.company, role: a.data.role,
      kind: a.data.kind, status: a.data.status,
      req_ids: extractReqIds(a.data.req_id, a.data.job_url, a.data.role, a.data.next_action, a.body),
      skip: isApp || closed,
      skip_reason: isApp
        ? `already applied (status ${a.data.status})`
        : closed
          ? `closed as ${a.data.status}`
          : "",
    };
  });
  // Reposts: the same job listed again under a new requisition id and often a reworded title, so
  // neither the company+role key nor seen_req_ids catches it. Compared against the user's real
  // applications and reported, never auto-dismissed — "is this the same job?" is a judgement about
  // the employer's intent, so it is the user's call (AGENT-RULES §6).
  const reqIndexOf = (r) => extractReqIds(r.req_id, r.job_url, r.role, r.next_action);
  const appData = applications.map((a) => a.data);
  const propRows = proposals.map((p) => {
    const repost = ["dismissed", "applied"].includes(String(p.data.status || "").toLowerCase())
      ? null
      : findRepost(p.data, appData, { reqIndex: reqIndexOf });
    return {
      key: appKey(p.data.company, p.data.role),
      id: p.data.id, company: p.data.company, role: p.data.role,
      status: p.data.status, job_url: p.data.job_url, verified: p.data.verified,
      req_ids: extractReqIds(p.data.req_id, p.data.job_url, p.data.role, p.body),
      // Do not re-propose these: the user dismissed it, or it is already in flight.
      skip: ["dismissed", "applied"].includes(String(p.data.status || "").toLowerCase()),
      repost_of: repost,
    };
  });
  // Flat req-id index: "have I already touched this exact requisition, under ANY title?" One lookup,
  // no title matching. Check this BEFORE proposing anything.
  const seen_req_ids = {};
  for (const r of [...appRows, ...propRows]) {
    for (const rid of r.req_ids) {
      if (!seen_req_ids[rid]) seen_req_ids[rid] = [];
      seen_req_ids[rid].push({ id: r.id, company: r.company, status: r.status, skip: r.skip });
    }
  }
  return { applications: appRows, proposals: propRows, seen_req_ids };
}

// ---- spend ----
//
// What a run COST was never recorded anywhere: the log printed the budget LIMIT ("budget $10") and
// then nothing, so there was no way to answer "what is this costing me" or to enforce a ceiling
// across runs. `claude -p --output-format json` returns total_cost_usd, and job-run.sh now writes it
// here.
//
// A plain Markdown table, like every other log in this project, so it is readable and editable by
// hand and needs no new machinery.
const SPEND_FILE = path.join(DATA, "spend.md");
const SPEND_TEMPLATE =
  "# Spend\n\n" +
  "One row per run. `cost_usd` comes from `claude -p --output-format json` (`total_cost_usd`).\n" +
  "History starts the day capture was added — earlier runs were never measured.\n\n" +
  "| date | started | cost_usd | outcome | detail |\n" +
  "|------|---------|----------|---------|--------|\n";

async function addSpend(input) {
  const obj = typeof input === "string" ? JSON.parse(input) : input;
  await ensureTable(SPEND_FILE, SPEND_TEMPLATE);
  const started = obj.started || new Date().toISOString();
  const cost = Number(obj.cost_usd || 0);
  await appendTableRow(SPEND_FILE, {
    date: String(started).slice(0, 10),
    started,
    // Fixed 4dp: a run can legitimately cost fractions of a cent, and floating point noise in a
    // table nobody can read helps nobody.
    cost_usd: cost.toFixed(4),
    outcome: sanitizeCell(obj.outcome || ""),
    detail: sanitizeCell(obj.detail || ""),
  });
  return { action: "recorded", cost_usd: Number(cost.toFixed(4)) };
}

// Totals the caller needs to decide whether to run at all, plus recent history for the dashboard.
//   node server/record.mjs list-spend [--month YYYY-MM] [--limit N]
async function listSpend({ month = null, limit = 10 } = {}) {
  let rows = [];
  try {
    rows = (await readTable(SPEND_FILE)).rows;
  } catch {
    /* no ledger yet — that is a valid, empty answer */
  }
  const m = month || new Date().toISOString().slice(0, 7);
  const inMonth = rows.filter((r) => String(r.date || "").startsWith(m));
  const sum = (list) => list.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0);
  const recent = rows.slice(-Math.max(1, limit)).reverse();
  return {
    month: m,
    month_total_usd: Number(sum(inMonth).toFixed(4)),
    month_runs: inMonth.length,
    all_time_usd: Number(sum(rows).toFixed(4)),
    runs_recorded: rows.length,
    recent: recent.map((r) => ({
      date: r.date,
      started: r.started,
      cost_usd: Number(r.cost_usd) || 0,
      outcome: r.outcome || "",
      detail: r.detail || "",
    })),
  };
}

// ---- watermarks ----
// "What had I already seen last time?" for each channel, in one place. chat-tracker had its own
// data/.chat-watermark.md while inbox-tracker inferred its window by eyeballing the newest date
// in communications.md — same concept, two mechanisms, one of them guesswork. Both now read and
// write here, so a run's cutoff is explicit and auditable.
const WATERMARK_FILE = path.join(DATA, "watermarks.md");

async function readWatermarks() {
  await ensureTable(WATERMARK_FILE, "# Watermarks\n\nLast successful sweep per channel (ISO). Written by the trackers via record.mjs.\n\n| channel | timestamp | note |\n|---------|-----------|------|\n");
  const { rows } = await readTable(WATERMARK_FILE);
  return rows;
}

async function getWatermark(channel) {
  const rows = await readWatermarks();
  const hit = rows.find((r) => r.channel === channel);
  if (hit) return { channel, timestamp: hit.timestamp, note: hit.note || "", source: "watermarks" };
  // Back-compat: chat-tracker's original standalone file, so the first run after this change
  // does not re-sweep history it already covered.
  if (channel === "whatsapp" || channel === "linkedin" || channel === "chat") {
    try {
      const legacy = (await fs.readFile(path.join(DATA, ".chat-watermark.md"), "utf8")).trim().split("\n").pop().trim();
      if (legacy) return { channel, timestamp: legacy, note: "from legacy .chat-watermark.md", source: "legacy" };
    } catch { /* none */ }
  }
  return { channel, timestamp: null, note: "no watermark — treat as first run", source: "none" };
}

async function setWatermark(channel, timestamp, note) {
  if (!channel || !timestamp) throw new Error("Usage: set-watermark <channel> <iso-timestamp> [note]");
  const rows = await readWatermarks();
  const text = await fs.readFile(WATERMARK_FILE, "utf8");
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l));
  const existing = rows.findIndex((r) => r.channel === channel);
  const row = `| ${channel} | ${sanitizeCell(timestamp)} | ${sanitizeCell(note || "")} |`;
  if (existing >= 0) {
    // Row order in the file matches row order from parseTable, offset by header + separator.
    lines[headerIdx + 2 + existing] = row;
  } else {
    lines.splice(headerIdx + 2, 0, row);
  }
  await writeFileAtomic(WATERMARK_FILE, lines.join("\n"));
  return { action: "set", channel, timestamp };
}

// ---- ATS / careers-board registry ----
// Why this exists: role-scout's expensive step is not judging a role, it is FINDING the board —
// hunting a careers site, guessing an ATS slug, then discovering the board is JS-only, 403s a
// script, or does not exist at all. That work was being redone from scratch every run. Worse, its
// most valuable product is the NEGATIVE result ("Varonis has no discoverable Greenhouse board",
// "Akamai 403s curl", "Thales' API 500s on every parameter shape") — knowledge that is expensive
// to earn, cheap to store, and invisible in chronological prose notes.
//
// So: docs/boards.md keeps the prose quirks that need paragraphs (rotating tokens, SPA hazards),
// and THIS holds the structured half — one row per company, looked up BEFORE scouting and written
// back AFTER, so each run starts from what the last one learned instead of rediscovering it.
//
// `access` is the whole point of the table:
//   json    — a stateless JSON endpoint works (cheapest; prefer these)
//   html    — stateless HTML fetch works, needs parsing
//   browser — JS-rendered or session-walled; needs Chrome, so it is useless to a headless run
//   blocked — actively rejects scripted access (403 / 500 / TLS mismatch)
//   none    — no discoverable board exists (do not go looking again)
//   manual  — the USER pasted this URL in the dashboard because we could not find it. Not yet
//             verified by a scout: try it FIRST next run, then reclassify to json/html/browser/…
//   pending — a company was just added and scripts/discover-board.mjs is probing for its board.
//             Transient: it becomes json/html/blocked/none within seconds. If a row is still
//             `pending` minutes later, discovery died — treat it as unknown and investigate.
const BOARDS_FILE = path.join(DATA, "boards.md");
// `dismissed` holds the date a board was written off, or "" for a live one. A date rather than a
// flag because "when did we give up on this" is the thing you actually want to know later.
const BOARD_HEADERS = ["company", "market", "ats", "endpoint", "access", "volatile", "last_verified", "notes", "dismissed"];
const BOARD_ACCESS = new Set(["json", "html", "browser", "blocked", "none", "manual", "pending"]);
const BOARDS_TEMPLATE =
  "# ATS / careers-board registry\n\n" +
  "One row per company: where its board is and whether a stateless run can read it. Written by\n" +
  "role-scout via `record.mjs upsert-board`, read via `get-board` / `list-boards`. Prose quirks\n" +
  "(rotating tokens, SPA hazards) live in docs/boards.md.\n\n" +
  "`access`: json = stateless JSON works · html = stateless HTML works · browser = needs Chrome ·\n" +
  "blocked = rejects scripts (403/500/TLS) · none = no board exists.\n\n" +
  `| ${BOARD_HEADERS.join(" | ")} |\n|${BOARD_HEADERS.map(() => "---").join("|")}|\n`;

function boardKey(company) {
  return String(company || "")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|gmbh|corp|co|the|group|software|technologies|networks|security)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

// The registry predates the `dismissed` column, so its header row has to be upgraded in place the
// first time we touch it. Rows are left alone: the column is last, so an 8-cell row reads as
// dismissed:"" — a live board, which is the correct default.
async function migrateBoardHeader() {
  let text;
  try {
    text = await fs.readFile(BOARDS_FILE, "utf8");
  } catch {
    return; // no file yet; the template already has the column
  }
  const lines = text.split("\n");
  const h = lines.findIndex((l) => /^\s*\|\s*company\s*\|/.test(l));
  if (h < 0 || /\|\s*dismissed\s*\|/.test(lines[h])) return;
  lines[h] = `| ${BOARD_HEADERS.join(" | ")} |`;
  lines[h + 1] = `|${BOARD_HEADERS.map(() => "---").join("|")}|`;
  await writeFileAtomic(BOARDS_FILE, lines.join("\n"));
}

async function readBoards() {
  await migrateBoardHeader();
  await ensureTable(BOARDS_FILE, BOARDS_TEMPLATE);
  const { rows } = await readTable(BOARDS_FILE);
  return rows;
}

async function getBoard(company) {
  if (!company) throw new Error("Usage: get-board <company>");
  const rows = await readBoards();
  const key = boardKey(canonicalCompany(company));
  const hit = rows.find((r) => boardKey(canonicalCompany(r.company)) === key);
  if (!hit) return { found: false, company, hint: "unknown board — discover it, then upsert-board" };
  return { found: true, ...hit };
}

async function listBoards(access, { includeDismissed = false } = {}) {
  const all = await readBoards();
  // Dismissed boards are invisible to scouts by default. They stay in the file so the decision is
  // recoverable and auditable, but they must not reappear as work.
  const rows = includeDismissed ? all : all.filter((r) => !String(r.dismissed || "").trim());
  // `needs-browser` is the queue that matters operationally: boards that exist but refuse scripted
  // access (blocked) or are JS-rendered (browser). They are NOT dead ends — they are work waiting
  // for a Chrome-enabled run. See AGENT-RULES §12.
  const filtered =
    access === "needs-browser"
      ? rows.filter((r) => r.access === "blocked" || r.access === "browser")
      : access
        ? rows.filter((r) => r.access === access)
        : rows;
  // Compact by design: a scout loads this once at start instead of reading prose per company.
  return {
    count: filtered.length,
    by_access: rows.reduce((a, r) => ((a[r.access || "unknown"] = (a[r.access || "unknown"] || 0) + 1), a), {}),
    boards: filtered.map((r) => ({
      company: r.company,
      ats: r.ats,
      endpoint: r.endpoint,
      access: r.access,
      volatile: r.volatile,
      last_verified: r.last_verified,
      notes: r.notes,
    })),
  };
}

// node server/record.mjs dismiss-board '<company>' [reason]   -> stop surfacing it
// node server/record.mjs restore-board '<company>'             -> bring it back
async function setBoardDismissed(company, dismissed, reason = "") {
  if (!company) throw new Error("needs a company name");
  const rows = await readBoards();
  const key = boardKey(canonicalCompany(company));
  const row = rows.find((r) => boardKey(canonicalCompany(r.company)) === key);
  if (!row) throw new Error(`no board row for ${JSON.stringify(company)}`);
  const note = reason ? `${today()} ${dismissed ? "dismissed" : "restored"}: ${reason}` : "";
  await upsertBoard({
    company: row.company,
    dismissed: dismissed ? today() : "",
    notes: note ? `${row.notes ? row.notes + " · " : ""}${note}` : row.notes,
  });
  return { action: dismissed ? "dismissed" : "restored", company: row.company };
}

async function upsertBoard(obj) {
  if (!obj?.company) throw new Error("upsert-board needs at least {company, access}");
  if (obj.access && !BOARD_ACCESS.has(obj.access)) {
    throw new Error(`access must be one of: ${[...BOARD_ACCESS].join(", ")}`);
  }
  const rows = await readBoards();
  const company = canonicalCompany(obj.company);
  const key = boardKey(company);
  const idx = rows.findIndex((r) => boardKey(canonicalCompany(r.company)) === key);
  const prev = idx >= 0 ? rows[idx] : {};
  // Incoming fields win where provided; everything else is preserved, so a scout that only
  // learned "this one is blocked" does not wipe an endpoint someone else established.
  const merged = {
    company,
    market: obj.market ?? prev.market ?? "",
    ats: obj.ats ?? prev.ats ?? "",
    endpoint: obj.endpoint ?? prev.endpoint ?? "",
    access: obj.access ?? prev.access ?? "",
    volatile: obj.volatile ?? prev.volatile ?? "no",
    last_verified: obj.last_verified ?? today(),
    notes: obj.notes ?? prev.notes ?? "",
    // Sticky on purpose: a scout re-probing this company must never undismiss it -- that is the
    // whole point of removing it. Only an explicit dismissed:"" (Restore) clears it.
    dismissed: obj.dismissed ?? prev.dismissed ?? "",
  };
  const text = await fs.readFile(BOARDS_FILE, "utf8");
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l));
  const row = `| ${BOARD_HEADERS.map((h) => sanitizeCell(merged[h])).join(" | ")} |`;
  if (idx >= 0) {
    lines[headerIdx + 2 + idx] = row;
  } else {
    lines.splice(headerIdx + 2, 0, row);
  }
  await writeFileAtomic(BOARDS_FILE, lines.join("\n"));
  return { action: idx >= 0 ? "updated" : "created", company, access: merged.access };
}

function stripEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_") || k === "notes" || k === "rationale") continue;
    if (v !== "" && v != null) out[k] = v;
  }
  return out;
}

function parseArg(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Expected a JSON argument. Got: " + String(raw).slice(0, 80));
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  // Every command below is a read-modify-write over shared files, so the whole dispatch runs
  // under ONE lock — held here at the top rather than inside each command, because commands
  // call logActivity() (another write) and a nested acquire would deadlock.
  const result = await withLock(() => dispatch(cmd, rest));
  process.stdout.write(JSON.stringify(result) + "\n");
}

async function dispatch(cmd, rest) {
  let result;
  switch (cmd) {
    case "upsert-application":
      result = await upsertApplication(parseArg(rest[0]));
      break;
    case "upsert-proposal":
      result = await upsertProposal(parseArg(rest[0]));
      break;
    case "supersede-lead":
      result = await supersedeLead(rest[0], rest[1], rest.slice(2).join(" ").trim() || undefined);
      break;
    case "dismiss-advance":
      result = await dismissAdvance(rest[0], rest.slice(1).join(" ").trim() || undefined);
      break;
    case "advance-app-stage":
      result = await advanceAppStage(rest[0], rest.slice(1).join(" ").trim() || undefined);
      break;
    case "add-communication":
      result = await addCommunication(parseArg(rest[0]));
      break;
    case "add-contact":
      result = await addContact(parseArg(rest[0]));
      break;
    case "add-task":
      result = await addTask(parseArg(rest[0]));
      break;
    case "add-approval":
      result = await addApproval(parseArg(rest[0]));
      break;
    case "complete-task":
      result = await setTaskStatus(rest[0], "done", rest.slice(1).join(" "));
      break;
    case "task-status":
      result = await setTaskStatus(rest[0], rest[1], rest.slice(2).join(" "));
      break;
    case "approve":
      result = await setApprovalStatus(rest[0], "approved");
      break;
    case "reject":
      result = await setApprovalStatus(rest[0], "rejected");
      break;
    case "edit-approval":
      result = await setApprovalStatus(rest[0], "edited", rest.slice(1).join(" "));
      break;
    case "log":
      await logActivity(rest[0] || "note", rest.slice(1).join(" "));
      result = { action: "logged" };
      break;
    case "dismissal-patterns":
      result = await dismissalPatterns();
      break;
    case "list-keys":
      result = await listKeys();
      break;
    case "list-proposals": {
      const flag = (name, dflt = null) => {
        const i = rest.indexOf(name);
        return i >= 0 && rest[i + 1] ? rest[i + 1] : dflt;
      };
      result = await listProposals({
        since: flag("--since"),
        limit: Number(flag("--limit", 0)) || 0,
        status: flag("--status", "proposed"),
      });
      break;
    }
    case "add-spend":
      result = await addSpend(rest[0]);
      break;
    case "list-spend": {
      const f = (n, d = null) => {
        const i = rest.indexOf(n);
        return i >= 0 && rest[i + 1] ? rest[i + 1] : d;
      };
      result = await listSpend({ month: f("--month"), limit: Number(f("--limit", 10)) || 10 });
      break;
    }
    case "get-watermark":
      result = await getWatermark(rest[0]);
      break;
    case "set-watermark":
      result = await setWatermark(rest[0], rest[1], rest.slice(2).join(" "));
      break;
    case "dismiss-board":
      result = await setBoardDismissed(rest[0], true, rest[1] || "");
      break;
    case "restore-board":
      result = await setBoardDismissed(rest[0], false, rest[1] || "");
      break;
    case "get-board":
      result = await getBoard(rest.join(" ").trim());
      break;
    case "list-boards":
      result = await listBoards(
        rest.find((a) => !a.startsWith("--")),
        { includeDismissed: rest.includes("--include-dismissed") }
      );
      break;
    case "upsert-board":
      result = await upsertBoard(parseArg(rest[0]));
      break;
    default:
      throw new Error(
        "Unknown command: " + cmd + ". See header of server/record.mjs for usage."
      );
  }
  return result;
}

// Run the CLI ONLY when this file is the process entry point. Without this guard, any module that
// imports something from here (the dashboard imports DISMISS_TAGS) executes the CLI on import — with
// no argv, so it exits 1 and takes the importing process down with it.
// Run main() only when invoked as a command, so importing this module (dashboard.mjs does) does
// not execute a CLI dispatch. Compare REAL paths: Node resolves module specifiers through symlinks
// before setting import.meta.url, but argv[1] is left exactly as the caller typed it. On macOS
// /var -> /private/var, so an absolute invocation under a temp dir made the two differ, this guard
// went false, and record.mjs exited 0 having silently written NOTHING. Every write was lost with no
// error anywhere — the exact failure mode the data/ lock exists to prevent.
const realArgv = (() => {
  try {
    return fsSync.realpathSync(process.argv[1] || "");
  } catch {
    return path.resolve(process.argv[1] || "");
  }
})();
const isEntryPoint = Boolean(process.argv[1]) && realArgv === fsSync.realpathSync(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main().catch((e) => {
    process.stderr.write("record.mjs error: " + (e?.message || e) + "\n");
    process.exit(1);
  });
}
