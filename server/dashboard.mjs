#!/usr/bin/env node
// Tiny local dashboard for the job-seeker agent layer. One file, Node built-ins only.
// Reads data/*.md (the source of truth) and renders a single self-contained page.
// Writes a handful of things back: criteria, a new market, manual tasks/contacts, and the
// uploaded CV. Agent-driven actions (curate/apply/track/followup/parse-cv) stay as Claude
// Code slash commands — this server never runs the agents.

import http from "http";
import { promises as fs, default as fsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, execFile } from "child_process";
import {
  parseFrontmatter,
  stringifyFrontmatter,
  readRecordDir,
  readTable,
  appendTableRow,
  sanitizeCell,
  newId,
  writeFileAtomic,
} from "./md.mjs";
import { withLock } from "./lock.mjs";
import { findRepost, setCompanyAliases} from "./match.mjs";
import { companyAliases } from "./config.mjs";
import { DISMISS_TAGS } from "./record.mjs";

setCompanyAliases(await companyAliases());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// Overridable so the dashboard can be run against the sample dataset — for demos, for the
// screenshots in README.md, and for anyone evaluating the project without their own data. The real
// data/ directory is gitignored and holds a live job search; nothing from it should ever end up in
// a public artefact.
const DATA = process.env.JOBSEEKER_DATA_DIR
  ? path.resolve(process.env.JOBSEEKER_DATA_DIR)
  : path.join(ROOT, "data");
const CONFIG = path.join(ROOT, "config", "job-seeker.config.md");
const CV_DIR = path.join(ROOT, "templates", "cv");
const PUBLIC = path.join(ROOT, "public");

// Brand assets, served from public/. An explicit allowlist rather than a static file handler:
// this server has no other GET surface, and a literal map cannot be path-traversed.
const ASSETS = new Map([
  ["/favicon.ico", ["favicon.ico", "image/x-icon"]],
  ["/favicon-16.png", ["favicon-16.png", "image/png"]],
  ["/favicon-32.png", ["favicon-32.png", "image/png"]],
  ["/favicon-48.png", ["favicon-48.png", "image/png"]],
  ["/apple-touch-icon.png", ["apple-touch-icon.png", "image/png"]],
  ["/logo.webp", ["logo.webp", "image/webp"]],
  ["/logo.png", ["logo.png", "image/png"]],
]);

// Cache buster derived from the icon files themselves. These are served with max-age=86400, which
// is right for a file that almost never changes and wrong on the day it does: a regenerated logo
// stayed invisible for 24 hours behind a normal reload, so a fixed icon looked like a fix that had
// not been applied. Stamping mtime+size into the URL means regenerating the set changes the URL,
// and the long cache stays safe. Computed once at startup — these cannot change under a running
// server without someone re-running the generator, and they would restart it to see the result.
const ASSET_V = (() => {
  let h = 0;
  for (const [, [file]] of ASSETS) {
    try {
      const s = fsSync.statSync(path.join(PUBLIC, file));
      h = (h * 33 + s.size + Math.floor(s.mtimeMs)) >>> 0;
    } catch {
      /* a missing icon is not worth failing startup over */
    }
  }
  return h.toString(36);
})();
const v = (p) => `${p}?v=${ASSET_V}`;

// The logo lockup: the mark is the only image — "Job Seeker" stays live HTML text so it
// recolours with the theme, stays selectable, and costs nothing to render.
const BRAND = (title) => `<div class="brand">
  <picture>
    <source srcset="${v("/logo.webp")}" type="image/webp">
    <img class="mark" src="${v("/logo.png")}" width="32" height="32" alt="" decoding="async">
  </picture>
  <h1>${title}</h1>
</div>`;

const HEAD_ICONS = `<link rel="icon" href="${v("/favicon.ico")}" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="${v("/favicon-32.png")}">
<link rel="icon" type="image/png" sizes="16x16" href="${v("/favicon-16.png")}">
<link rel="apple-touch-icon" href="${v("/apple-touch-icon.png")}">
<meta name="theme-color" content="#0f1220">`;

// The ATS/careers-board registry (see server/record.mjs and AGENT-RULES §12). Mirrored here rather
// than shelling out to record.mjs: handlePost already holds the data/ lock, and record.mjs takes
// the same lock at startup, so spawning it from inside a POST would deadlock until the timeout.
const BOARDS_FILE = path.join(DATA, "boards.md");
const BOARD_HEADERS = ["company", "market", "ats", "endpoint", "access", "volatile", "last_verified", "notes"];
const BOARDS_TEMPLATE =
  "# ATS / careers-board registry\n\n" +
  "One row per company: where its board is and whether a stateless run can read it. Written by\n" +
  "role-scout via `record.mjs upsert-board`, read via `get-board` / `list-boards`. Prose quirks\n" +
  "(rotating tokens, SPA hazards) live in docs/boards.md.\n\n" +
  "`access`: json = stateless JSON works · html = stateless HTML works · browser = needs Chrome ·\n" +
  "blocked = rejects scripts (403/500/TLS) · none = no board exists · manual = URL you pasted, awaiting verification.\n\n" +
  `| ${BOARD_HEADERS.join(" | ")} |\n|${BOARD_HEADERS.map(() => "---").join("|")}|\n`;

function boardKey(company) {
  return String(company || "")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|gmbh|corp|co|the|group|software|technologies|networks|security)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

// Access verdicts that mean "we could NOT read this company's board" — the ones worth surfacing to
// the user, because a pasted URL is the only thing that unblocks them.
const BOARD_UNREADABLE = { none: "no board found", blocked: "blocked to scripts", browser: "needs a browser" };
// Not a failure — a company was just added and discover-board.mjs is probing. Shown so the row does
// not look broken while it resolves (it becomes json/html/blocked/none within seconds).
const BOARD_PENDING_LABEL = "looking up the board…";

// ---------- config ----------

async function loadConfig() {
  try {
    const { data } = parseFrontmatter(await fs.readFile(CONFIG, "utf8"));
    return data;
  } catch {
    return {};
  }
}

// ---------- data loading ----------

async function loadAll() {
  const [criteriaRaw, profileRaw] = await Promise.all([
    safeRead(path.join(DATA, "criteria.md")),
    safeRead(path.join(DATA, "profile.md")),
  ]);
  const criteria = parseFrontmatter(criteriaRaw);
  const profile = parseFrontmatter(profileRaw);
  const [applications, proposals, approvals] = await Promise.all([
    readRecordDir(path.join(DATA, "applications")),
    readRecordDir(path.join(DATA, "proposals")),
    readRecordDir(path.join(DATA, "approvals")),
  ]);
  const [tasks, communications, contacts, activity, boards] = await Promise.all([
    readTable(path.join(DATA, "tasks.md")),
    readTable(path.join(DATA, "communications.md")),
    readTable(path.join(DATA, "contacts.md")),
    readTable(path.join(DATA, "activity.md")),
    readTable(BOARDS_FILE),
  ]);
  const markets = await loadMarkets();
  // scripts/job-run.sh writes this. A failed scheduled run is otherwise invisible, so Today shows it.
  let lastRun = null;
  try {
    lastRun = JSON.parse(await fs.readFile(path.join(DATA, ".job-run.status.json"), "utf8"));
  } catch {
    /* never run, or the file predates the status machinery */
  }
  // scripts/browser-probe.mjs writes this before every run. Surfaced because browser-only work
  // fails QUIETLY: WhatsApp and LinkedIn simply go unread and the run still reports success.
  let browser = null;
  try {
    browser = JSON.parse(await fs.readFile(path.join(DATA, ".browser-status.json"), "utf8"));
  } catch {
    /* probe has not run yet */
  }
  // /job-run writes the digest here BEFORE trying to deliver it, with a `delivered:` /
  // `not-delivered: <reason>` first line. If the push failed the digest still exists — surfacing it
  // here is what stops a failed send becoming a silently missing update (it happened three days
  // running before anyone noticed).
  let lastDigest = null;
  try {
    const raw = await fs.readFile(path.join(DATA, ".last-digest.md"), "utf8");
    const m = /^(delivered|not-delivered):\s*(.*)$/m.exec(raw);
    lastDigest = {
      delivered: m ? m[1] === "delivered" : null,
      reason: m ? m[2].trim() : "",
      body: raw.replace(/^(delivered|not-delivered):.*$/m, "").trim(),
    };
  } catch {
    /* no digest yet */
  }
  return {
    criteria,
    profile,
    applications,
    proposals,
    approvals,
    tasks,
    communications,
    contacts,
    activity,
    markets,
    boards,
    lastRun,
    browser,
    status: await systemStatus(),
    lastDigest,
    tab: "",
  };
}

async function loadMarkets() {
  const dir = path.join(DATA, "markets");
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    if (!f.endsWith(".md") || f.startsWith(".")) continue;
    const p = path.join(dir, f);
    const table = await readTable(p);
    // Two spellings of the same market exist: the FILENAME ("consulting-big4") and the display name
    // the prioritization-agent writes into the heading and into boards.md ("Consulting - Big 4").
    // Carry both — the filename is the stable key, the heading is what a person should read.
    let label = "";
    try {
      const m = /^#\s*Market:\s*(.+)$/m.exec(await fs.readFile(p, "utf8"));
      if (m) label = m[1].trim();
    } catch {}
    out.push({ name: f.replace(/\.md$/, ""), label: label || f.replace(/\.md$/, ""), table });
  }
  return out;
}

async function safeRead(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

// ---------- rendering ----------

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const STATUSES = [
  "Saved",
  "Applied",
  "Screening",
  "Interview 1",
  "Interview 2",
  "Interview 3",
  "Interview 4",
  "Offer",
  "Rejected",
  "Withdrawn",
];
// Legacy "Interview" (no number) counts as "Interview 1" for the board/forward-only ranking.
const statusIndex = (s) => {
  const i = STATUSES.indexOf(s === "Interview" ? "Interview 1" : s);
  return i < 0 ? -1 : i;
};

// Cells holding a bare date (or ISO timestamp) must not wrap mid-value — "2026-07-17" breaking
// across two lines is unreadable and it happens as soon as a column gets squeezed. Detected by
// value rather than column position so it holds for every table, whatever its headers are.
const DATEISH = /^\s*\d{4}-\d{2}-\d{2}([T\s]|$)/;
function cellCls(v) {
  return DATEISH.test(String(v ?? "")) ? ' class="nw"' : "";
}

// Market research prose runs to hundreds of characters. Left alone it consumes the whole table
// width and squeezes every other column into an unreadable vertical ribbon, so long values are
// clamped to a few lines with the full text available on hover. Short values pass through untouched
// so ordinary tables are unaffected.
const CLAMP_OVER = 110;
function cell(v) {
  const raw = String(v ?? "");
  const html = linkify(raw);
  if (raw.length <= CLAMP_OVER) return html;
  return `<div class="clamp" title="${esc(raw)}">${html}</div>`;
}

function tableHTML(table, emptyMsg = "Nothing yet.") {
  if (!table.rows.length) return `<p class="empty">${esc(emptyMsg)}</p>`;
  const head = table.headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = table.rows
    .map(
      (r) =>
        `<tr>${table.headers.map((h) => `<td${cellCls(r[h])}>${cell(r[h])}</td>`).join("")}</tr>`
    )
    .join("");
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function linkify(v) {
  const s = String(v ?? "");
  if (/^https?:\/\//.test(s))
    return `<a href="${esc(s)}" target="_blank" rel="noreferrer">${esc(truncate(s, 48))}</a>`;
  return esc(s);
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Turn a stored thread_url key into a real, clickable hyperlink.
//  gmail:<threadId>  -> deep link to the Gmail thread
//  whatsapp-web:...  -> WhatsApp Web   |  linkedin-web:... -> LinkedIn messaging
//  http(s)://...     -> itself
function threadLink(t) {
  if (!t) return null;
  if (/^https?:\/\//.test(t)) return t;
  if (t.startsWith("gmail:")) return "https://mail.google.com/mail/u/0/#all/" + encodeURIComponent(t.slice(6));
  if (t.startsWith("whatsapp")) return "https://web.whatsapp.com/";
  if (t.startsWith("linkedin")) return "https://www.linkedin.com/messaging/";
  return null;
}

// Escape text but turn any embedded URLs into links (used in notes / summaries).
function linkifyText(s) {
  return String(s ?? "")
    .split(/(https?:\/\/[^\s)]+)/g)
    .map((p, i) =>
      i % 2
        ? `<a href="${esc(p)}" target="_blank" rel="noreferrer">${esc(truncate(p, 60))}</a>`
        : esc(p)
    )
    .join("");
}

// Build match tokens for an application so we can gather its related messages/tasks even when
// related_application_id wasn't set: the company name + any email domains found in contact/notes.
function appTokens(app) {
  const d = app.data;
  const text = `${d.contact || ""} ${app.body || ""}`;
  const domains = [...text.matchAll(/[\w.+-]+@([\w.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase());
  const company = (d.company || "").toLowerCase();
  const tokens = [...new Set([company, ...domains])].filter(Boolean);
  return { id: d.id, company, tokens };
}
function matchesApp(text, tok) {
  const t = String(text || "").toLowerCase();
  return tok.tokens.some((x) => x && t.includes(x));
}
const shortSummary = (a) => `${a.status || ""}${a.next_action ? " · " + a.next_action : ""}`;

// Full activity summary for one application — rendered server-side, shown in the click popup.
function detailHTML(app, allComms, allTasks) {
  const d = app.data;
  const tok = appTokens(app);
  const relComms = allComms
    .filter((c) => c.related_application_id === d.id || matchesApp(`${c.from} ${c.subject} ${c.summary} ${c.thread_url}`, tok))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const relTasks = allTasks.filter((t) => t.related_id === d.id || matchesApp(`${t.who} ${t.detail}`, tok));
  const meta = [
    ["Type", d.kind ? `<strong>${esc(d.kind === "application" ? "Application" : "Lead")}</strong>` : ""],
    ["Status", `<span class="pill s-${esc((d.status || "").toLowerCase())}">${esc(d.status)}</span>`],
    ["Dismiss reason", esc(d.dismiss_reason)],
    ["Channel", channelTag(d.channel)],
    ["Referrer / source", esc(d.referrer)],
    ["Location", esc(d.location)],
    ["Captured via", esc(d.source)],
    ["Applied", esc(d.applied_date)],
    ["Last update", esc(d.last_update)],
    ["Contact", esc(d.contact)],
    ["Next action", `${esc(d.next_action)}${d.next_action_date ? ` <span class="muted">(${esc(d.next_action_date)})</span>` : ""}`],
  ]
    .filter(([, v]) => v && v !== "")
    .map(([k, v]) => `<div class="mrow"><span class="mk">${k}</span><span class="mv">${v}</span></div>`)
    .join("");
  const jobLink = d.job_url ? `<a class="btn" href="${esc(d.job_url)}" target="_blank" rel="noreferrer">↗ Job posting</a>` : "";
  const commsList = relComms.length
    ? relComms
        .map((c) => {
          const link = threadLink(c.thread_url);
          const opener = link ? ` <a href="${esc(link)}" target="_blank" rel="noreferrer">open ↗</a>` : "";
          return `<li><span class="muted">${esc(String(c.date || "").slice(0, 10))} · ${esc(c.source)}</span> <strong>${esc(c.from)}</strong>${opener}<br>${esc(c.summary)}</li>`;
        })
        .join("")
    : `<li class="muted">No linked messages.</li>`;
  const tasksList = relTasks.length
    ? relTasks.map((t) => `<li><span class="muted">${esc(t.due_date || "—")} · ${esc(t.status)}</span> — ${esc(t.detail)}</li>`).join("")
    : `<li class="muted">No tasks.</li>`;
  const notes = app.body ? `<div class="mnote">${linkifyText(app.body)}</div>` : "";
  return `<h3>${esc(d.company)} <span class="muted">— ${esc(d.role)}</span></h3>
    ${jobLink}
    <div class="mmeta">${meta}</div>
    ${notes}
    <h4>Activity (${relComms.length})</h4><ul class="mlist">${commsList}</ul>
    <h4>Tasks (${relTasks.length})</h4><ul class="mlist">${tasksList}</ul>`;
}
function buildDetails(all) {
  const map = {};
  for (const app of all.applications) map[app.data.id] = detailHTML(app, all.communications.rows, all.tasks.rows);
  return map;
}

// Which application does a task belong to (so clicking a follow-up opens that lead's popup)?
function taskTarget(t, appTok, appIds) {
  if (t.related_id && appIds.has(t.related_id)) return t.related_id;
  const m = appTok.find((tok) => matchesApp(`${t.who} ${t.detail}`, tok));
  return m ? m.id : null;
}
function tasksHTML(rows, appTok, appIds, emptyMsg = "Nothing yet.") {
  if (!rows.length) return `<p class="empty">${esc(emptyMsg)}</p>`;
  const headers = ["due_date", "type", "who", "status", "detail"];
  const body = rows
    .map((t) => {
      const target = taskTarget(t, appTok, appIds);
      const dismissed = t.status === "dismissed";
      const cls = [target ? "clickrow" : "", t.status === "done" ? "taskdone" : "", dismissed ? "rowdismissed" : ""].filter(Boolean).join(" ");
      const attrs = `${cls ? ` class="${cls}"` : ""}${target ? ` onclick="openDetail('${esc(target)}')" title="Open activity summary"` : ""} data-status="${esc(t.status || "")}" data-type="${esc(t.type || "")}"`;
      const act = dismissed
        ? `<form method="POST" action="/set-task-status" class="prowact" onclick="event.stopPropagation()"><input type="hidden" name="id" value="${esc(t.id)}"><input type="hidden" name="status" value="open"><button type="submit" title="Restore">↺</button></form>`
        : `<form method="POST" action="/set-task-status" class="prowact" onclick="event.stopPropagation()"><input type="hidden" name="id" value="${esc(t.id)}"><input type="hidden" name="status" value="dismissed"><button type="submit" class="xbtn" title="Dismiss task">×</button></form>`;
      // Clamp long values here too. The tasks table renders raw esc() rather than cell(), so a
      // 4,161-character detail once filled the entire Today page with one row. The writer now caps
      // details at 200 chars, but the display must survive legacy rows and anything hand-edited.
      return `<tr${attrs}><td>${act}</td>${headers
        .map((h) => `<td${cellCls(t[h])}>${cell(t[h] || "")}</td>`)
        .join("")}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table><thead><tr><th></th>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// The full Tasks section: a natural-language add field, Open/Done/All filter chips + search, and the table.
function tasksSection(rows, appTok, appIds) {
  const open = rows.filter((r) => r.status === "open").length;
  const done = rows.filter((r) => r.status === "done").length;
  return `<form method="POST" action="/add-task-nl" class="nladd">
    <input name="nl" placeholder="Add a task in plain English — e.g. 'call Dana Friday about the referral'" autocomplete="off" required>
    <button type="submit">+ Add</button>
  </form>
  <p class="muted nlhint">Typed in plain English — I parse the date, who, and type into columns. The full text is kept in the detail.</p>
  <div class="taskfilters">
    <button type="button" class="tf active" data-f="open">Open (${open})</button>
    <button type="button" class="tf" data-f="done">Done (${done})</button>
    <button type="button" class="tf" data-f="dismissed">Dismissed (${rows.filter((r) => r.status === "dismissed").length})</button>
    <button type="button" class="tf" data-f="all">All (${rows.length})</button>
    <input class="tsearch" placeholder="filter text…" autocomplete="off">
  </div>
  ${tasksHTML(rows, appTok, appIds)}`;
}

// Communications table with the thread_url rendered as a real hyperlink (Gmail/LinkedIn/WhatsApp).
function commsHTML(table) {
  if (!table.rows.length) return `<p class="empty">No messages yet.</p>`;
  const body = table.rows
    .map((r) => {
      const link = threadLink(r.thread_url);
      const openCell = link ? `<a href="${esc(link)}" target="_blank" rel="noreferrer">open ↗</a>` : esc(r.thread_url || "");
      // Dates get .nw explicitly: this row is built by hand rather than through cellCls(), so
      // without it "2026-07-13" wraps to "2026-07-" / "13" and every row grows to two lines.
      return `<tr><td class="nw">${esc(String(r.date || "").slice(0, 10))}</td><td class="nw">${esc(r.source)}</td><td>${esc(r.from)}</td><td>${esc(r.subject)}</td><td>${cell(r.summary)}</td><td>${openCell}</td></tr>`;
    })
    .join("");
  return `<div class="scroll"><table><thead><tr><th>date</th><th>source</th><th>from</th><th>subject</th><th>summary</th><th>link</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

// Small colored tag for the lead/application channel.
function channelTag(ch) {
  const c = String(ch || "").toLowerCase();
  if (!c) return "";
  return `<span class="tag tag-${esc(c)}">${esc(c)}</span>`;
}

// Leads: opportunities WITHOUT confirmed-application evidence (CV sent / referral). Shows the
// referrer and the channel it came through.
function leadsHTML(leads) {
  if (!leads.length)
    return `<p class="empty">No leads yet. A CV sent or a referral (no application confirmation) is a lead.</p>`;
  const rows = leads
    .map((a) => a.data)
    .sort((x, y) => (y.last_update ?? "").localeCompare(x.last_update ?? ""))
    .map((a) => {
      const st = (a.status || "").toLowerCase();
      const dismissed = st === "dismissed";
      const act = dismissed
        ? `<form method="POST" action="/set-app-status" class="prowact" onclick="event.stopPropagation()"><input type="hidden" name="id" value="${esc(a.id)}"><input type="hidden" name="status" value="Saved"><button type="submit" title="Restore">↺</button></form>`
        : `<button type="button" class="xbtn dbtn" data-id="${esc(a.id)}" data-label="${esc(a.company + " — " + a.role)}" title="Dismiss lead (add a reason)">×</button>`;
      return `<tr class="clickrow${dismissed ? " rowdismissed" : ""}${a.pending_stage ? " rowpending" : ""}" data-status="${esc(st)}" title="${esc(shortSummary(a))}${dismissed && a.dismiss_reason ? " — dismissed: " + esc(a.dismiss_reason) : ""}" onclick="openDetail('${esc(a.id)}')">
        <td>${act}</td>
        <td>${esc(a.company)}</td>
        <td>${esc(a.role)}</td>
        <td>${channelTag(a.channel)}</td>
        <td>${esc(a.referrer)}</td>
        <td><span class="pill s-${esc(st)}">${esc(a.status)}</span>${advanceBtn(a)}</td>
        <td>${dismissed && a.dismiss_reason ? `<span class="muted">✕ ${esc(a.dismiss_reason)}</span>` : `${esc(a.next_action)}${a.next_action_date ? ` <span class="muted">(${esc(a.next_action_date)})</span>` : ""}`}</td>
        <td>${a.job_url ? `<a href="${esc(a.job_url)}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">↗ open</a>` : ""}</td>
      </tr>`;
    })
    .join("");
  return `<div class="scroll"><table>
    <thead><tr><th></th><th>Company</th><th>Role</th><th>Channel</th><th>Referrer / source</th><th>Stage</th><th>Next action</th><th>Job</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// Leads section with status filter chips (Active hides dismissed; chips generated from statuses present).
function leadsSection(leadRecords) {
  const st = (a) => (a.data.status || "").toLowerCase();
  const present = [...new Set(leadRecords.map(st).filter((s) => s && s !== "dismissed"))];
  const n = (f) => leadRecords.filter((a) => (f === "all" ? true : f === "active" ? st(a) !== "dismissed" : st(a) === f)).length;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const chip = (f, label) => `<button type="button" class="tf${f === "active" ? " active" : ""}" data-f="${f}">${label} (${n(f)})</button>`;
  return `<div class="taskfilters lfilters">
    ${chip("active", "Active")}${present.map((s) => chip(s, cap(s))).join("")}${chip("dismissed", "Dismissed")}${chip("all", "All")}
    <input class="tsearch lsearch" placeholder="filter text…" autocomplete="off">
  </div>
  ${leadsHTML(leadRecords)}`;
}

// One-click stage-advance button: shown when an agent detected evidence of progress and recorded a
// `pending_stage`. Clicking POSTs to /advance-app-stage, which applies pending_stage → status.
function advanceBtn(a) {
  if (!a.pending_stage) return "";
  const note = a.pending_note ? ` — ${a.pending_note}` : "";
  return `<form method="POST" action="/advance-app-stage" class="advform" onclick="event.stopPropagation()" title="Evidence of progress detected${esc(note)}. Click to advance to ${esc(a.pending_stage)}.">
    <input type="hidden" name="id" value="${esc(a.id)}">
    <button type="submit" class="advbtn">🔔 Advance → ${esc(a.pending_stage)}</button>
  </form>`;
}

function applicationsHTML(apps) {
  if (!apps.length) return `<p class="empty">No confirmed applications yet (needs a "received/confirmed" email).</p>`;
  const rows = apps
    .map((a) => a.data)
    .sort((x, y) => (y.last_update ?? "").localeCompare(x.last_update ?? ""))
    .map(
      (a) => `<tr class="clickrow${a.pending_stage ? " rowpending" : ""}" title="${esc(shortSummary(a))} — click for activity" onclick="openDetail('${esc(a.id)}')">
        <td>${esc(a.company)}</td>
        <td>${esc(a.role)}</td>
        <td>${esc(a.location)}</td>
        <td><span class="pill s-${esc((a.status || "").toLowerCase())}">${esc(a.status)}</span>${advanceBtn(a)}</td>
        <td>${esc(a.source)}</td>
        <td>${esc(a.next_action)}${a.next_action_date ? ` <span class="muted">(${esc(a.next_action_date)})</span>` : ""}</td>
        <td>${a.job_url ? `<a href="${esc(a.job_url)}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">↗ open</a>` : ""}</td>
      </tr>`
    )
    .join("");
  return `<div class="scroll"><table>
    <thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Status</th><th>Source</th><th>Next action</th><th>Job</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function statusBoardHTML(apps) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const a of apps) {
    const s = a.data.status === "Interview" ? "Interview 1" : a.data.status; // legacy alias
    if (counts[s] != null) counts[s]++;
  }
  return `<div class="board">${STATUSES.map(
    (s) => `<div class="col"><div class="num">${counts[s]}</div><div class="lbl">${esc(s)}</div></div>`
  ).join("")}</div>`;
}

// Normalize a company name so a proposal can be matched to your applications (company side only,
// mirrors record.mjs appKey normalization).
function normCompanyKey(name) {
  return String(name || "").toLowerCase().replace(/\b(inc|llc|ltd|gmbh|corp|co|the)\b/g, "").replace(/[^a-z0-9]+/g, "");
}

function proposalsHTML(props, appliedByCompany, reposts = {}) {
  if (!props.length) return `<p class="empty">No proposals yet. Run <code>/curate</code>.</p>`;
  const rows = props
    .map((p) => p.data)
    .sort((x, y) => Number(y.priority || 0) - Number(x.priority || 0))
    .map((p) => {
      const st = (p.status || "proposed").toLowerCase();
      // NEW = freshly found & not yet reviewed/actioned (seen != yes and still "proposed").
      const isNew = (p.seen || "no") !== "yes" && st === "proposed";
      // × opens the dismiss balloon; a dismissed row shows ↺ to restore. The per-row "mark seen"
      // eye was removed — 0 proposals ever ended up in the state it created (live + seen); the batch
      // "Mark all new as seen" is the sweep that actually gets used.
      // Dismissing asks WHY, in the same balloon used for stage advances. The tag chips are a short
      // closed list so the answers can be counted — free text alone cannot be learned from — and both
      // the tags and the note are optional, so a quick × is still one click plus OK.
      const dismissForm = `<span class="popwrap prowact">
        <button type="button" class="xbtn" aria-haspopup="dialog" aria-expanded="false"
          onclick="event.stopPropagation();popToggle('pd_${esc(p.id)}', this)" title="Dismiss this role">×</button>
        <div id="pd_${esc(p.id)}" class="pop hide" role="dialog" aria-label="Dismiss ${esc(p.company)}" onclick="event.stopPropagation()">
          <form method="POST" action="/set-proposal-status">
            <input type="hidden" name="id" value="${esc(p.id)}">
            <input type="hidden" name="status" value="dismissed">
            <p class="pop-h">Dismiss this job</p>
            <p class="pop-sub">${esc(p.company)} — ${esc(String(p.role || "").slice(0, 60))}</p>
            <div class="tagpick">${Object.entries(DISMISS_TAGS)
              .map(
                ([k, lbl]) =>
                  `<label class="tagchip"><input type="checkbox" name="tags" value="${esc(k)}"><span>${esc(lbl)}</span></label>`
              )
              .join("")}</div>
            <textarea name="reason" rows="2" placeholder="Anything to add? Optional." autocomplete="off"></textarea>
            <div class="pop-acts">
              <button type="button" class="btn-secondary" onclick="popClose('pd_${esc(p.id)}')">Cancel</button>
              <button type="submit">OK</button>
            </div>
          </form>
        </div>
      </span>`;

      const action =
        st === "dismissed"
          ? `<form method="POST" action="/set-proposal-status" class="prowact"><input type="hidden" name="id" value="${esc(p.id)}"><input type="hidden" name="status" value="proposed"><button type="submit" title="Restore">↺</button></form>`
          : dismissForm;
      const cls = [st === "dismissed" ? "pdismissed" : "", isNew ? "isnew" : ""].filter(Boolean).join(" ");
      // If you already have an application at this company, flag it (with the role(s) + stage).
      const appd = (appliedByCompany && appliedByCompany[normCompanyKey(p.company)]) || [];
      // A REPOST is the same job listed again under a new requisition id, usually reworded — the
      // exact-key and req-id checks both miss it by construction. Flagged, never auto-dismissed:
      // whether two listings are "the same job" is a judgement about the employer, so it is the
      // user's call. The × on this row is the intended action.
      const rp = st === "dismissed" || st === "applied" ? null : reposts[p.id];
      const repostBadge = rp
        ? `<div class="repostbadge ${rp.confidence === "certain" ? "rp-certain" : "rp-maybe"}"
             title="${esc(rp.why)} — matches ${esc(rp.id)} (${esc(rp.status)}): ${esc(rp.role)}">↻ Reposted${
            rp.confidence === "certain" ? "" : "?"
          } — you applied: ${esc(rp.role)}${rp.status ? ` (${esc(rp.status)})` : ""}</div>`
        : "";
      const appliedBadge = appd.length
        ? `<div class="appliedhere" title="You already have an application at this company — this is a different role">✓ Applied here: ${esc(appd.map((a) => a.role + (a.status && a.status.toLowerCase() !== "applied" ? ` (${a.status})` : "")).join("; "))}</div>`
        : "";
      return `<tr data-status="${esc(st)}" data-new="${isNew ? "yes" : "no"}"${cls ? ` class="${cls}"` : ""}>
        <td>${action}</td>
        <td>${isNew ? `<span class="newbadge">NEW</span> ` : ""}<strong>${esc(p.company)}</strong>${repostBadge}${appliedBadge}</td>
        <td>${esc(p.role)}</td>
        <td>${esc(p.location)}</td>
        <td>${esc(p.market)}</td>
        <td>${esc(p.priority ?? "")}</td>
        <td><span class="pill s-${esc(st)}">${esc(p.status)}</span></td>
        <td>${(p.verified || "no") === "yes"
          ? `<span class="vbadge vyes" title="Opened the posting & confirmed title + location">✓ verified</span>`
          : `<span class="vbadge vno" title="Not yet opened/confirmed — do not trust as live">unverified</span>`}</td>
        <td>${
          !p.job_url
            ? ""
            : (p.url_volatile || "no") === "yes"
              ? `<span class="volatile-url" title="This link uses a short-lived token that rotates and can expire silently. If it 404s, re-search the vendor careers site by location/Job ID (see proposal notes).">${linkify(p.job_url)} <span class="volatile-badge">⚠ link may expire — re-search by Job ID</span></span>`
              : linkify(p.job_url)
        }</td>
      </tr>`;
    })
    .join("");
  return `<div class="scroll"><table>
    <thead><tr><th></th><th>Company</th><th>Role</th><th>Location</th><th>Market</th><th>Priority</th><th>Status</th><th>Verified</th><th>Link</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// Proposals section: NEW-highlight + status filter chips (Active hides dismissed).
function proposalsSection(propRecords, appliedByCompany, reposts = {}) {
  const st = (p) => (p.data.status || "proposed").toLowerCase();
  const isNew = (p) => (p.data.seen || "no") !== "yes" && st(p) === "proposed";
  const n = (f) =>
    propRecords.filter((p) => (f === "all" ? true : f === "new" ? isNew(p) : f === "active" ? st(p) !== "dismissed" : st(p) === f)).length;
  const chip = (f, label) => `<button type="button" class="tf${f === "active" ? " active" : ""}" data-f="${f}">${label} (${n(f)})</button>`;
  const newCount = n("new");
  return `<div class="taskfilters pfilters">
    ${chip("active", "Active")}${chip("new", "🟢 New")}${chip("proposed", "Proposed")}${chip("applied", "Applied")}${chip("dismissed", "Dismissed")}${chip("all", "All")}
    <input class="tsearch psearch" placeholder="filter text…" autocomplete="off">
    ${newCount ? `<form method="POST" action="/mark-all-proposals-seen" style="margin:0 0 0 auto"><button type="submit" class="btn-secondary" title="Clear the NEW highlight on all roles">Mark all ${newCount} new as seen</button></form>` : ""}
  </div>
  <p class="muted nlhint">Rows highlighted <span class="newbadge">NEW</span> appeared since you last reviewed — they stay highlighted until you act, or until you mark the batch seen.</p>
  ${proposalsHTML(propRecords, appliedByCompany, reposts)}`;
}

// ---------- Companies (markets + careers boards, joined) ----------
// These were two settings pages describing ONE entity. `data/markets/*.md` answered "why this
// company" (tier, HQ, rationale) and `data/boards.md` answered "how do we read its jobs" (ats,
// access, endpoint) — 183 of the ~230 companies appeared in both, and 204 market rows carried a
// `careers_url` duplicating `boards.endpoint`. Looking a company up meant visiting both tabs and
// joining them by eye.
//
// The join is on boardKey() (the same normalisation record.mjs dedupes with), grouped by market,
// collapsible, sortable and searchable. STORAGE IS UNCHANGED: the two files keep their separate
// owners (prioritization-agent and role-scout) — merging them would touch both agents and both
// writers for no user-visible gain. `boards.endpoint` is authoritative; the market `careers_url` is
// shown only as a fallback, which was already the implicit rule.
// "Cybersecurity", "cybersecurity" and "Consulting - Big 4" vs "consulting-big4" are the same market
// spelled by two different writers. Without this the page rendered each market twice.
const marketKey = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();

function joinCompanies(all) {
  const byKey = new Map();
  const get = (name) => {
    const k = boardKey(name);
    if (!k) return null;
    if (!byKey.has(k))
      byKey.set(k, { key: k, company: name, market: "", marketFile: "", board: null, vendor: null });
    return byKey.get(k);
  };

  for (const m of all.markets ?? []) {
    for (const r of m.table.rows) {
      const e = get(r.company);
      if (!e) continue;
      e.company = r.company || e.company;
      if (!e.market) {
        e.market = m.label;
        e.marketFile = m.name; // the file the add-company form must write to
      }
      if (!e.vendor) e.vendor = r;
    }
  }
  // Dismissed boards are gone from the user's view as well as the scouts'. They remain in
  // data/boards.md with the date they were written off, so the decision is recoverable.
  for (const r of (all.boards?.rows ?? []).filter((r) => !String(r.dismissed || "").trim())) {
    const e = get(r.company);
    if (!e) continue;
    e.board = r;
    if (!e.market && r.market) {
      e.market = r.market;
      const hit = (all.markets ?? []).find((m) => marketKey(m.name) === marketKey(r.market) || marketKey(m.label) === marketKey(r.market));
      if (hit) {
        e.market = hit.label;
        e.marketFile = hit.name;
      }
    }
    // Prefer the registry's spelling once a board exists — that is the name record.mjs writes.
    e.company = r.company || e.company;
  }
  return [...byKey.values()];
}

const UNGROUPED = "Not in a market list";

// Truncate on a word boundary. A hard slice left rows ending "an exact match for the user's target
// r", which reads like corrupted data rather than a summary.
function clip(s, n) {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, "") + "…";
}

// Four states worth telling apart, and the access pill keeps them visibly separate on purpose.
// "we have not looked yet" and "there is no board" are different facts, and folding them together
// is how 53 companies got written off on a guess (AGENT-RULES §13b).
//
// ONE definition, used by both the page and the topbar banner. They used to compute this
// separately and disagreed — the banner said 55 boards needed a URL while the page said 10,
// because the banner counted `browser`/`blocked` rows that the sweep now handles by itself.
function companyState(e) {
  if (!e.board) return "unknown";
  const a = e.board.access || "";
  const hasEndpoint = Boolean(String(e.board.endpoint || "").trim());
  if (a === "pending") return "pending";
  if (a === "browser" || a === "blocked") return "queued";
  if (a === "manual") return hasEndpoint ? "manual" : "needs-url";
  if (a === "none" || !hasEndpoint) return "needs-url";
  return "readable";
}

function companiesHTML(all) {
  const entries = joinCompanies(all);
  if (!entries.length)
    return `<p class="empty">No companies yet. Add a market in <b>Criteria</b>, then run <code>/markets</code>.</p>`;

  const dismissedCount = (all.boards?.rows ?? []).filter((r) => String(r.dismissed || "").trim()).length;

  const state = companyState;
  const STATE_LABEL = {
    readable: "readable",
    queued: "queued for a browser pass",
    "needs-url": "needs a URL from you",
    manual: "you pasted this — awaiting verification",
    pending: BOARD_PENDING_LABEL,
    unknown: "not investigated yet",
  };
  const count = (s) => entries.filter((e) => state(e) === s).length;

  // Grouped by NORMALISED market, so "Cybersecurity" from boards.md and "cybersecurity.md" from the
  // market lists are one group rather than two.
  const groups = new Map();
  for (const e of entries) {
    const k = marketKey(e.market) || "~none";
    if (!groups.has(k)) groups.set(k, { label: e.market || UNGROUPED, file: e.marketFile, list: [] });
    const g = groups.get(k);
    if (!g.file && e.marketFile) g.file = e.marketFile;
    g.list.push(e);
  }
  // Markets in their configured order, then anything the market lists never claimed.
  const order = [
    ...(all.markets ?? []).map((m) => marketKey(m.name)),
    ...[...groups.keys()].filter((k) => !(all.markets ?? []).some((m) => marketKey(m.name) === k)),
  ];

  const row = (e, i) => {
    const b = e.board || {};
    const v = e.vendor || {};
    const st = state(e);
    const id = `co${i}`;
    const endpoint = String(b.endpoint || "").trim();
    const prefill = endpoint || v.careers_url || "";
    const tier = String(v.tier || "").trim();
    // Everything the search box should match, in one attribute — so filtering does not depend on
    // which columns happen to be rendered.
    const hay = [e.company, e.market, v.hq, v.why, v.notes, b.ats, b.notes, endpoint].filter(Boolean).join(" ").toLowerCase();
    return `<tr class="corow" data-name="${esc(e.company.toLowerCase())}" data-tier="${esc(tier || "9")}" data-state="${st}" data-q="${esc(hay.slice(0, 900))}">
      <td>
        <strong>${esc(e.company)}</strong>${tier ? ` <span class="pill tier tier-${esc(tier)}" title="Fit tier from the market list — 1 is strongest">T${esc(tier)}</span>` : ""}
        ${b.volatile === "yes" ? ` <span class="pill b-volatile" title="URL rotates — re-derive each run">volatile</span>` : ""}
        <div class="muted comini">${[v.hq, e.market || UNGROUPED, v.last_reviewed ? `reviewed ${v.last_reviewed}` : ""].filter(Boolean).map(esc).join(" · ")}</div>
        ${
          v.why
            ? // The prioritization-agent's full rationale (score, why this tier, what changed) lives
              // in `notes` and is far too long for a row — it hangs off the title so it is one hover
              // away rather than lost, and the search box matches it either way.
              `<div class="muted cowhy"${v.notes ? ` title="${esc(String(v.notes).slice(0, 600))}"` : ""}>${esc(clip(v.why, 160))}</div>`
            : ""
        }
      </td>
      <td>
        <span class="pill st-${st}">${esc(b.access || (st === "unknown" ? "unknown" : ""))}</span>
        <div class="muted comini">${esc(STATE_LABEL[st])}</div>
        ${b.ats ? `<div class="muted comini">${esc(b.ats)}</div>` : ""}
      </td>
      <td class="bep">${
        endpoint
          ? `<code>${esc(endpoint)}</code>`
          : st === "pending"
            ? `<span class="bpending">searching greenhouse / lever / ashby / smartrecruiters + careers pages…</span>`
            : v.careers_url
              ? `<span class="muted">from the market list: </span><code>${esc(v.careers_url)}</code>`
              : `<span class="bmissing">no board recorded</span>`
      }${b.notes ? `<div class="muted conote">${esc(clip(b.notes, 180))}</div>` : ""}</td>
      <td style="text-align:right"><span class="bacts">
        ${v.linkedin_url ? `<a class="bsearch" href="${esc(v.linkedin_url)}" target="_blank" rel="noopener" title="${esc(e.company)} on LinkedIn">in</a>` : ""}
        <a class="bsearch" href="https://duckduckgo.com/?q=${encodeURIComponent(e.company + " careers")}" target="_blank" rel="noopener"
           title="Search for ${esc(e.company)}'s own careers page — we do not store company websites, so this is a search rather than a guess">🔎</a>
        <button class="bedit" onclick="bToggle('${id}')" title="Paste the careers website for ${esc(e.company)}">✏️</button>
        ${
          e.board
            ? `<form method="POST" action="/dismiss-board" class="inline" onsubmit="return confirm('Remove ${esc(e.company).replace(/'/g, "\\'")} from the registry? It will stop appearing here and scouts will skip it. You can restore it from data/boards.md.')">
                 <input type="hidden" name="_page" value="settings"><input type="hidden" name="_tab" value="companies">
                 <input type="hidden" name="company" value="${esc(e.company)}">
                 <button type="submit" class="btrash" aria-label="Remove ${esc(e.company)}" title="No careers page exists — remove it for good"><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M6.5 1a.5.5 0 0 0-.5.5V2H3.5a.5.5 0 0 0 0 1H4v9.5A1.5 1.5 0 0 0 5.5 14h5a1.5 1.5 0 0 0 1.5-1.5V3h.5a.5.5 0 0 0 0-1H10v-.5a.5.5 0 0 0-.5-.5h-3ZM5 3h6v9.5a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5V3Zm1.5 1.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5Zm3 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5Z"/></svg></button>
               </form>`
            : ""
        }
      </span></td>
    </tr>
    <tr id="${id}" class="hide bform"><td colspan="4">
      <form method="POST" action="/set-board">
        <input type="hidden" name="company" value="${esc(e.company)}">
        <input type="hidden" name="market" value="${esc(e.market || "")}">
        <label style="display:block;font-size:12px;color:var(--mut);margin-bottom:4px">Careers website / board URL for <strong>${esc(e.company)}</strong>${
          !endpoint && v.careers_url ? ` <span class="muted">— prefilled from the market list, correct it if wrong</span>` : ""
        }</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input name="endpoint" value="${esc(prefill)}" placeholder="https://careers.example.com/jobs?location=United+Arab+Emirates" style="flex:1" autocomplete="off">
          <button type="submit">Save</button>
          <button type="button" class="btn-secondary" onclick="bToggle('${id}')">Cancel</button>
        </div>
        <p class="muted" style="font-size:11px;margin:6px 0 0">Saved as <code>manual</code> — the next scout run tries it first and reclassifies it once it knows how to read it.</p>
      </form>
    </td></tr>`;
  };

  let n = 0;
  const seen = new Set();
  const groupHTML = order
    .filter((k) => groups.has(k) && !seen.has(k) && seen.add(k) !== false)
    .map((k) => {
      const g = groups.get(k);
      // Sorted by name server-side, so the default order is right before any JavaScript runs.
      const list = g.list.slice().sort((a, b) => a.company.localeCompare(b.company));
      const attn = list.filter((e) => state(e) === "needs-url" || state(e) === "unknown").length;
      return `<details class="cogroup" data-group="${esc(g.label)}" open>
        <summary>${esc(g.label)} <span class="muted">(<span class="cocount">${list.length}</span>)</span>${
          attn ? ` <span class="warntx" style="font-size:11px">${attn} need attention</span>` : ""
        }</summary>
        ${g.file ? addCompanyFormHTML(g.file, g.label) : ""}
        <div class="scroll"><table class="btable cotable">
          <colgroup><col class="c-name"><col class="c-access"><col class="c-ep"><col class="c-act"></colgroup>
          <thead><tr><th>Company</th><th>Board access</th><th>Endpoint</th><th></th></tr></thead>
          <tbody>${list.map((e) => row(e, n++)).join("")}</tbody></table></div>
      </details>`;
    })
    .join("");

  // `access: none` came from agents that guessed one or two ATS slugs and recorded a 404. Spot
  // checking twelve found four with a live /careers page at the obvious address, so the batch action
  // stays but the copy no longer implies the verdict is usually right (AGENT-RULES §13b).
  const noBoard = entries.filter((e) => e.board?.access === "none");
  const batchHTML = noBoard.length
    ? `<div class="alert warn">
         <b>${noBoard.length} companies are marked "no board found".</b> Treat that as unproven:
         these rows were written by agents that guessed one or two ATS slugs and recorded a 404 as
         "no board", without running the mechanical probe or checking the company's own site. Spot
         checking twelve of them found four with a live <code>/careers</code> page at the obvious
         address. Use the 🔎 on a row to check before removing it, and remove in bulk only once you
         are satisfied.
         <form method="POST" action="/dismiss-board" class="inline" style="margin-left:8px"
               onsubmit="return confirm('Remove all ${noBoard.length}? Some of these DO have a careers page — the \'no board\' verdict came from agents that only guessed ATS slugs. They stay in data/boards.md and can be restored.')">
           <input type="hidden" name="_page" value="settings"><input type="hidden" name="_tab" value="companies">
           <input type="hidden" name="scope" value="none">
           <button type="submit" class="btn-small">Remove all ${noBoard.length}</button>
         </form>
       </div>`
    : "";

  const queued = count("queued");
  const queuedHTML = queued
    ? `<div class="alert warn">
         <b>${queued} boards exist but refuse scripted access.</b> An HTTP 401/402/403/429/5xx or a TLS
         failure means the board <em>is</em> there. The daily run now opens these in your Chrome
         (<code>scripts/board-sweep.mjs</code>, 15 per run, oldest first) and reclassifies them, so the
         queue drains on its own. Paste a URL anyway if you already know it.
       </div>`
    : "";

  return `<p class="muted" style="margin:0 0 10px">
      ${entries.length} companies ·
      <b>${count("readable")}</b> readable ·
      ${queued} queued for a browser pass ·
      <b>${count("needs-url")}</b> need a URL from you ·
      ${count("unknown")} not investigated yet${
        dismissedCount ? ` · <b>${dismissedCount} removed</b> — kept in <code>data/boards.md</code>, restore with <code>record.mjs restore-board "Company"</code>` : ""
      }
    </p>
    ${batchHTML}
    ${queuedHTML}
    <div class="cotools">
      <input class="tsearch cosearch" placeholder="search companies, markets, notes…" autocomplete="off">
      <label class="comini">Sort
        <select class="cosort">
          <option value="name">by name</option>
          <option value="tier">by tier</option>
          <option value="state">by board access</option>
        </select>
      </label>
      <span class="taskfilters costates">
        <button type="button" class="tf active" data-f="all">All</button>
        <button type="button" class="tf" data-f="needs-url">Needs a URL (${count("needs-url")})</button>
        <button type="button" class="tf" data-f="queued">Queued (${queued})</button>
        <button type="button" class="tf" data-f="unknown">Not investigated (${count("unknown")})</button>
      </span>
      <button type="button" class="btn-secondary btn-small coexpand" data-open="1">Collapse all</button>
      <span class="muted comatch"></span>
    </div>
    ${groupHTML}`;
}

// Add a company by hand. Adding it also kicks off scripts/discover-board.mjs for that company, so
// the careers board is looked up immediately rather than waiting for the next scout run — the whole
// point being that a company you just thought of should not sit there with no way to read its jobs.
// `market` is the FILE the row is written to; `label` is what the person reads. They differ
// ("consulting-big4" vs "Consulting - Big 4") and posting the label would create a second file.
function addCompanyFormHTML(market, label = market) {
  return `<form method="POST" action="/add-company" class="addco">
    <input type="hidden" name="market" value="${esc(market)}">
    <input name="company" placeholder="Add a company to ${esc(label)} — e.g. Broadcom" autocomplete="off" required>
    <button type="submit">Add</button>
    <span class="muted addco-hint">Adds the row and immediately searches for its careers board.</span>
  </form>`;
}

// ---------- Activity ----------
// 448 rows of "type | detail" is unreadable as a flat table. Types are grouped into families with a
// hue each, so a run boundary, a write and a dismissal are distinguishable at a glance; anything
// unrecognised still gets a stable colour from a hash of its name, so new types never render bare.
const ACTIVITY_FAMILY = {
  run:     { hue: 213, types: ["run-start", "job-run", "reconcile", "dedupe", "seed", "test"] },
  track:   { hue: 187, types: ["track", "gmail-track", "chat-track", "inbox-track"] },
  find:    { hue: 152, types: ["curate", "markets", "market-add", "market-company-added", "board-manual", "proposal-proposed", "proposals-seen"] },
  apply:   { hue: 266, types: ["apply", "stage-advance", "lead-saved", "approval-request", "approval-approved", "approval-edited"] },
  close:   { hue: 12,  types: ["proposal-dismissed", "lead-dismissed", "lead-superseded", "task-dismissed", "advance-dismissed", "approval-rejected"] },
  done:    { hue: 70,  types: ["task-done", "task-open", "task-add", "task-add-nl", "task-in-progress"] },
  config:  { hue: 322, types: ["criteria-edit", "cv-upload", "cv-parse", "correction"] },
};
const ACTIVITY_HUE = (() => {
  const m = {};
  for (const f of Object.values(ACTIVITY_FAMILY)) for (const t of f.types) m[t] = f.hue;
  return m;
})();
function activityHue(type) {
  if (ACTIVITY_HUE[type] != null) return ACTIVITY_HUE[type];
  let h = 0;
  for (let i = 0; i < String(type).length; i++) h = (h * 31 + String(type).charCodeAt(i)) % 360;
  return h;
}
// A run boundary is the one row worth spotting from across the page.
const isRunStart = (t) => t === "run-start";

function activityHTML(table) {
  if (!table.rows.length) return `<p class="empty">Nothing logged yet.</p>`;
  const body = table.rows
    .map((r) => {
      const type = String(r.type || "").trim();
      const fam = Object.entries(ACTIVITY_FAMILY).find(([, f]) => f.types.includes(type));
      return `<tr data-type="${esc(type)}" data-fam="${esc(fam ? fam[0] : "other")}"${isRunStart(type) ? ' class="runrow"' : ""}>
        <td class="nw">${esc(r.timestamp || "")}</td>
        <td><span class="atype${isRunStart(type) ? " arun" : ""}" style="--h:${activityHue(type)}">${esc(type)}</span></td>
        <td>${cell(r.detail)}</td>
      </tr>`;
    })
    .join("");
  return `<div class="scroll"><table><thead><tr><th>when</th><th>type</th><th>detail</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function activitySection(table) {
  const present = new Set(table.rows.map((r) => String(r.type || "").trim()));
  const fams = Object.entries(ACTIVITY_FAMILY).filter(([, f]) => f.types.some((t) => present.has(t)));
  const count = (key) =>
    key === "all"
      ? table.rows.length
      : table.rows.filter((r) => ACTIVITY_FAMILY[key]?.types.includes(String(r.type || "").trim())).length;
  const label = { run: "Runs", track: "Tracking", find: "Finding", apply: "Applying", close: "Dismissals", done: "Tasks", config: "Config" };
  return `<div class="taskfilters afilters">
      <button type="button" class="tf active" data-f="all">All (${table.rows.length})</button>
      ${fams.map(([k]) => `<button type="button" class="tf" data-f="${k}" style="--h:${ACTIVITY_FAMILY[k].hue}">${label[k]} (${count(k)})</button>`).join("")}
      <input class="tsearch asearch" placeholder="search the log…" autocomplete="off">
    </div>
    ${activityHTML(table)}`;
}

function criteriaFormHTML(criteria) {
  const d = criteria.data ?? {};
  const val = (k) => esc(d[k] ?? "");
  return `<form method="POST" action="/save-criteria" class="grid">
    <label>Markets (comma-separated)<input name="markets" value="${val("markets")}"></label>
    <label>Target roles<input name="roles" value="${val("roles")}"></label>
    <label>Locations<input name="locations" value="${val("locations")}"></label>
    <label>Seniority<input name="seniority" value="${val("seniority")}"></label>
    <label>Weight: market<input name="weight_market" value="${val("weight_market")}"></label>
    <label>Weight: role<input name="weight_role" value="${val("weight_role")}"></label>
    <label>Weight: CV<input name="weight_cv" value="${val("weight_cv")}"></label>
    <div class="actions"><button type="submit">Save criteria</button></div>
  </form>
  <form method="POST" action="/add-market" class="inline">
    <input name="market" placeholder="Add a market (e.g. Fintech)" required>
    <button type="submit">Add market</button>
  </form>`;
}

function profileHTML(profile) {
  const parsed = profile.data?.parsed_at;
  const status = parsed
    ? `<span class="pill s-offer">CV parsed ${esc(parsed)}</span>`
    : `<span class="pill s-rejected">No CV parsed</span>`;
  return `<p>${status} ${profile.data?.source_cv ? esc(profile.data.source_cv) : ""}</p>
    <form id="cvform" class="inline">
      <input type="file" id="cvfile" accept="application/pdf" required>
      <button type="submit">Upload CV (PDF)</button>
      <span id="cvmsg" class="muted"></span>
    </form>
    <p class="muted">After uploading, run <code>/parse-cv</code> in Claude Code to build <code>data/profile.md</code>.</p>`;
}

function addTaskFormHTML() {
  return `<form method="POST" action="/add-task" class="grid">
    <label>What to follow up on<input name="detail" placeholder="e.g. Call with Jane at Acme" required></label>
    <label>Who<input name="who" placeholder="name / email"></label>
    <label>Due date<input name="due_date" type="date"></label>
    <label>Type<input name="type" value="followup"></label>
    <label>Related id<input name="related_id" placeholder="app_… (optional)"></label>
    <div class="actions"><button type="submit">Add task</button></div>
  </form>`;
}

function addContactFormHTML() {
  return `<form method="POST" action="/add-contact" class="grid">
    <label>Name<input name="name" required></label>
    <label>Company<input name="company"></label>
    <label>Role<input name="role"></label>
    <label>Email<input name="email"></label>
    <label>LinkedIn URL<input name="linkedin_url"></label>
    <label>Notes<input name="notes"></label>
    <div class="actions"><button type="submit">Add contact</button></div>
  </form>`;
}

// Collapsible + draggable section wrapper. `open` sets the initial expanded state; the client
// then restores the user's saved order/expansion from localStorage.
// A block inside a tab. The `.sec[data-id]` wrapper is kept deliberately: the per-section filter
// JS (tasks / proposals / leads chips + text search) selects on it, so preserving the wrapper keeps
// all of that working untouched. Sections are always open now — collapsing was a workaround for the
// 13-section scroll that tabs replace, and drag-to-reorder went with it.
function sec(id, titleHTML, bodyHTML) {
  return `<section class="sec open" data-id="${id}">
    ${titleHTML ? `<div class="sechead"><h2>${titleHTML}</h2></div>` : ""}
    <div class="secbody">${bodyHTML}</div>
  </section>`;
}

// One tab's pane. Exactly one carries `on`; the rest are hidden by CSS until clicked.
function tabPanel(id, active, inner) {
  return `<div class="tabpanel${active ? " on" : ""}" data-tab="${id}" ${active ? "" : 'hidden'}>${inner}</div>`;
}

// The tab strip. `tabs` = [{id, label, count}]. Rendered server-side with the active tab already
// chosen, so there is no flash of the wrong pane on load.
function tabStrip(tabs, activeId) {
  return `<nav class="tabs" role="tablist">${tabs
    .map(
      (t) =>
        `<button type="button" class="tab${t.id === activeId ? " on" : ""}" role="tab" data-tab="${t.id}"
           aria-selected="${t.id === activeId}">${t.label}${
          t.count != null ? `<span class="tn">${t.count}</span>` : ""
        }</button>`
    )
    .join("")}</nav>`;
}

// ---------- Today ----------
// The default tab: what is actually waiting on you, assembled from the same data the other tabs
// show. Every block states WHERE it came from, because an aggregate view whose selection rules
// drift from reality is worse than no aggregate view at all — it looks authoritative while lying.
// Nothing here is a new source of truth; it is a query over data/.
// Everything the Setup page needs to tell the truth about this machine. Read, never assumed: the
// browser verdict comes from the probe's own machine-readable output, the schedule is read back out
// of the plist, and channel freshness comes from the watermarks the sweeps actually advanced.
// The Setup page. Three jobs: let the user set what is settable, show honestly what is working, and
// for the handful of things a web page CANNOT do (macOS permissions, Chrome's own setting, the
// Claude Code connections) say so plainly and give the steps rather than pretending.
function setupHTML(st, criteria) {
  if (!st) return `<p class="empty">Status unavailable.</p>`;
  const cfg = st.config || {};
  const b = st.browser;
  const hidden = `<input type="hidden" name="_page" value="settings"><input type="hidden" name="_tab" value="setup">`;

  const pill = (ok, okTxt, badTxt) =>
    ok ? `<span class="ok-pill">${esc(okTxt)}</span>` : `<span class="bad-pill">${esc(badTxt)}</span>`;

  const actionBtn = (name, label, extra = "") =>
    `<form method="POST" action="/run-action" class="inline">${hidden}
      <input type="hidden" name="action_name" value="${esc(name)}">${extra}
      <button type="submit" class="btn-small">${esc(label)}</button></form>`;

  // --- what we can act on -------------------------------------------------------------------
  const canRead = Boolean(b?.capabilities?.read_page_content);
  const rows = [
    [
      "Browser access",
      pill(canRead, b?.capabilities?.read_mechanism || "working", "cannot read pages"),
      actionBtn("probe", "Re-check"),
      canRead ? "" : (b?.blockers || []).join(" "),
    ],
    [
      "Browser agent",
      pill(st.agentInstalled, "installed", "not installed"),
      actionBtn("install-browser-agent", st.agentInstalled ? "Reinstall" : "Install"),
      "Lets the scheduled run drive Chrome with a permission that survives Claude Code updates.",
    ],
    [
      "Daily run",
      st.schedInstalled ? `<span class="ok-pill">${esc(st.schedTime)}</span>` : `<span class="bad-pill">not scheduled</span>`,
      `<form method="POST" action="/run-action" class="inline">${hidden}
         <input type="hidden" name="action_name" value="set-schedule">
         <input type="time" name="time" value="${esc(/^\d\d:\d\d$/.test(st.schedTime) ? st.schedTime : "08:00")}" required>
         <button type="submit" class="btn-small">Set</button></form>` +
        (st.schedInstalled ? actionBtn("remove-schedule", "Remove") : ""),
      "Reads your channels each morning and sends the digest. It never applies or sends anything.",
    ],
  ];

  // --- what only you can do -----------------------------------------------------------------
  const manual = [];
  if (b?.blockers?.some((x) => /Allow JavaScript from Apple Events/i.test(x))) {
    manual.push([
      "Chrome setting",
      "<ol><li>Open Chrome</li><li>Menu bar ▸ View ▸ Developer</li>" +
        "<li>Click &quot;Allow JavaScript from Apple Events&quot;</li></ol>" +
        "<p class='muted'>Automating this would need Accessibility permission — control of your whole UI. " +
        "JobSeeker never asks for that.</p>",
    ]);
  }
  if (b?.apple_events === "denied" || b?.apple_events === "prompt-pending") {
    manual.push([
      "macOS Automation",
      "<ol><li>Open System Settings</li><li>Privacy &amp; Security ▸ Automation</li>" +
        "<li>Tick <b>Google Chrome</b> under Claude</li></ol>",
    ]);
  }
  // Shown only when a tab actually failed to answer. Chrome discards long-idle background tabs, and
  // a discarded tab has no renderer — so the read fails with the same timeout a missing permission
  // gives, and the user is told their messages cannot be read while everything is in fact granted.
  // Reading the channels at 08:00 means their tabs have been idle all night, which is exactly the
  // case Memory Saver reclaims. Code cannot fix it: waking a tab means activating it, and a
  // discarded LinkedIn messaging tab reloads on activation and marks the first thread read.
  if (b?.js_from_apple_events === "error") {
    manual.push([
      "Chrome Memory Saver",
      "<ol><li>Open Chrome ▸ Settings ▸ <b>Performance</b></li>" +
        "<li>Under <b>Memory Saver</b>, click <b>Add</b> beside &quot;Always keep these sites active&quot;</li>" +
        "<li>Enter <code>web.whatsapp.com</code>, click <b>Add</b></li>" +
        "<li>Repeat for <code>linkedin.com</code></li></ol>" +
        "<p class='muted'>Chrome put a tab to sleep to save memory, and a sleeping tab cannot be read — " +
        "the permissions themselves are fine. This is why a channel can read correctly while you are at " +
        "the machine and fail overnight." +
        (b?.js_probe_detail ? ` Last probe: ${esc(b.js_probe_detail)}.` : "") +
        "</p>",
    ]);
  }
  const chanRow = (label, days, how) =>
    `<tr><td class="nw"><b>${esc(label)}</b></td><td class="nw">${
      days === null ? `<span class="bad-pill">never read</span>` : days > 2
        ? `<span class="bad-pill">${days}d ago</span>` : `<span class="ok-pill">${days}d ago</span>`
    }</td><td class="nw"></td><td class="muted">${esc(how)}</td></tr>`;

  // --- spend ----------------------------------------------------------------------------------
  const sp = st.spend || {};
  const spendRows = (sp.recent || []).length
    ? (sp.recent || []).map((r) => `<tr><td class="nw">${esc(r.date)}</td><td class="nw">$${(r.cost_usd || 0).toFixed(2)}</td><td>${esc(r.outcome)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="muted">No runs recorded yet. Cost tracking starts from the next run — earlier runs were never measured.</td></tr>`;

  return `
  <p class="th">What you are looking for</p>
  ${criteriaFormHTML(criteria)}

  <form method="POST" action="/save-config" class="cfgform">${hidden}
    <p class="th">Spend</p>
    <div class="cfggrid">
      <label>Cap per run (USD)<input name="max_spend_per_run_usd" value="${esc(cfg.max_spend_per_run_usd ?? "5")}" inputmode="decimal"></label>
      <label>Monthly ceiling (USD, blank = none)<input name="max_spend_per_month_usd" value="${esc(cfg.max_spend_per_month_usd ?? "")}" inputmode="decimal"></label>
    </div>
    <p class="muted">This month: <b>$${(sp.month_total_usd || 0).toFixed(2)}</b> across ${sp.month_runs || 0} run(s).
      Past the ceiling the daily run does not start, and tells you why.</p>

    <p class="th">Channels</p>
    <div class="cfggrid">
      <label>Approval channels<input name="approval_channels" value="${esc(cfg.approval_channels ?? "")}"></label>
      <label>WhatsApp owner JID<input name="whatsapp_owner_jid" value="${esc(cfg.whatsapp_owner_jid ?? "")}"></label>
      <label>Read WhatsApp Web<input name="whatsapp_web_enabled" value="${esc(cfg.whatsapp_web_enabled ?? "true")}"></label>
      <label>Read LinkedIn<input name="linkedin_enabled" value="${esc(cfg.linkedin_enabled ?? "true")}"></label>
    </div>

    <p class="th">Privacy</p>
    <div class="cfggrid">
      <label>Chats never to log<input name="ignored_chats" value="${esc(cfg.ignored_chats ?? "")}" placeholder="comma list, prefix match"></label>
      <label>Company aliases<input name="company_aliases" value="${esc(cfg.company_aliases ?? "")}" placeholder="oldname=New Name"></label>
      <label>Pause applying before<input name="apply_stop_before" value="${esc(cfg.apply_stop_before ?? "")}"></label>
    </div>
    <button type="submit" class="btn">Save settings</button>
  </form>

  <p class="th">System</p>
  <div class="scroll"><table><tbody>
    ${rows.map(([k, v, act, note]) => `<tr><td class="nw"><b>${esc(k)}</b></td><td class="nw">${v}</td><td class="nw">${act}</td><td class="muted">${note}</td></tr>`).join("")}
    ${chanRow("Gmail / Calendar", st.channels.gmail, "Connected in Claude Code, not here.")}
    ${chanRow("WhatsApp", st.channels.whatsapp, "Read through Chrome by the daily run.")}
    ${chanRow("LinkedIn", st.channels.linkedin, "Read through Chrome by the daily run.")}
    <tr><td class="nw"><b>CV</b></td><td class="nw">${st.profileParsed ? `<span class="ok-pill">parsed</span>` : `<span class="bad-pill">not parsed</span>`}</td><td class="nw"></td><td class="muted">Upload on the CV tab, then run <code>/parse-cv</code> in Claude Code.</td></tr>
  </tbody></table></div>

  ${manual.length ? `<p class="th">Only you can do these</p>` + manual.map(([k, v]) => `<div class="alert warn"><b>${esc(k)}</b>${v}</div>`).join("") : ""}

  <p class="th">Spend history</p>
  <div class="scroll"><table><thead><tr><th>date</th><th>cost</th><th>outcome</th></tr></thead><tbody>${spendRows}</tbody></table></div>
  `;
}

async function systemStatus() {
  const sh = (cmd, args, timeout = 8000) =>
    new Promise((resolve) =>
      execFile(cmd, args, { cwd: ROOT, timeout }, (err, stdout) =>
        resolve({ ok: !err, out: String(stdout || "").trim() })
      )
    );

  let browser = null;
  try {
    browser = JSON.parse(await fs.readFile(path.join(DATA, ".browser-status.json"), "utf8"));
  } catch {
    /* probe has not run here yet */
  }

  const uid = process.getuid();
  const [agent, sched, schedTime, spendRaw] = await Promise.all([
    sh("launchctl", ["print", `gui/${uid}/com.jobseeker.browser`]),
    sh("launchctl", ["print", `gui/${uid}/com.jobseeker.jobrun`]),
    sh("bash", [path.join(ROOT, "scripts", "set-schedule.sh"), "--show"]),
    sh("node", [path.join(ROOT, "server", "record.mjs"), "list-spend", "--limit", "10"]),
  ]);

  let spend = { month_total_usd: 0, month_runs: 0, runs_recorded: 0, recent: [], month: "" };
  try {
    spend = JSON.parse(spendRaw.out);
  } catch {
    /* no ledger yet */
  }

  const wm = {};
  try {
    for (const r of (await readTable(path.join(DATA, "watermarks.md"))).rows) {
      if (r.channel) wm[r.channel] = r.timestamp || "";
    }
  } catch {
    /* none yet */
  }
  const ageDays = (iso) => {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
  };

  let profileParsed = false;
  try {
    profileParsed = !/no cv parsed/i.test(await fs.readFile(path.join(DATA, "profile.md"), "utf8"));
  } catch {
    /* absent */
  }

  let config = {};
  try {
    config = parseFrontmatter(await fs.readFile(path.join(ROOT, "config", "job-seeker.config.md"), "utf8")).data || {};
  } catch {
    /* not configured yet — the form shows defaults */
  }

  return {
    config,
    browser,
    agentInstalled: agent.ok,
    schedInstalled: sched.ok,
    schedTime: schedTime.out || "not scheduled",
    spend,
    channels: {
      gmail: ageDays(wm.gmail),
      whatsapp: ageDays(wm.whatsapp),
      linkedin: ageDays(wm.linkedin),
    },
    profileParsed,
  };
}

function todayHTML(all, dueToday, appTok, appIds) {
  const t = today();
  const tasks = all.tasks.rows.filter((r) => r.status === "open");
  const overdue = tasks.filter((r) => r.due_date && r.due_date < t);
  const advances = all.applications.filter((a) => a.data.pending_stage);
  const pendingApprovals = all.approvals.filter((a) => a.data.status === "pending");
  const agingProposals = all.proposals.filter(
    (p) => String(p.data.status) === "proposed" && p.data.found_date && p.data.found_date <= addDays(t, -7)
  );
  // Dismissed boards are not outstanding work. Counting them would leave the banner unchanged after
  // a removal, which teaches the user the button does nothing.
  const boardRows = (all.boards?.rows ?? []).filter((r) => !String(r.dismissed || "").trim());
  // Only what a person can fix, by the same rule the Companies page uses. `browser`/`blocked`
  // boards are the sweep's job now, not the user's, and counting them here asked for attention 45
  // times over for work already automated.
  const boardsNeeding = boardRows.filter((r) => companyState({ board: r }) === "needs-url").length;
  const run = all.lastRun;

  // A failed scheduled run is the one thing you would otherwise never notice — no digest arrives
  // and nothing complains. It goes first, above everything.
  // A digest that never reached the user is invisible by definition — so when delivery failed, the
  // digest itself is shown here rather than left in a log file.
  const d = all.lastDigest;
  const digestBlock =
    d && d.delivered === false
      ? `<div class="alert bad">
           <strong>Your last digest was not delivered.</strong>
           ${esc(d.reason || "reason not recorded")} — so it is reproduced here.
         </div>
         <div class="tblock"><pre class="digest">${esc(d.body)}</pre></div>`
      : "";

  // Reading messages can be blocked while the digest still sends — they are different capabilities
  // (AGENT-RULES §10). The blockers array carries the specific one-time fix, so it is shown verbatim
  // rather than paraphrased into "Chrome unavailable".
  const b = all.browser;
  const browserBanner =
    b && b.capabilities && !b.capabilities.read_page_content
      ? `<div class="alert warn"><strong>WhatsApp Web and LinkedIn messages cannot be READ.</strong>
           ${b.whatsapp?.unread ? `<strong>${b.whatsapp.unread} unread</strong> waiting on WhatsApp Web. ` : ""}
           ${b.blockers?.length ? esc(b.blockers[0]) : "No mechanism available."}
           <span class="muted">Sending still works — the digest goes over the WhatsApp API, which needs no browser.</span></div>`
      : "";

  const runBanner =
    run && run.state === "failed"
      ? `<div class="alert bad"><strong>The last scheduled run failed.</strong>
           ${esc(run.detail || "")} <span class="muted">(started ${esc(run.started || "?")})</span>
           — check <code>data/.job-run.log</code>.</div>`
      : "";

  const advancesBlock = advances.length
    ? `<div class="tblock">
        <p class="th">Waiting on one click <span class="muted">— an agent found evidence of progress</span></p>
        ${advances
          .map(
            (a) => `<div class="titem">
              <span class="ti-co">${esc(a.data.company)}</span>
              <span class="ti-tx">${esc(a.data.role)} <span class="muted">→ ${esc(a.data.pending_stage)}</span>
                ${a.data.pending_note ? `<div class="ti-sub">${esc(String(a.data.pending_note).slice(0, 180))}</div>` : ""}
                ${(() => {
                  // Show how old the evidence is. A note written days ago can describe a situation
                  // that has since moved on, and the badge gives no other clue that it might be stale.
                  const since = a.data.pending_since;
                  if (!since) return "";
                  const days = Math.max(0, Math.round((Date.parse(t) - Date.parse(since)) / 86400000));
                  const stale = days >= 3;
                  return `<div class="ti-age${stale ? " stale" : ""}">detected ${esc(since)}${
                    days === 0 ? " (today)" : ` · ${days} day${days === 1 ? "" : "s"} ago`
                  }${stale ? " — check this is still current" : ""}</div>`;
                })()}</span>
              <span class="ti-acts">
                ${advanceBtn(a.data)}
                <span class="popwrap">
                  <button type="button" class="dismbtn" aria-haspopup="dialog" aria-expanded="false"
                    onclick="popToggle('adv_${esc(a.data.id)}', this)"
                    title="We will not action this. Optionally say why.">Dismiss</button>
                  <div id="adv_${esc(a.data.id)}" class="pop hide" role="dialog"
                       aria-label="Dismiss ${esc(a.data.company)} — ${esc(a.data.pending_stage)}">
                    <form method="POST" action="/dismiss-advance">
                      <input type="hidden" name="id" value="${esc(a.data.id)}">
                      <p class="pop-h">Dismiss this advance</p>
                      <p class="pop-sub">${esc(a.data.company)} → ${esc(a.data.pending_stage)}. It will not be raised again.</p>
                      <textarea name="note" rows="3" placeholder="Why? Optional — leave blank if there is nothing to add." autocomplete="off"></textarea>
                      <div class="pop-acts">
                        <button type="button" class="btn-secondary" onclick="popClose('adv_${esc(a.data.id)}')">Cancel</button>
                        <button type="submit">OK</button>
                      </div>
                    </form>
                  </div>
                </span>
              </span>
            </div>`
          )
          .join("")}
      </div>`
    : "";

  const approvalsBlock = pendingApprovals.length
    ? `<div class="tblock">
        <p class="th">Approvals waiting <span class="muted">— nothing is sent until you approve it</span></p>
        ${pendingApprovals
          .map(
            (a) => `<div class="titem"><span class="ti-co">${esc(a.data.kind || "message")}</span>
              <span class="ti-tx">${esc(a.data.summary || a.data.title || a.data.id)}
              <div class="ti-sub">created ${esc(a.data.created || "?")} · <code>${esc(a.data.id)}</code></div></span></div>`
          )
          .join("")}
      </div>`
    : "";

  // Counters that are real but not individually actionable — one line each, with the tab that owns them.
  // Deliberately NOT repeating the stat bar above — only what it does not already say.
  const queues = [
    agingProposals.length
      ? `<b>${agingProposals.length}</b> proposal${agingProposals.length === 1 ? "" : "s"} aging 7+ days without a decision`
      : "",
  ].filter(Boolean);

  const boardsBlock = boardsNeeding
    ? `<div class="alert warn"><strong>${boardsNeeding} careers boards have no readable URL.</strong>
         Agents cannot fix these by trying harder — paste the real careers page and the next scout run
         will use it. <a href="/settings?tab=companies">Open in Settings →</a></div>`
    : "";

  return `${browserBanner}
    ${runBanner}
    ${digestBlock}
    ${queues.length ? `<div class="tsummary">${queues.join(" · ")}</div>` : ""}
    ${advancesBlock}
    ${approvalsBlock}
    ${boardsBlock}
    <div class="tblock">
      <p class="th">Follow-ups due <span class="muted">— from All tasks, due on or before today</span></p>
      ${tasksHTML(dueToday, appTok, appIds, "Nothing due today. 🎉")}
    </div>`;
}

// Date arithmetic without Date.now(): shift a YYYY-MM-DD string by n days.
function addDays(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function page(all, flash) {
  const dueToday = all.tasks.rows.filter(
    (t) => t.status === "open" && t.due_date && t.due_date <= today()
  );
  const appTok = all.applications.map(appTokens);
  const appIds = new Set(all.applications.map((a) => a.data.id));
  // Separate confirmed Applications from Leads (CV-sent / referral, no confirmation evidence).
  const applied = all.applications.filter((a) => a.data.kind === "application");
  const leads = all.applications.filter((a) => a.data.kind !== "application");
  // company key -> [{role, status}] of submitted applications, so proposals at that company can show
  // a "✓ Applied here: <role>" indicator (you asked to keep seeing other roles, but flagged).
  const appliedByCompany = {};
  for (const a of applied) {
    const k = normCompanyKey(a.data.company);
    if (!k) continue;
    (appliedByCompany[k] = appliedByCompany[k] || []).push({ role: a.data.role, status: a.data.status });
  }
  // Prebuild each lead's activity-summary HTML and ship it inline (escape "<" so a summary
  // containing markup can't break out of the <script>). The popup just injects it on click.
  const detailsJSON = JSON.stringify(buildDetails(all)).replace(/</g, "\\u003c");
  const t = today();
  // Which live proposals are jobs already applied to? Same matcher as record.mjs and audit.mjs
  // (server/match.mjs), so the badge, list-keys and the supervisor never disagree.
  const REQ_PATTERNS = [/\bJR[-_ ]?(\d{4,})\b/gi, /\breq(?:uisition)?\.?\s*#?\s*(\d{3,})\b/gi, /\bR(\d{6,})\b/g, /\bjob\s*(?:id|order)?\s*#?\s*(\d{5,})\b/gi];
  const normReq = (x) => String(x).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const reqIndexOf = (r) => {
    const out = new Set();
    for (const tok of String(r.req_id || "").split(/[,;/\s]+/)) { const n = normReq(tok); if (n.length >= 3) out.add(n); }
    for (const v of [r.job_url, r.role, r.next_action]) {
      for (const re of REQ_PATTERNS) { re.lastIndex = 0; let m; while ((m = re.exec(String(v || "")))) out.add(normReq(m[0])); }
    }
    return [...out];
  };
  const appDataAll = all.applications.map((a) => a.data);
  const reposts = {};
  for (const pr of all.proposals) {
    if (String(pr.data.status || "").toLowerCase() !== "proposed") continue;
    const m = findRepost(pr.data, appDataAll, { reqIndex: reqIndexOf });
    if (m) reposts[pr.data.id] = m;
  }
  const openTasks = all.tasks.rows.filter((r) => r.status === "open");
  // dueToday is "due on or before today" — useful for the Today table, WRONG as a "due today"
  // counter, which read 12 while the overdue counter beside it read 9 (the 9 were inside the 12).
  const dueTodayOnly = openTasks.filter((r) => r.due_date === t);
  const overdueOnly = openTasks.filter((r) => r.due_date && r.due_date < t);
  const activeLeads = leads.filter((a) => !["dismissed", "withdrawn"].includes(String(a.data.status || "").toLowerCase()));
  const openProposals = all.proposals.filter((p) => String(p.data.status) === "proposed");
  const advances = all.applications.filter((a) => a.data.pending_stage).length;
  const pendingApprovals = all.approvals.filter((a) => a.data.status === "pending").length;
  const todayCount = dueToday.length + advances + pendingApprovals;

  const TABS = [
    { id: "today", label: "Today", count: todayCount || null },
    { id: "applications", label: "Applications", count: applied.length },
    { id: "leads", label: "Leads", count: activeLeads.length },
    { id: "proposals", label: "Jobs", count: openProposals.length },
    { id: "tasks", label: "Tasks", count: openTasks.length },
    { id: "communications", label: "Comms", count: all.communications.rows.length },
    { id: "contacts", label: "Contacts", count: all.contacts.rows.length },
    { id: "activity", label: "Activity", count: null },
  ];
  const active = TABS.some((x) => x.id === all.tab) ? all.tab : "today";
  const on = (id) => id === active;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Seeker — Dashboard</title>
${HEAD_ICONS}
<style>${CSS}</style>
</head><body>
<header>
  ${BRAND("Job Seeker")}
  <div class="head-actions">
    <a class="gearlink" href="/settings" title="Criteria, markets, careers boards, CV">⚙ Settings</a>
  </div>
</header>
${flash ? `<div class="flash ${esc(flash.kind)}">${esc(flash.msg)}</div>` : ""}

<div class="topbar">
<div class="statbar">
  <span><b>${dueTodayOnly.length}</b> due today</span>
  <span><b>${overdueOnly.length}</b> overdue</span>
  <span><b>${pendingApprovals}</b> approvals</span>
  <span><b>${advances}</b> advances waiting</span>
  <span class="sb-sp"></span>
  <span class="muted">${applied.length} applications · ${activeLeads.length} leads · ${openProposals.length} proposals</span>
</div>
${tabStrip(TABS, active)}
</div>
<div id="panels">
${tabPanel("today", on("today"), sec("today", "", todayHTML(all, dueToday, appTok, appIds)))}
${tabPanel("applications", on("applications"), sec("applications", `Applications <span class="muted">— confirmed by a received/confirmation email (click a row)</span>`, statusBoardHTML(applied) + applicationsHTML(applied)))}
${tabPanel("leads", on("leads"), sec("leads", `Leads <span class="muted">— CV sent / referrals (× to dismiss · filter by status)</span>`, leadsSection(leads)))}
${tabPanel("proposals", on("proposals"), sec("proposals", `Jobs <span class="muted">— curated openings to review (× to dismiss · filter by status)</span>`, proposalsSection(all.proposals, appliedByCompany, reposts)))}
${tabPanel("tasks", on("tasks"), sec("tasks", `All tasks <span class="muted">(add in plain English · filter · click a row)</span>`, tasksSection(all.tasks.rows, appTok, appIds)))}
${tabPanel("communications", on("communications"), sec("communications", "Communications", commsHTML(all.communications)))}
${tabPanel("contacts", on("contacts"), sec("contacts", "Contacts", tableHTML(all.contacts) + `<h3 style="margin-top:18px">Add a contact</h3>` + addContactFormHTML()))}
${tabPanel("activity", on("activity"), sec("activity", `Activity <span class="muted">— append-only audit log (filter by kind · search · run boundaries highlighted)</span>`, activitySection(all.activity)))}
</div>

<footer class="muted">Local Markdown is the source of truth (<code>data/</code>). Agent actions run as Claude Code slash commands. Configuration lives in <a href="/settings">Settings</a>.</footer>

<div id="overlay" class="overlay" onclick="if(event.target===this)closeDetail()">
  <div class="modal"><button class="mclose" onclick="closeDetail()" aria-label="Close">×</button><div id="mbody"></div></div>
</div>
<div id="dismissOverlay" class="overlay" onclick="if(event.target===this)closeDismiss()">
  <div class="modal" style="max-width:460px">
    <button class="mclose" onclick="closeDismiss()" aria-label="Close">×</button>
    <h3>Dismiss lead</h3>
    <p class="muted" id="dismissWhat" style="margin:0 0 10px"></p>
    <form method="POST" action="/set-app-status">
      <input type="hidden" name="id" id="dismissId">
      <input type="hidden" name="status" value="Dismissed">
      <textarea name="reason" id="dismissReason" rows="3" placeholder="Why are you dismissing this? e.g. wrong location, too junior, comp too low, not interested…" style="width:100%"></textarea>
      <div class="actions" style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn-secondary" onclick="closeDismiss()">Cancel</button>
        <button type="submit">Dismiss lead</button>
      </div>
    </form>
  </div>
</div>
<script>window.__DETAILS__=${detailsJSON};</script>
<script>${JS}</script>
</body></html>`;
}

// ---------- Settings ----------
// Configuration only: things set once and changed rarely. Split out so the daily page holds nothing
// but what actually changes daily. Same tab mechanics, its own small set of panes.
function settingsPage(all, flash) {
  // One tab, not two. "Markets & vendors" and "Careers boards" described the same entity from two
  // angles and overlapped on 183 companies — see joinCompanies().
  const companies = joinCompanies(all);
  const companyCount = companies.length;
  // Only rows a person can actually fix, using the SAME classification the page renders. The old
  // count folded in `browser` and `blocked`, which the board sweep now works on its own — so the
  // banner demanded attention for 45 boards nobody needed to touch.
  const needing = companies.filter((e) => companyState(e) === "needs-url").length;
  const TABS = [
    { id: "setup", label: "Setup", count: null },
    { id: "criteria", label: "Criteria &amp; weights", count: null },
    { id: "companies", label: "Companies", count: companyCount },
    { id: "cv", label: "CV / profile", count: null },
  ];
  const active = TABS.some((x) => x.id === all.tab) ? all.tab : "setup";
  const on = (id) => id === active;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Settings — Job Seeker</title>
${HEAD_ICONS}
<style>${CSS}</style>
</head><body>
<header>
  ${BRAND("Settings")}
  <div class="head-actions"><a class="gearlink" href="/">← Back to work</a></div>
</header>
${flash ? `<div class="flash ${esc(flash.kind)}">${esc(flash.msg)}</div>` : ""}
<div class="topbar">
<div class="statbar">
  <span class="muted">Set once, changed rarely. The agents read all of this every run.</span>
  ${needing ? `<span class="sb-sp"></span><span class="warntx"><b>${needing}</b> careers boards need a URL</span>` : ""}
</div>
${tabStrip(TABS, active)}
</div>
<div id="panels">
${tabPanel("setup", on("setup"), sec("setup", `Setup <span class="muted">— everything JobSeeker needs, and whether it is actually working</span>`, setupHTML(all.status, all.criteria)))}
${tabPanel("criteria", on("criteria"), sec("criteria", `Criteria <span class="muted">— what the agents target and how they weight fit</span>`, criteriaFormHTML(all.criteria)))}
${tabPanel("companies", on("companies"), sec("companies", `Companies <span class="muted">— who you are targeting and where their jobs are read from (🔎 to find a board, ✏️ to paste one)</span>`, companiesHTML(all)))}
${tabPanel("cv", on("cv"), sec("cv", `CV <span class="muted">— parsed into data/profile.md by /parse-cv</span>`, profileHTML(all.profile)))}
</div>
<footer class="muted">Local Markdown is the source of truth (<code>data/</code>). <a href="/">Back to work →</a></footer>
<script>${JS}</script>
</body></html>`;
}

const CSS = `
:root{--bg:#0f1220;--card:#181c2f;--line:#2a2f48;--fg:#e7e9f3;--mut:#9aa0bd;--acc:#6ea8fe;}
@media (prefers-color-scheme: light){:root{--bg:#f6f7fb;--card:#fff;--line:#e3e6f0;--fg:#1a1c28;--mut:#5b6178;--acc:#2563eb;}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 12px;letter-spacing:.02em}
.brand{display:flex;align-items:center;gap:10px;min-width:0}
.brand .mark{display:block;width:32px;height:32px;border-radius:8px;flex:0 0 auto}
.brand h1{letter-spacing:-.01em}
section{padding:18px 24px;border-bottom:1px solid var(--line)}
.cards,.board{display:flex;gap:12px;flex-wrap:wrap}
.kpi,.col{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;min-width:120px}
.kpi .num,.col .num{font-size:26px;font-weight:700}.kpi .lbl,.col .lbl{color:var(--mut);font-size:12px}
.board .col{min-width:90px;text-align:center}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;white-space:nowrap}
a{color:var(--acc)}.muted{color:var(--mut)}.empty{color:var(--mut);font-style:italic}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--line);font-size:12px}
/* ---- page layout ----
   Everything that spans the page shares one gutter rule, so the header, toolbar, panels and footer
   stay on the same left edge. The max() keeps a comfortable gutter on small screens and centres the
   content once the viewport is wider than --maxw, without needing a wrapper element per block. */
:root{--gut:clamp(16px,3.2vw,40px);--maxw:1480px}
header,.topbar>.statbar,.topbar>nav.tabs,#panels,body>footer{
  padding-inline:max(var(--gut),calc((100% - var(--maxw)) / 2))}
header{position:static}
#panels{padding-top:22px;padding-bottom:72px}
body>footer{padding-top:22px;padding-bottom:40px;border-top:1px solid var(--line);font-size:12px;line-height:1.7}
/* Sticky toolbar: the tab strip stays reachable while a long table scrolls. */
.topbar{position:sticky;top:0;z-index:6;background:var(--bg);border-bottom:1px solid var(--line);
  box-shadow:0 1px 0 var(--line)}
.topbar>.statbar{padding-top:12px;padding-bottom:10px}
/* ---- tab shell ---- */
.gearlink{display:inline-block;padding:6px 12px;border:1px solid var(--line);border-radius:8px;
  color:var(--acc);text-decoration:none;font-size:13px;white-space:nowrap}
.gearlink:hover{background:var(--line)}
.statbar{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:10px 4px 14px;font-size:12.5px;color:var(--mut)}
.statbar b{color:var(--fg);font-weight:700;font-variant-numeric:tabular-nums}
.statbar .sb-sp{flex:1;min-width:0}
.warntx{color:#f0b357}
/* ---- tabs as coloured pills ----
   Each tab carries ONE hue in --h and every colour derives from it, so the two themes need only
   different lightness stops rather than two hand-written palettes.
   Colours are in OKLCH, not HSL, because HSL lightness is not perceptual: at hsl(…,34%) green is far
   brighter than blue, so a single stop failed AA on the greens/teals/ambers while passing on the
   blues (measured: applications 3.08:1, proposals 3.47:1). OKLCH L is perceptually uniform, so one
   set of stops holds for every hue — worst case across all 8 hues x both themes x active/resting is
   now 5.85:1 against a 4.50 AA bar.
   --tab-c scales chroma so a tab can be muted without re-declaring the stops (which would leak the
   dark values into the light theme via specificity).
   Colour is an ADDITIONAL cue, never the only one: the active pill also carries heavier weight, a
   ring and aria-selected, so it stays identifiable without relying on hue discrimination. */
/* Only SCALARS live on :root. A var() inside a custom property declared on :root is resolved ON
   :root — where --h does not exist — which makes the whole token invalid and the pill transparent.
   So the oklch() calls must sit in the .tab rules below, where --h is in scope. */
:root{
  --tbg-l:0.255; --tbg-c:0.055; --tfg-l:0.855; --tfg-c:0.095;
  --ton-bg-l:0.470; --ton-bg-c:0.120; --ton-fg-l:0.985; --ton-fg-c:0.020;
  --tring-l:0.640; --tring-c:0.130;
}
@media (prefers-color-scheme: light){
  :root{
    --tbg-l:0.945; --tbg-c:0.045; --tfg-l:0.430; --tfg-c:0.130;
    --ton-bg-l:0.855; --ton-bg-c:0.095; --ton-fg-l:0.300; --ton-fg-c:0.070;
    --tring-l:0.550; --tring-c:0.130;
  }
}
nav.tabs{display:flex;gap:7px;border-bottom:0;margin:0;padding-block:2px;overflow-x:auto;scrollbar-width:none}
nav.tabs::-webkit-scrollbar{display:none}
nav.tabs .tab{
  --h:228; --tab-c:1;
  appearance:none;border:0;border-radius:999px;font:inherit;font-size:13px;font-weight:550;
  padding:7px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;white-space:nowrap;
  background:oklch(var(--tbg-l) calc(var(--tbg-c) * var(--tab-c)) var(--h));
  color:oklch(var(--tfg-l) calc(var(--tfg-c) * var(--tab-c)) var(--h));
  transition:background .14s ease,color .14s ease,box-shadow .14s ease}
nav.tabs .tab:hover{box-shadow:inset 0 0 0 1px oklch(var(--tring-l) calc(var(--tring-c) * var(--tab-c)) var(--h))}
nav.tabs .tab:focus-visible{outline:2px solid oklch(var(--tring-l) calc(var(--tring-c) * var(--tab-c)) var(--h));outline-offset:2px}
nav.tabs .tab.on{
  background:oklch(var(--ton-bg-l) calc(var(--ton-bg-c) * var(--tab-c)) var(--h));
  color:oklch(var(--ton-fg-l) calc(var(--ton-fg-c) * var(--tab-c)) var(--h));
  font-weight:700;
  box-shadow:inset 0 0 0 1px oklch(var(--tring-l) calc(var(--tring-c) * var(--tab-c)) var(--h))}
nav.tabs .tab .tn{font-size:11px;font-variant-numeric:tabular-nums;opacity:.75;font-weight:600}
nav.tabs .tab.on .tn{opacity:.95}
/* One hue per destination, spaced around the wheel so neighbours never read as the same colour. */
nav.tabs .tab[data-tab="today"]{--h:213}          /* accent blue — the landing tab */
nav.tabs .tab[data-tab="applications"]{--h:152}   /* green, echoing the interview status pill */
nav.tabs .tab[data-tab="leads"]{--h:296}          /* violet, echoing the screening status pill */
nav.tabs .tab[data-tab="proposals"]{--h:187}      /* teal */
nav.tabs .tab[data-tab="tasks"]{--h:70}           /* olive-amber */
nav.tabs .tab[data-tab="communications"]{--h:340} /* pink */
nav.tabs .tab[data-tab="contacts"]{--h:30}        /* orange */
nav.tabs .tab[data-tab="activity"]{--h:228;--tab-c:.3}  /* muted on purpose: it is a log */
/* Settings tabs reuse the same hues so the two pages read as one system. */
nav.tabs .tab[data-tab="criteria"]{--h:213}
nav.tabs .tab[data-tab="companies"]{--h:152}
nav.tabs .tab[data-tab="cv"]{--h:296}
.tabpanel[hidden]{display:none}
.tabpanel .sec{margin-bottom:0;border:0;background:transparent}
.tabpanel .sec .sechead{padding:0 0 10px;cursor:default}
.tabpanel .sec .secbody{padding:0}
.tabpanel .secbody .scroll{border:1px solid var(--line);border-radius:12px;background:var(--card)}
.tabpanel .secbody .scroll>table{font-size:13px}
.tabpanel .secbody .scroll th{position:sticky;top:0;background:var(--card);z-index:1}
.tabpanel .secbody .scroll tr:last-child td{border-bottom:0}
th,td{padding:9px 12px}
td.nw,th.nw{white-space:nowrap}
/* Setup page */
.cfgform{margin:0 0 26px}
.cfggrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px 18px;margin:0 0 18px}
.cfggrid label{display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:var(--mut)}
.cfggrid input{padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);font:inherit}
.ok-pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;background:rgba(46,160,67,.16);color:#3fb950}
.bad-pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;background:rgba(214,138,0,.16);color:#d68a00}
form.inline{display:inline-flex;gap:6px;align-items:center;margin:0 6px 0 0}
/* The row actions sit on one line: search the company, paste a URL, or remove it for good. */
.bacts{display:inline-flex;align-items:center;gap:2px;white-space:nowrap}
.bacts form{display:inline;margin:0}
.bsearch{display:inline-block;text-decoration:none;padding:3px 6px;opacity:.7;font-size:14px}
.bsearch:hover{opacity:1}
/* Red, and only red — destructive actions should not look like the others. */
.btrash{background:none;border:0;cursor:pointer;padding:3px 6px;line-height:0;
  color:#f85149;opacity:.8;display:inline-flex;align-items:center}
.btrash:hover{opacity:1;transform:scale(1.12)}
.btn-small{padding:5px 11px;font-size:12.5px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--fg);cursor:pointer}
.btn-small:hover{border-color:var(--acc)}
.alert.warn ol{margin:8px 0 4px 18px;padding:0}
.alert.warn li{margin:3px 0}
/* Dates are fixed-width and meaningless when split across lines ("2026-07-" / "13"),
   so no date column may wrap even if a renderer forgets the .nw class. */
table td:first-child{white-space:nowrap}
table td.wrap:first-child{white-space:normal}
/* min-width is the important half: without a floor the browser starves a prose column down to a
   one-word-per-line ribbon whenever a sibling column is much longer. */
.clamp{display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;
  min-width:30ch;max-width:56ch;cursor:help}
.tabpanel .secbody .scroll td:first-child{min-width:11ch}
.tabpanel .sec .sechead h2{font-size:16px;letter-spacing:-.01em}
/* ---- Today ---- */
.tsummary{font-size:13px;color:var(--mut);margin:0 0 16px}
.tsummary b{color:var(--fg);font-weight:700;font-variant-numeric:tabular-nums}
.tblock{margin:0 0 22px}
.tblock .th{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--mut);margin:0 0 8px;font-weight:600}
.titem{display:flex;align-items:flex-start;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)}
.titem:last-child{border-bottom:0}
.ti-co{font-weight:650;min-width:140px;flex:none}
.ti-tx{flex:1;min-width:0}
.ti-sub{color:var(--mut);font-size:11.5px;margin-top:3px}
.ti-age{font-size:11px;margin-top:3px;color:var(--mut);font-variant-numeric:tabular-nums}
.ti-age.stale{color:#f0b357}
.ti-acts{display:flex;gap:8px;align-items:center;flex-shrink:0}
.dismbtn{background:transparent;border:1px solid var(--line);color:var(--mut);font:inherit;font-size:12px;
  padding:5px 12px;border-radius:7px;cursor:pointer;white-space:nowrap}
.dismbtn:hover{border-color:#d0224a;color:#ff9db0;background:rgba(214,0,60,.10);filter:none}
/* Balloon anchored to the Dismiss button, rather than a full-width row that pushed the page
   around. Right-aligned because the button sits at the right edge of the row. */
.popwrap{position:relative;display:inline-block}
/* FIXED, not absolute: these open inside tables that scroll horizontally, and an absolutely
   positioned child of an overflow:auto container gets clipped. Position is computed on open. */
.pop{position:fixed;z-index:60;width:320px;
  background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;
  box-shadow:0 12px 32px rgba(0,0,0,.45);text-align:left;cursor:default}
.pop::before{content:"";position:absolute;top:-7px;right:18px;width:12px;height:12px;pointer-events:none;
  background:var(--card);border-left:1px solid var(--line);border-top:1px solid var(--line);
  transform:rotate(45deg)}
.pop-h{margin:0 0 3px;font-size:13px;font-weight:700}
.pop-sub{margin:0 0 10px;font-size:11.5px;color:var(--mut);line-height:1.45}
.pop textarea{width:100%;resize:vertical;font:inherit;font-size:12.5px;line-height:1.5;
  padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.pop textarea:focus{outline:2px solid var(--acc);outline-offset:-1px;border-color:transparent}
.tagpick{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 9px}
.tagchip input{position:absolute;opacity:0;pointer-events:none}
.tagchip span{display:inline-block;font-size:11px;padding:4px 9px;border-radius:999px;cursor:pointer;
  border:1px solid var(--line);color:var(--mut);user-select:none}
.tagchip input:checked+span{background:var(--acc);border-color:var(--acc);color:#0b1020;font-weight:650}
.tagchip input:focus-visible+span{outline:2px solid var(--acc);outline-offset:2px}
.pop-acts{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
.pop-acts button{font-size:12.5px;padding:6px 16px}
@media (max-width:720px){.pop{width:min(320px,calc(100vw - 48px))}}
.alert{padding:11px 14px;border-radius:9px;margin:0 0 18px;font-size:13px;line-height:1.5}
.alert.warn{background:rgba(214,138,0,.10);box-shadow:inset 3px 0 0 #d68a00}
.alert.bad{background:rgba(214,0,60,.10);box-shadow:inset 3px 0 0 #d0224a}
.alert strong{color:var(--fg)}
.alert a{color:var(--acc)}
pre.digest{white-space:pre-wrap;word-break:break-word;font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:12px;line-height:1.6;background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:14px 16px;margin:0;overflow-x:auto}
/* careers-board registry */
.btable{width:100%;border-collapse:collapse}
.btable th{text-align:left;font-size:11px;color:var(--mut);font-weight:600;padding:4px 8px;border-bottom:1px solid var(--line)}
.btable td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top;font-size:12.5px}
tr.bneed{background:rgba(214,138,0,.10)}
tr.bneed td:first-child{box-shadow:inset 3px 0 0 #d68a00}
.bmissing{color:#f0b357;font-weight:600}
.bmissing::before{content:"⚠️ ";}
.bpending{color:var(--acc)}
.bpending::before{content:"⏳ ";}
.addco{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 14px}
.addco input[name=company]{flex:1;min-width:240px}
.addco-hint{font-size:11.5px}
details>summary{cursor:pointer;padding:8px 0;font-weight:650}
.bedit{background:transparent;border:0;cursor:pointer;font-size:15px;padding:2px 6px;border-radius:6px;opacity:.75}
.bedit:hover{background:var(--line);opacity:1;filter:none}
tr.bform td{background:rgba(110,168,254,.06);border-bottom:2px solid var(--line)}
.b-json{background:#1f5b46}.b-html{background:#2b3a67}.b-browser{background:#4a3a2a}
.b-blocked{background:#6b2330}.b-none{background:#4a2a30;color:#f0c6cf}
.b-manual{background:#3a2f67}.b-volatile{background:#6b4a23;font-size:10px}
/* Companies: the four board states stay visually distinct on purpose. "not investigated yet" and
   "no board found" are different facts, and collapsing them is how 53 companies got written off. */
.st-readable{background:#1f5b46}.st-queued{background:#4a3a2a}
.st-needs-url{background:#6b2330}.st-manual{background:#3a2f67}
.st-pending{background:#2b3a67}.st-unknown{background:#3a3f57;color:var(--mut)}
.tier{font-size:10px;background:#2b3a67}.tier-1{background:#1f6b2f}.tier-2{background:#2b3a67}.tier-3{background:#3a3f57}
/* Fixed layout, explicit widths. With auto layout the endpoint column grew to fit 200-character
   agent notes, pushing the actions column off the right edge and letting the rationale text spill
   over the neighbouring cell. Percentages keep it responsive without a horizontal scrollbar. */
.cotable{table-layout:fixed}
/* Beat the global "table td:first-child { white-space: nowrap }" — meant to stop dates and short
   labels breaking, but here the first cell carries a sentence of rationale, which then ran straight
   across the neighbouring columns. (No backticks in this block: it is a template literal.) */
.cotable td,.cotable th,.cotable td:first-child{overflow-wrap:anywhere;white-space:normal}
.cotable col.c-name{width:34%}.cotable col.c-access{width:15%}
.cotable col.c-ep{width:41%}.cotable col.c-act{width:10%}
.comini{font-size:11px;margin-top:2px}
.cowhy{font-size:11px;margin-top:2px}
.conote{font-size:11px;margin-top:3px}
.cotools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 12px}
.cotools .cosearch{flex:1 1 220px;min-width:180px}
.cotools select{background:var(--bg);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:6px 8px;font:inherit}
.cotools label{display:inline-flex;gap:6px;align-items:center;color:var(--mut)}
.costates{margin:0}
.cogroup[hidden]{display:none}
.comatch{margin-left:auto;font-size:11.5px}
.s-applied{background:#2b3a67}.s-screening{background:#3a2f67}.s-interview{background:#1f5b46}.s-offer{background:#1f6b2f}.s-rejected{background:#6b2330}.s-saved{background:#3a3f57}.s-withdrawn{background:#4a3a2a}
form.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
form.grid label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mut)}
input,button,textarea{font:inherit}input,textarea{background:var(--bg);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:8px 10px}
.btn-secondary{background:var(--line);color:var(--fg)}.btn-secondary:hover{filter:brightness(1.15)}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer}
button:hover{filter:brightness(1.08)}
.actions{grid-column:1/-1}form.inline{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.two{display:grid;grid-template-columns:1fr 1fr;gap:24px}@media(max-width:720px){.two{grid-template-columns:1fr}}
details summary{cursor:pointer;padding:6px 0;font-weight:600}
/* Generic hide. NOTE: .flash.hide (below) deliberately overrides this to fade instead of vanish. */
.hide{display:none!important}
.flash.hide{display:block!important}
.flash{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:1000;padding:11px 18px;border-radius:8px;border:1px solid var(--line);box-shadow:0 6px 24px rgba(0,0,0,.35);opacity:1;transition:opacity .5s ease,transform .5s ease}
.flash.hide{opacity:0;transform:translateX(-50%) translateY(-8px)}
.flash.ok{background:#153b2a;border-color:#1f6b2f}.flash.err{background:#3b1520;border-color:#6b2330}
.head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.head-actions form{margin:0}
/* Narrow windows: tighten the chrome so more tabs stay visible before the strip has to scroll. */
@media (max-width:720px){
  :root{--gut:16px}
  header{padding-block:12px}
  h1{font-size:17px}
  nav.tabs .tab{padding:8px 10px;font-size:13px}
  .statbar{gap:12px;font-size:12px}
  .statbar .sb-sp{display:none}
  .ti-co{min-width:0}
  .titem{flex-wrap:wrap}
}
footer{padding:18px 24px}
.clickrow{cursor:pointer}.clickrow:hover{background:rgba(110,168,254,.10)}
.taskdone{opacity:.45}.taskdone td:last-child{text-decoration:line-through}
#pinned{padding:12px 24px 0}
#sections{padding:0 24px 0}
.sec{border:1px solid var(--line);border-radius:12px;background:var(--card);margin-bottom:12px;padding:0;overflow:hidden}
.nladd{display:flex;gap:8px;margin:2px 0 4px}.nladd input{flex:1}
.nlhint{margin:0 0 10px;font-size:12px}
.taskfilters{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.tf{background:var(--bg);color:var(--fg);border:1px solid var(--line);padding:5px 12px;border-radius:999px;font-size:12px;cursor:pointer}
.tf.active{background:var(--acc);color:#fff;border-color:var(--acc)}
.tsearch{flex:1;min-width:120px}
.afilters .tf[data-f]:not([data-f="all"]){border-color:oklch(var(--tring-l) calc(var(--tring-c) * .8) var(--h))}
.afilters .tf.active{background:oklch(var(--ton-bg-l) var(--ton-bg-c) var(--h,213));color:oklch(var(--ton-fg-l) var(--ton-fg-c) var(--h,213));border-color:transparent}
.atype{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:650;white-space:nowrap;
  background:oklch(var(--tbg-l) var(--tbg-c) var(--h));color:oklch(var(--tfg-l) var(--tfg-c) var(--h))}
/* A run boundary is the anchor you scan for — give it the strongest treatment on the page. */
.atype.arun{background:oklch(var(--ton-bg-l) var(--ton-bg-c) var(--h));color:oklch(var(--ton-fg-l) var(--ton-fg-c) var(--h));
  box-shadow:inset 0 0 0 1px oklch(var(--tring-l) var(--tring-c) var(--h))}
tr.runrow td{border-top:2px solid oklch(var(--tring-l) calc(var(--tring-c) * .7) 213);background:rgba(110,168,254,.06)}
.prowact{margin:0}.prowact button{background:transparent;color:var(--mut);border:0;padding:0 4px;font-size:16px;line-height:1;cursor:pointer;border-radius:6px}
.prowact button.xbtn{color:#d06;font-weight:700}.prowact button:hover{background:var(--line);filter:none}
tr.pdismissed{opacity:.45}tr.pdismissed td:nth-child(3){text-decoration:line-through}
tr.rowdismissed{opacity:.45}
.vbadge{font-size:11px;padding:1px 7px;border-radius:6px;white-space:nowrap}
.vyes{background:#1f5b46;color:#c6f0dc}.vno{background:#4a3a2a;color:#f0d9b8}
.volatile-url a{color:#ff6b6b !important;text-decoration:underline wavy #ff6b6b}
.advform{display:inline;margin-left:6px}
.advbtn{background:#2ea06e;color:#04160e;border:0;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;animation:advpulse 2s ease-in-out infinite}
.advbtn:hover{background:#3fd08c}
@keyframes advpulse{0%,100%{box-shadow:0 0 0 0 rgba(46,160,110,.5)}50%{box-shadow:0 0 0 4px rgba(46,160,110,0)}}
tr.rowpending td{background:rgba(46,160,110,.10)}tr.rowpending td:first-child{box-shadow:inset 3px 0 0 #2ea06e}
.volatile-badge{display:inline-block;margin-left:6px;font-size:10px;font-weight:700;color:#ff6b6b;background:rgba(255,107,107,.13);border:1px solid rgba(255,107,107,.5);border-radius:5px;padding:0 5px;white-space:nowrap}
tr.isnew td{background:rgba(46,160,110,.16)}tr.isnew td:first-child{box-shadow:inset 3px 0 0 #2ea06e}
.newbadge{background:#2ea06e;color:#04160e;font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;letter-spacing:.04em}
.repostbadge{display:inline-block;margin-top:4px;font-size:10.5px;font-weight:700;border-radius:6px;
  padding:1px 7px;line-height:1.4;cursor:help}
.rp-certain{color:#ffc9d2;background:rgba(214,0,60,.16);border:1px solid rgba(214,0,60,.55)}
.rp-maybe{color:#f0b357;background:rgba(214,138,0,.14);border:1px solid rgba(214,138,0,.5)}
.appliedhere{display:inline-block;margin-top:4px;font-size:10.5px;font-weight:600;color:#8fd0ff;background:rgba(110,168,254,.14);border:1px solid rgba(110,168,254,.4);border-radius:6px;padding:1px 7px;line-height:1.4}
.s-proposed{background:#2a3550}.s-applied{background:#2b3a67}.s-dismissed{background:#4a2a30;color:#f0c6cf}
.sec .sechead{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;user-select:none}
.sec .sechead h2{margin:0;flex:1}
.sec .secbody{padding:2px 16px 16px}
.secbody .board{margin-bottom:12px}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:50;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto}
.modal{background:var(--card);border:1px solid var(--line);border-radius:14px;max-width:720px;width:100%;padding:24px;position:relative}
.mclose{position:absolute;top:8px;right:10px;background:transparent;color:var(--mut);font-size:22px;padding:2px 8px}
.mclose:hover{filter:none;color:var(--fg)}
.modal h3{margin:0 0 10px;font-size:18px}
.modal h4{margin:16px 0 6px;font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
.mmeta{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;margin:10px 0}
.mrow{display:flex;gap:8px;font-size:13px}.mk{color:var(--mut);min-width:88px}.mv{flex:1}
.mnote{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;margin:10px 0;white-space:pre-wrap;font-size:13px}
.mlist{margin:4px 0;padding-left:18px;font-size:13px}.mlist li{margin:6px 0}
a.btn{display:inline-block;background:var(--acc);color:#fff;padding:6px 12px;border-radius:8px;text-decoration:none;font-size:13px}
.tag{display:inline-block;padding:1px 8px;border-radius:6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.tag-email{background:#264a7a;color:#cfe0ff}.tag-whatsapp{background:#1f5b46;color:#c6f0dc}.tag-linkedin{background:#0a4a6b;color:#c3e7fb}.tag-web{background:#4a3a6b;color:#ddd0f7}
@media(max-width:600px){.mmeta{grid-template-columns:1fr}}
`;

const JS = `
// Careers-board rows: the ✏️ reveals the inline paste-a-URL form for that company and focuses the
// input, so pasting is one click away. Toggling is all client-side; saving is a normal form POST.
// Balloon anchored to its button. Only one open at a time; closes on Escape, on Cancel, and on a
// click outside — and returns focus to the button that opened it so keyboard use is not stranded.
var popOpener=null;
function popCloseAll(except){
  Array.prototype.slice.call(document.querySelectorAll('.pop')).forEach(function(p){
    if(p!==except) p.classList.add('hide');
  });
  Array.prototype.slice.call(document.querySelectorAll('.dismbtn')).forEach(function(b){
    b.setAttribute('aria-expanded','false');
  });
}
function popClose(id){
  var el=document.getElementById(id);
  if(el) el.classList.add('hide');
  popCloseAll();
  if(popOpener){ popOpener.focus(); popOpener=null; }
}
function popToggle(id, btn){
  var el=document.getElementById(id);
  if(!el) return;
  var willOpen=el.classList.contains('hide');
  popCloseAll(el);
  el.classList.toggle('hide', !willOpen);
  if(btn) btn.setAttribute('aria-expanded', willOpen?'true':'false');
  if(willOpen){
    popOpener=btn||null;
    // Position it against the button in viewport coordinates, right-aligned, then clamp so it can
    // never sit off-screen. Fixed positioning is what lets it escape a scrolling table.
    if(btn){
      var b=btn.getBoundingClientRect(), pad=12, w=el.offsetWidth, h=el.offsetHeight;
      var left=Math.min(Math.max(pad, b.right-w), window.innerWidth-w-pad);
      var top=b.bottom+10;
      if(top+h > window.innerHeight-pad) top=Math.max(pad, b.top-h-10); // flip above if no room below
      el.style.left=Math.round(left)+'px';
      el.style.top=Math.round(top)+'px';
    }
    var t=el.querySelector('textarea'); if(t){ t.focus(); }
  } else if(popOpener){ popOpener.focus(); popOpener=null; }
}
document.addEventListener('click', function(e){
  if(e.target.closest && (e.target.closest('.pop') || e.target.closest('.dismbtn'))) return;
  popCloseAll();
});
document.addEventListener('keydown', function(e){
  if(e.key==='Escape'){
    var open=document.querySelector('.pop:not(.hide)');
    if(open) popClose(open.id);
  }
});

function bToggle(id){
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('hide');
  if (!el.classList.contains('hide')) {
    var inp = el.querySelector('input[name=endpoint]');
    if (inp) { inp.focus(); inp.select(); }
  }
}

// Auto-hide the flash toast: keep it visible for 5s, then fade out and remove it.
(function(){
  var f = document.querySelector('.flash');
  if (!f) return;
  setTimeout(function(){
    f.classList.add('hide');
    setTimeout(function(){ f.remove(); }, 550);
  }, 5000);
})();

// Curated-proposals row actions (dismiss, restore, mark-all-seen): submit via fetch and remove
// just that row in place — no full-page reload, so the page never jumps back to the top.
document.addEventListener('submit', function(e){
  var form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  var action = form.getAttribute('action') || '';
  if (action !== '/set-proposal-status') return;
  e.preventDefault();
  var row = form.closest('tr');
  var body = new URLSearchParams(new FormData(form)).toString();
  fetch(action, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body })
    .then(function(r){
      if (!r.ok) throw new Error('request failed');
      if (row){ row.style.transition='opacity .25s'; row.style.opacity='0'; setTimeout(function(){ row.remove(); }, 250); }
    })
    .catch(function(){ form.submit(); }); // fall back to normal submit on error
});

document.getElementById('cvform')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = document.getElementById('cvfile').files[0];
  const msg = document.getElementById('cvmsg');
  if (!f) return;
  msg.textContent = 'Uploading…';
  const res = await fetch('/upload-cv?name=' + encodeURIComponent(f.name), { method:'POST', headers:{'content-type':'application/pdf'}, body: f });
  msg.textContent = res.ok ? 'Saved. Now run /parse-cv in Claude Code.' : 'Upload failed.';
});

window.openDetail = function(id){
  var d = window.__DETAILS__ && window.__DETAILS__[id];
  if(!d) return;
  document.getElementById('mbody').innerHTML = d;
  document.getElementById('overlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
};
window.closeDetail = function(){
  document.getElementById('overlay').style.display = 'none';
  document.body.style.overflow = '';
};
window.openDismiss = function(id, label){
  document.getElementById('dismissId').value = id;
  document.getElementById('dismissWhat').textContent = label || '';
  document.getElementById('dismissReason').value = '';
  document.getElementById('dismissOverlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  setTimeout(function(){ document.getElementById('dismissReason').focus(); }, 40);
};
window.closeDismiss = function(){
  document.getElementById('dismissOverlay').style.display = 'none';
  document.body.style.overflow = '';
};
document.addEventListener('keydown', function(e){ if(e.key === 'Escape'){ window.closeDetail(); window.closeDismiss(); } });
// Wire the lead × buttons to the reason popup (they open the modal instead of submitting directly).
Array.prototype.slice.call(document.querySelectorAll('.dbtn')).forEach(function(b){
  b.addEventListener('click', function(e){ e.stopPropagation(); window.openDismiss(b.getAttribute('data-id'), b.getAttribute('data-label')); });
});

// Tabs. The active pane is already chosen server-side; this handles clicking and deep links.
// Precedence on load: ?tab= (set by a POST redirect, so an action returns you to its pane) > #hash
// (bookmark / refresh) > Today. Deliberately NOT restoring the last-used tab from storage: opening
// the dashboard should always land on Today — that is the whole point of the layout.
(function(){
  var panels=document.getElementById('panels');
  var strip=document.querySelector('nav.tabs');
  if(!panels||!strip) return;
  var PAGE = location.pathname === '/settings' ? 'settings' : 'work';
  var tabs=Array.prototype.slice.call(strip.querySelectorAll('.tab'));
  var ids=tabs.map(function(b){return b.getAttribute('data-tab');});

  function show(id, push){
    if(ids.indexOf(id)===-1) return false;
    tabs.forEach(function(b){
      var meOn=b.getAttribute('data-tab')===id;
      b.classList.toggle('on',meOn); b.setAttribute('aria-selected',meOn?'true':'false');
    });
    Array.prototype.slice.call(panels.querySelectorAll('.tabpanel')).forEach(function(p){
      var meOn=p.getAttribute('data-tab')===id;
      p.classList.toggle('on',meOn);
      if(meOn){ p.removeAttribute('hidden'); } else { p.setAttribute('hidden',''); }
    });
    if(push && location.hash.slice(1)!==id){ history.replaceState(null,'','#'+id); }
    return true;
  }

  tabs.forEach(function(b){
    b.addEventListener('click', function(){ show(b.getAttribute('data-tab'), true); window.scrollTo(0,0); });
  });

  // A ?tab= from a redirect wins and is then cleaned out of the URL so refresh doesn't re-pin it.
  var qs=new URLSearchParams(location.search);
  var fromQuery=qs.get('tab');
  if(fromQuery && ids.indexOf(fromQuery)!==-1){
    show(fromQuery,true);
  } else {
    show(location.hash.slice(1), false); // no hash -> server default (Today) stays active
  }

  window.addEventListener('hashchange', function(){ show(location.hash.slice(1), false); });

  // Stamp every POST form with the pane it was submitted from, so the server can send us back here
  // instead of dumping us on the first tab. Runs in the capture phase so it lands before any
  // fetch-based handler (proposals) calls preventDefault.
  document.addEventListener('submit', function(e){
    var f=e.target;
    if(!(f instanceof HTMLFormElement)) return;
    if((f.getAttribute('method')||'').toLowerCase()!=='post') return;
    var cur=(strip.querySelector('.tab.on')||{}).getAttribute
          ? strip.querySelector('.tab.on').getAttribute('data-tab') : '';
    ['_tab','_page'].forEach(function(n){
      var ex=f.querySelector('input[name="'+n+'"]');
      if(!ex){ ex=document.createElement('input'); ex.type='hidden'; ex.name=n; f.appendChild(ex); }
      ex.value = n==='_tab' ? cur : PAGE;
    });
  }, true);
})();

// Activity: filter by type family + free-text search. Same client-side pattern as tasks/proposals.
(function(){
  var sec=document.querySelector('.sec[data-id="activity"]');
  if(!sec) return;
  var rows=function(){return Array.prototype.slice.call(sec.querySelectorAll('tbody tr'));};
  var fam='all', q='';
  function apply(){
    var shown=0;
    rows().forEach(function(tr){
      var okF=(fam==='all')||(tr.getAttribute('data-fam')===fam);
      var okQ=!q||(tr.textContent||'').toLowerCase().indexOf(q)>=0;
      var on=okF&&okQ; tr.style.display=on?'':'none'; if(on) shown++;
    });
    var n=sec.querySelector('.acount'); if(n) n.textContent=shown+' shown';
  }
  sec.querySelectorAll('.tf').forEach(function(b){
    b.addEventListener('click', function(){
      sec.querySelectorAll('.tf').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active'); fam=b.getAttribute('data-f'); apply();
    });
  });
  var s=sec.querySelector('.asearch');
  if(s) s.addEventListener('input', function(){ q=s.value.toLowerCase().trim(); apply(); });
  apply();
})();

// Companies section: search + sort + state chips + collapse-all, all client-side.
// ~230 rows across a handful of markets is too many to scan, so the groups collapse and the search
// is what makes the page usable rather than decorative. A search that matches inside a collapsed
// group OPENS that group — otherwise the box would appear to find nothing.
(function(){
  var sec=document.querySelector('.sec[data-id="companies"]');
  if(!sec) return;
  var groups=Array.prototype.slice.call(sec.querySelectorAll('.cogroup'));
  var q='', state='all', sort='name';

  function rowsOf(g){ return Array.prototype.slice.call(g.querySelectorAll('tr.corow')); }
  // The edit form is a SECOND <tr> right after its row. It must follow its row when sorting and
  // hide with it when filtering, or the page silently pairs a form with the wrong company.
  function formOf(tr){ var n=tr.nextElementSibling; return (n && n.classList.contains('bform'))?n:null; }

  function apply(){
    var total=0;
    groups.forEach(function(g){
      var shown=0;
      rowsOf(g).forEach(function(tr){
        var okQ=!q||((tr.getAttribute('data-q')||'').indexOf(q)>=0);
        var okS=(state==='all')||(tr.getAttribute('data-state')===state);
        var vis=okQ&&okS;
        tr.style.display=vis?'':'none';
        var f=formOf(tr); if(f&&!vis) f.style.display='none'; else if(f) f.style.display='';
        if(vis) shown++;
      });
      var c=g.querySelector('.cocount'); if(c) c.textContent=shown;
      g.hidden=(shown===0);
      // A filtered-down group is worth opening; restore the user's own choice when the box clears.
      if((q||state!=='all')&&shown>0) g.open=true;
      total+=shown;
    });
    var m=sec.querySelector('.comatch');
    if(m) m.textContent=(q||state!=='all')?(total+' matching'):'';
  }

  function resort(){
    groups.forEach(function(g){
      var body=g.querySelector('tbody'); if(!body) return;
      var pairs=rowsOf(g).map(function(tr){ return [tr, formOf(tr)]; });
      pairs.sort(function(a,b){
        if(sort==='name') return (a[0].getAttribute('data-name')||'').localeCompare(b[0].getAttribute('data-name')||'');
        if(sort==='tier'){
          var d=(a[0].getAttribute('data-tier')||'9').localeCompare(b[0].getAttribute('data-tier')||'9');
          return d||((a[0].getAttribute('data-name')||'').localeCompare(b[0].getAttribute('data-name')||''));
        }
        var e=(a[0].getAttribute('data-state')||'').localeCompare(b[0].getAttribute('data-state')||'');
        return e||((a[0].getAttribute('data-name')||'').localeCompare(b[0].getAttribute('data-name')||''));
      });
      pairs.forEach(function(p){ body.appendChild(p[0]); if(p[1]) body.appendChild(p[1]); });
    });
  }

  var s=sec.querySelector('.cosearch');
  if(s) s.addEventListener('input', function(){ q=s.value.toLowerCase().trim(); apply(); });
  var so=sec.querySelector('.cosort');
  if(so) so.addEventListener('change', function(){ sort=so.value; resort(); });
  sec.querySelectorAll('.costates .tf').forEach(function(b){
    b.addEventListener('click', function(){
      sec.querySelectorAll('.costates .tf').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active'); state=b.getAttribute('data-f'); apply();
    });
  });
  var ex=sec.querySelector('.coexpand');
  if(ex) ex.addEventListener('click', function(){
    var open=ex.getAttribute('data-open')==='1';
    groups.forEach(function(g){ g.open=!open; });
    ex.setAttribute('data-open', open?'0':'1');
    ex.textContent=open?'Expand all':'Collapse all';
  });
  apply();
})();

// Tasks section: Open/Done/All filter chips + text search (client-side, default = Open).
(function(){
  var sec=document.querySelector('.sec[data-id="tasks"]');
  if(!sec) return;
  var rows=function(){return Array.prototype.slice.call(sec.querySelectorAll('tbody tr'));};
  var filter='open', q='';
  function apply(){
    rows().forEach(function(tr){
      var st=tr.getAttribute('data-status')||'';
      var okF=(filter==='all')||(st===filter);
      var okQ=!q||(tr.textContent||'').toLowerCase().indexOf(q)>=0;
      tr.style.display=(okF&&okQ)?'':'none';
    });
  }
  sec.querySelectorAll('.tf').forEach(function(b){
    b.addEventListener('click', function(){
      sec.querySelectorAll('.tf').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active'); filter=b.getAttribute('data-f'); apply();
    });
  });
  var s=sec.querySelector('.tsearch');
  if(s) s.addEventListener('input', function(){ q=s.value.toLowerCase().trim(); apply(); });
  apply();
})();

// Proposals (roles) section: Active/Proposed/Applied/Dismissed/All filter + search. Default = Active (hides dismissed).
(function(){
  var sec=document.querySelector('.sec[data-id="proposals"]');
  if(!sec) return;
  var rows=function(){return Array.prototype.slice.call(sec.querySelectorAll('tbody tr'));};
  var filter='active', q='';
  function apply(){
    rows().forEach(function(tr){
      var st=tr.getAttribute('data-status')||'';
      var okF=(filter==='all')||(filter==='new'?tr.getAttribute('data-new')==='yes':(filter==='active'?st!=='dismissed':st===filter));
      var okQ=!q||(tr.textContent||'').toLowerCase().indexOf(q)>=0;
      tr.style.display=(okF&&okQ)?'':'none';
    });
  }
  sec.querySelectorAll('.pfilters .tf').forEach(function(b){
    b.addEventListener('click', function(){
      sec.querySelectorAll('.pfilters .tf').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active'); filter=b.getAttribute('data-f'); apply();
    });
  });
  var s=sec.querySelector('.psearch');
  if(s) s.addEventListener('input', function(){ q=s.value.toLowerCase().trim(); apply(); });
  apply();
})();

// Leads section: Active/<statuses>/Dismissed/All filter + search. Default = Active (hides dismissed).
(function(){
  var sec=document.querySelector('.sec[data-id="leads"]');
  if(!sec) return;
  var rows=function(){return Array.prototype.slice.call(sec.querySelectorAll('tbody tr'));};
  var filter='active', q='';
  function apply(){
    rows().forEach(function(tr){
      var st=tr.getAttribute('data-status')||'';
      var okF=(filter==='all')||(filter==='active'?st!=='dismissed':st===filter);
      var okQ=!q||(tr.textContent||'').toLowerCase().indexOf(q)>=0;
      tr.style.display=(okF&&okQ)?'':'none';
    });
  }
  sec.querySelectorAll('.lfilters .tf').forEach(function(b){
    b.addEventListener('click', function(){
      sec.querySelectorAll('.lfilters .tf').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active'); filter=b.getAttribute('data-f'); apply();
    });
  });
  var s=sec.querySelector('.lsearch');
  if(s) s.addEventListener('input', function(){ q=s.value.toLowerCase().trim(); apply(); });
  apply();
})();
`;

// ---------- request handling ----------

function today() {
  return new Date().toISOString().slice(0, 10);
}
function nowISO() {
  return new Date().toISOString();
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function parseForm(buf) {
  const params = new URLSearchParams(buf.toString("utf8"));
  const obj = {};
  // Repeated keys (a group of checkboxes) used to collapse to the LAST value, silently discarding
  // every other selection. Joined instead, so multi-value fields work.
  for (const [k, v] of params) obj[k] = k in obj ? `${obj[k]},${v}` : v;
  return obj;
}

// Every mutation ends in a 303 back to a GET. Without carrying the tab, that would dump you on
// Today after every dismiss/advance/save — so the client stamps each POST form with the pane it was
// submitted from (`_tab`) and the page it belongs to (`_page`), and we hand both back.
function redirect(res, flash) {
  const parts = [];
  if (flash) {
    parts.push(`flash=${encodeURIComponent(flash.kind)}`, `msg=${encodeURIComponent(flash.msg)}`);
  }
  if (res._returnTab) parts.push(`tab=${encodeURIComponent(res._returnTab)}`);
  const base = res._returnPage === "settings" ? "/settings" : "/";
  res.writeHead(303, { Location: base + (parts.length ? `?${parts.join("&")}` : "") });
  res.end();
}

// Add a company to a market list by hand, then immediately look up its careers board.
//
// Two writes plus a background job:
//   1. append the row to data/markets/<market>.md (tier 3 provisional — a real ranking needs the
//      prioritization agent, and pretending otherwise would put an unresearched company above
//      researched ones),
//   2. create a `pending` registry row so the Careers boards view shows it being worked on,
//   3. spawn scripts/discover-board.mjs DETACHED. It writes its result through record.mjs, which
//      takes the data/ lock — and we are holding that lock right now, so it must not be awaited.
//      It blocks harmlessly for the few milliseconds until this request releases.
async function handleAddCompany(form) {
  const market = String(form.market || "").trim();
  const company = String(form.company || "").trim().replace(/\s+/g, " ");
  if (!company) return { flash: { kind: "err", msg: "Enter a company name." } };
  const file = path.join(DATA, "markets", `${market}.md`);
  const { rows, headers } = await readTable(file);
  if (!headers.length) return { flash: { kind: "err", msg: `No market list called "${market}".` } };

  const key = normCompanyKey(company);
  const dupe = rows.find((r) => normCompanyKey(r.company) === key);
  if (dupe) {
    return { flash: { kind: "err", msg: `${dupe.company} is already in ${market}.` } };
  }

  await appendTableRow(
    file,
    {
      company,
      tier: "3",
      last_reviewed: today(),
      notes: `Added manually from the dashboard ${today()}. Tier 3 is provisional — not yet researched or ranked; run /markets to score it properly. Careers board lookup was triggered on add.`,
    },
    "bottom"
  );

  // Mark the board as being looked up, unless we already know this company's board.
  const boards = await readTable(BOARDS_FILE);
  const known = boards.rows.find((r) => boardKey(r.company) === boardKey(company));
  if (!known) {
    await ensureTable(BOARDS_FILE, BOARDS_TEMPLATE);
    const text = await fs.readFile(BOARDS_FILE, "utf8");
    const lines = text.split("\n");
    const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l));
    const row = {
      company, market, ats: "", endpoint: "", access: "pending", volatile: "no",
      last_verified: today(), notes: `Added ${today()} from the dashboard; automatic board discovery in progress.`,
    };
    lines.splice(headerIdx + 2, 0, `| ${BOARD_HEADERS.map((h) => sanitizeCell(row[h])).join(" | ")} |`);
    await writeFileAtomic(BOARDS_FILE, lines.join("\n"));
  }

  await logActivity(
    "market-company-added",
    `${company} added to ${market} manually (tier 3 provisional).${known ? ` Board already known (${known.access}).` : " Board discovery started."}`
  );

  if (!known) {
    const child = spawn("node", [path.join(ROOT, "scripts", "discover-board.mjs"), company, market], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  return {
    company,
    flash: {
      kind: "ok",
      msg: known
        ? `${company} added to ${market}. Board already on file (${known.access}).`
        : `${company} added to ${market} — searching for its careers board now, reload in a moment.`,
    },
  };
}

// Decline a detected stage advance. Clears the pending fields so it leaves the Today queue and
// records the rejection, so an agent seeing the same evidence tomorrow does not raise it again.
// The reason is deliberately optional — a mandatory field just produces empty reasons.
async function handleDismissAdvance(form) {
  const id = String(form.id || "").trim();
  const note = String(form.note || "").trim();
  const dir = path.join(DATA, "applications");
  const recs = await readRecordDir(dir);
  const match = recs.find((r) => r.data.id === id);
  if (!match) return { kind: "err", msg: `No application ${id}.` };
  const stage = match.data.pending_stage;
  if (!stage) return { kind: "err", msg: `${match.data.company} has no pending advance.` };
  const merged = {
    ...match.data,
    last_update: today(),
    pending_stage: "",
    pending_note: "",
    pending_since: "",
    advance_dismissed_stage: stage,
    advance_dismissed_date: today(),
    advance_dismissed_note: note,
  };
  // Field order comes from the record itself, as every other dashboard writer does —
  // APPLICATION_ORDER lives in record.mjs and is not in scope here.
  await writeFileAtomic(path.join(dir, match.file), stringifyFrontmatter(merged, match.body, Object.keys(merged)));
  await logActivity(
    "advance-dismissed",
    `${merged.company} — ${merged.role}: declined the advance to ${stage}${note ? ` — ${note}` : " (no reason given)"}`
  );
  return { kind: "ok", msg: `${merged.company}: advance to ${stage} dismissed — it will not be raised again.` };
}

// One handler for both the row trash icon and the batch button, so they cannot diverge in what
// "removed" means.
//
// Writes the table directly rather than shelling out to record.mjs. The POST path already holds the
// data/ lock and record.mjs takes the same lock on startup, so calling it from in here deadlocks
// until the timeout -- exactly what the note at the top of this file warns about.
async function handleDismissBoard(form) {
  const text = await fs.readFile(BOARDS_FILE, "utf8");
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l));
  const { headers, rows } = await readTable(BOARDS_FILE);
  const stamp = today();

  const targets =
    form.scope === "none"
      ? rows.filter((r) => r.access === "none" && !String(r.dismissed || "").trim())
      : rows.filter((r) => boardKey(r.company) === boardKey(String(form.company || "")));

  if (!targets.length) throw new Error(form.scope === "none" ? "nothing to remove" : "no matching board row");

  for (const r of targets) {
    const i = rows.indexOf(r);
    const merged = { ...r, dismissed: stamp };
    lines[headerIdx + 2 + i] = `| ${headers.map((h) => sanitizeCell(merged[h] ?? "")).join(" | ")} |`;
  }
  await writeFileAtomic(BOARDS_FILE, lines.join("\n"));

  const what =
    form.scope === "none"
      ? `${targets.length} compan${targets.length === 1 ? "y" : "ies"} with no careers page`
      : targets[0].company;
  await logActivity("board-dismissed", `Removed from the registry: ${what}`);
  return form.scope === "none"
    ? `Removed ${what}. Scouts will skip them from now on.`
    : `${what} removed — scouts will skip it.`;
}

async function handleSetBoard(form) {
  const companyIn = String(form.company || "").trim();
  if (!companyIn) throw new Error("set-board needs a company");
  const endpoint = String(form.endpoint || "").trim();
  await ensureTable(BOARDS_FILE, BOARDS_TEMPLATE);
  const { rows } = await readTable(BOARDS_FILE);
  const key = boardKey(companyIn);
  const idx = rows.findIndex((r) => boardKey(r.company) === key);
  const prev = idx >= 0 ? rows[idx] : {};
  const stamp = today();
  // Keep the agent's original finding readable — it explains WHY the board was a dead end, which
  // is still true and still useful even once a URL is pasted over it.
  const priorNote = String(prev.notes || "").replace(/^MANUAL:[^·]*·\s*previously:\s*/, "");
  const merged = {
    company: prev.company || companyIn,
    market: String(form.market || prev.market || "").trim(),
    ats: prev.ats || "unknown",
    endpoint,
    // Clearing the URL must not leave access="manual" — that claims a user-supplied endpoint that
    // no longer exists. Fall back to "none" (not found), which is what the row means again.
    access: endpoint ? "manual" : prev.access === "manual" ? "none" : prev.access || "none",
    volatile: prev.volatile || "no",
    last_verified: stamp,
    notes: endpoint
      ? `MANUAL: URL supplied via dashboard ${stamp}, NOT yet verified — scout to test and reclassify access.${
          priorNote ? ` · previously: ${priorNote}` : ""
        }`
      : priorNote,
  };
  const text = await fs.readFile(BOARDS_FILE, "utf8");
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l));
  const row = `| ${BOARD_HEADERS.map((h) => sanitizeCell(merged[h])).join(" | ")} |`;
  if (idx >= 0) lines[headerIdx + 2 + idx] = row;
  else lines.splice(headerIdx + 2, 0, row);
  await writeFileAtomic(BOARDS_FILE, lines.join("\n"));
  await logActivity(
    "board-manual",
    endpoint
      ? `${merged.company}: careers URL set manually -> ${endpoint} (access=manual, awaiting scout verification)`
      : `${merged.company}: careers URL cleared`
  );
  return { company: merged.company, cleared: !endpoint };
}

// The config file was hand-edited only: of its keys, the UI edited none. This writes it through the
// same frontmatter helpers everything else uses, preserving the comment body so the file stays
// self-documenting for anyone who opens it in an editor.
//
// Allowlisted keys, not "whatever the form posted" — this writes a file the agents and the scheduler
// read, and an unknown key silently accepted is a setting that appears to work and does nothing.
const CONFIG_KEYS = [
  "dashboard_port",
  "approval_channels",
  "whatsapp_owner_jid",
  "apply_stop_before",
  "whatsapp_web_enabled",
  "linkedin_enabled",
  "ignored_chats",
  "company_aliases",
  "max_spend_per_run_usd",
  "max_spend_per_month_usd",
];

async function handleSaveConfig(form) {
  const file = path.join(ROOT, "config", "job-seeker.config.md");
  const existing = await safeRead(file);
  const { data, body } = parseFrontmatter(existing);
  const merged = { ...data };
  for (const k of CONFIG_KEYS) {
    if (!(k in form)) continue; // absent field = not on this form, leave it alone
    merged[k] = sanitizeCell(String(form[k] ?? "").trim());
  }
  // Numbers must be numbers or blank; a typo here would otherwise be compared as a string and
  // silently disable a spend cap.
  for (const k of ["max_spend_per_run_usd", "max_spend_per_month_usd"]) {
    const v = String(merged[k] ?? "").trim();
    if (v && !/^\d+(\.\d+)?$/.test(v)) {
      throw new Error(`${k} must be a number or blank (got ${JSON.stringify(v)})`);
    }
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, stringifyFrontmatter(merged, body || "", Object.keys(merged)));
  await logActivity("config-edit", `Updated settings: ${CONFIG_KEYS.filter((k) => k in form).join(", ")}`);
}

// Actions the Setup page may run. An ALLOWLIST of named actions mapped to fixed scripts — never a
// command from the request. This endpoint changes OS state (installs launch agents), so the set of
// things it can do is closed and auditable, exactly as scripts/browser-agent.sh does.
const ACTIONS = new Map([
  ["probe", { script: "scripts/browser-probe.mjs", runner: "node", detached: false }],
  ["install-browser-agent", { script: "scripts/install-browser-agent.sh", runner: "bash", detached: false }],
  ["set-schedule", { script: "scripts/set-schedule.sh", runner: "bash", detached: false, arg: "time" }],
  ["remove-schedule", { script: "scripts/set-schedule.sh", runner: "bash", detached: false, fixedArgs: ["--remove"] }],
]);

async function handleRunAction(form) {
  const name = String(form.action_name || "");
  const spec = ACTIONS.get(name);
  if (!spec) throw new Error(`Unknown action: ${JSON.stringify(name).slice(0, 40)}`);

  const args = [path.join(ROOT, spec.script), ...(spec.fixedArgs || [])];
  if (spec.arg === "time") {
    const t = String(form.time || "").trim();
    // Validated here as well as in the script: defence in depth on the boundary that faces the web.
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`Invalid time ${JSON.stringify(t)} — expected HH:MM`);
    args.push(t);
  }

  const out = await new Promise((resolve) => {
    execFile(spec.runner, args, { cwd: ROOT, timeout: 120_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, text: String(stdout || stderr || err?.message || "").trim() })
    );
  });
  await logActivity("setup-action", `${name}: ${out.ok ? "ok" : "failed"} — ${out.text.slice(0, 120)}`);
  if (!out.ok) throw new Error(out.text.split("\n")[0] || `${name} failed`);
  return out.text.split("\n").filter(Boolean).pop() || `${name} done`;
}

async function handleSaveCriteria(form) {
  const file = path.join(DATA, "criteria.md");
  const { body } = parseFrontmatter(await safeRead(file));
  const keys = ["markets", "roles", "locations", "seniority", "weight_market", "weight_role", "weight_cv"];
  const data = {};
  for (const k of keys) data[k] = (form[k] ?? "").trim();
  await fs.mkdir(DATA, { recursive: true });
  await writeFileAtomic(file, stringifyFrontmatter(data, body || "# Notes\n", keys));
  await logActivity("criteria-edit", `Updated criteria: markets=[${data.markets}] roles=[${data.roles}]`);
}

async function handleAddMarket(form) {
  const market = (form.market ?? "").trim();
  if (!market) return;
  const file = path.join(DATA, "criteria.md");
  const { data, body } = parseFrontmatter(await safeRead(file));
  const list = (data.markets ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.some((m) => m.toLowerCase() === market.toLowerCase())) list.push(market);
  data.markets = list.join(", ");
  await writeFileAtomic(file, stringifyFrontmatter(data, body, Object.keys(data)));
  await logActivity("market-add", `Added market: ${market} (run /markets to build the list)`);
}

async function handleAddTask(form) {
  const file = path.join(DATA, "tasks.md");
  await ensureTable(file, "# Tasks\n\n| id | due_date | type | who | related_id | status | detail |\n|----|----------|------|-----|------------|--------|--------|\n");
  await appendTableRow(file, {
    id: newId("task"),
    due_date: (form.due_date ?? "").trim(),
    type: (form.type ?? "followup").trim(),
    who: sanitizeCell(form.who),
    related_id: (form.related_id ?? "").trim(),
    status: "open",
    detail: sanitizeCell(form.detail),
  });
  await logActivity("task-add", `Manual task: ${sanitizeCell(form.detail)}`);
}

// Heuristic natural-language → structured task. Parses a due date, a "who", and a type; keeps the
// full original text as the detail so nothing is lost. Dependency-free (no LLM needed server-side).
function parseNL(text) {
  const raw = String(text || "").trim();
  const lc = raw.toLowerCase();
  const base = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return iso(d); };

  let due = "";
  let m;
  if ((m = lc.match(/\b(\d{4}-\d{2}-\d{2})\b/))) due = m[1];
  else if (/\bday after tomorrow\b/.test(lc)) due = addDays(2);
  else if (/\btomorrow\b/.test(lc)) due = addDays(1);
  else if (/\btoday\b/.test(lc)) due = addDays(0);
  else if (/\bnext week\b/.test(lc)) due = addDays(7);
  else if ((m = lc.match(/\bin (\d+)\s*(day|days|week|weeks)\b/))) due = addDays(parseInt(m[1], 10) * (/week/.test(m[2]) ? 7 : 1));
  else if ((m = lc.match(/\b(mon|tue|wed|thu|fri|sat|sun)(?:day|nesday|rsday|urday)?\b/))) {
    const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    let diff = (map[m[1]] - base.getDay() + 7) % 7; if (diff === 0) diff = 7;
    due = addDays(diff);
  } else if ((m = lc.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/)) ||
             (m = lc.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/))) {
    const mo = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    let mon, day;
    if (mo[m[1]] !== undefined) { mon = mo[m[1]]; day = parseInt(m[2], 10); } else { day = parseInt(m[1], 10); mon = mo[m[2]]; }
    const cand = new Date(base.getFullYear(), mon, day);
    if (cand < base) cand.setFullYear(base.getFullYear() + 1);
    due = iso(cand);
  }

  let type = "followup";
  if (/\binterview\b/.test(lc)) type = "interview";
  else if (/\b(call|phone|ring|dial)\b/.test(lc)) type = "call";
  else if (/\b(meet|meeting|schedule|catch up|coffee|sync)\b/.test(lc)) type = "meeting";
  else if (/\b(review|look at|check|read|go over)\b/.test(lc)) type = "review";
  else if (/\b(apply|application|submit)\b/.test(lc)) type = "apply";
  else if (/\b(email|mail|send|reply|respond|write|forward)\b/.test(lc)) type = "email";

  let who = "";
  if ((m = raw.match(/\b(?:with|to|call|email|ping|contact|meet|for|from)\s+([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+)?)/))) who = m[1];
  else if ((m = raw.match(/@([A-Za-z][\w.'-]+)/))) who = m[1];
  // Drop trailing date-ish words the name-capture may have swallowed (e.g. "Dana Friday" -> "Dana").
  if (who) {
    const STOP = new Set(["monday","tuesday","wednesday","thursday","friday","saturday","sunday","mon","tue","wed","thu","fri","sat","sun","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec","today","tomorrow","next","about","on","in","at"]);
    const kept = [];
    for (const w of who.split(/\s+/)) { if (STOP.has(w.toLowerCase())) break; kept.push(w); }
    who = kept.join(" ");
  }

  return { due_date: due, type, who, detail: raw };
}

async function handleAddTaskNL(form) {
  const raw = (form.nl ?? "").trim();
  if (!raw) return;
  const p = parseNL(raw);
  const file = path.join(DATA, "tasks.md");
  await ensureTable(file, "# Tasks\n\n| id | due_date | type | who | related_id | status | detail |\n|----|----------|------|-----|------------|--------|--------|\n");
  await appendTableRow(file, {
    id: newId("task"),
    due_date: p.due_date,
    type: p.type,
    who: sanitizeCell(p.who),
    related_id: "",
    status: "open",
    detail: sanitizeCell(p.detail),
  });
  await logActivity("task-add-nl", `NL task → [${p.type}${p.due_date ? " " + p.due_date : ""}${p.who ? " @" + p.who : ""}] ${sanitizeCell(p.detail)}`);
}

async function handleSetAppStatus(form) {
  const id = (form.id ?? "").trim();
  const status = (form.status ?? "").trim();
  const reason = (form.reason ?? "").trim();
  if (!id || !status) return;
  const dir = path.join(DATA, "applications");
  const recs = await readRecordDir(dir);
  const rec = recs.find((r) => r.data.id === id || r.id === id);
  if (!rec) return;
  const data = { ...rec.data, status };
  if (status === "Dismissed") data.dismiss_reason = reason;
  else delete data.dismiss_reason; // clear on restore
  await writeFileAtomic(path.join(dir, rec.file), stringifyFrontmatter(data, rec.body, Object.keys(data)));
  await logActivity("lead-" + status.toLowerCase(), `${data.company} — ${data.role} → ${status}${reason ? " (" + sanitizeCell(reason) + ")" : ""}`);
}

// One-click "Advance": apply the detected pending_stage to status (forward-only), fold pending_note
// into next_action, and clear the pending fields.
async function handleAdvanceAppStage(form) {
  const id = (form.id ?? "").trim();
  if (!id) return;
  const dir = path.join(DATA, "applications");
  const recs = await readRecordDir(dir);
  const rec = recs.find((r) => r.data.id === id || r.id === id);
  if (!rec) return;
  const d = rec.data;
  const target = (d.pending_stage || "").trim();
  if (!target) return;
  // forward-only: don't move backward if pending_stage ranks below current status
  const newStatus = statusIndex(target) >= statusIndex(d.status) ? target : d.status;
  const data = { ...d, status: newStatus, last_update: today(), next_action: d.pending_note || d.next_action || "", pending_stage: "", pending_note: "" };
  await writeFileAtomic(path.join(dir, rec.file), stringifyFrontmatter(data, rec.body, Object.keys(data)));
  await logActivity("stage-advance", `${data.company} — ${data.role} → ${newStatus} (confirmed via dashboard)`);
}

async function handleSetTaskStatus(form) {
  const id = (form.id ?? "").trim();
  const status = (form.status ?? "").trim();
  if (!id || !status) return;
  const file = path.join(DATA, "tasks.md");
  const text = await fs.readFile(file, "utf8");
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l));
  if (headerIdx === -1) return;
  const headers = lines[headerIdx].replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const idIdx = headers.indexOf("id");
  const stIdx = headers.indexOf("status");
  for (let i = headerIdx + 2; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const cells = lines[i].replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    if (cells[idIdx] === id) {
      cells[stIdx] = status;
      lines[i] = `| ${cells.join(" | ")} |`;
      break;
    }
  }
  await writeFileAtomic(file, lines.join("\n"));
  await logActivity("task-" + status, `Task ${id} → ${status} (dashboard)`);
}

async function handleMarkAllProposalsSeen() {
  const dir = path.join(DATA, "proposals");
  const recs = await readRecordDir(dir);
  let n = 0;
  for (const rec of recs) {
    if ((rec.data.seen || "no") !== "yes" && (rec.data.status || "proposed") === "proposed") {
      const data = { ...rec.data, seen: "yes" };
      await writeFileAtomic(path.join(dir, rec.file), stringifyFrontmatter(data, rec.body, Object.keys(data)));
      n++;
    }
  }
  await logActivity("proposals-seen", `Marked ${n} new roles as seen.`);
}

async function handleSetProposalStatus(form) {
  const id = (form.id ?? "").trim();
  const status = (form.status ?? "").trim();
  if (!id || !status) return;
  const dir = path.join(DATA, "proposals");
  const recs = await readRecordDir(dir);
  const rec = recs.find((r) => r.data.id === id || r.id === id);
  if (!rec) return;
  const data = { ...rec.data, status };
  if (status === "dismissed") {
    data.dismiss_tags = String(form.tags || "").trim();
    data.dismiss_reason = String(form.reason || "").trim();
  }
  await writeFileAtomic(path.join(dir, rec.file), stringifyFrontmatter(data, rec.body, Object.keys(data)));
  const why = [data.dismiss_tags, data.dismiss_reason].filter(Boolean).join(" — ");
  await logActivity("proposal-" + status, `Proposal ${data.company} — ${data.role} → ${status}${why ? ` (${why})` : ""}`);
}

async function handleAddContact(form) {
  const file = path.join(DATA, "contacts.md");
  await ensureTable(file, "# Contacts\n\n| id | name | company | role | email | linkedin_url | notes |\n|----|------|---------|------|-------|--------------|-------|\n");
  await appendTableRow(file, {
    id: newId("contact"),
    name: sanitizeCell(form.name),
    company: sanitizeCell(form.company),
    role: sanitizeCell(form.role),
    email: sanitizeCell(form.email),
    linkedin_url: sanitizeCell(form.linkedin_url),
    notes: sanitizeCell(form.notes),
  });
  await logActivity("contact-add", `Manual contact: ${sanitizeCell(form.name)}`);
}

async function handleUploadCV(req, url) {
  const name = (url.searchParams.get("name") || "cv.pdf").replace(/[^\w.\-]+/g, "_");
  const buf = await readBody(req);
  if (!buf.length) throw new Error("empty upload");
  await fs.mkdir(CV_DIR, { recursive: true });
  const dest = path.join(CV_DIR, name);
  await fs.writeFile(dest, buf);
  await logActivity("cv-upload", `Uploaded CV: templates/cv/${name} (run /parse-cv)`);
  return dest;
}


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

// Reject cross-site POSTs.
//
// The dashboard has no authentication -- binding to loopback IS the authentication. But loopback
// does not stop a WEB PAGE you happen to be visiting from submitting a form to
// http://localhost:4319/dismiss-proposal: a plain cross-origin form POST needs no CORS permission,
// and while the attacker cannot read the response, the write still lands. Any site open in your
// browser could quietly dismiss proposals or rewrite records.
//
// Browsers label those requests, so the fix is to check the label:
//   * Sec-Fetch-Site  -- sent by every current browser; "cross-site"/"same-site" both mean not us.
//   * Origin          -- present on all cross-origin form POSTs.
//   * Referer         -- fallback for the rare browser that omits Origin.
//
// A request carrying NONE of these is not a browser -- curl, a script, the test suite -- and is
// allowed, because anything able to make one already has local code execution and does not need
// CSRF. Rejecting them would break scripted use for no security gain.
function crossSitePost(req) {
  const host = String(req.headers.host || "");

  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return `Sec-Fetch-Site: ${fetchSite}`;
  }

  const stated = req.headers.origin || req.headers.referer;
  if (stated) {
    try {
      if (new URL(stated).host !== host) return `Origin/Referer ${new URL(stated).host} != ${host}`;
    } catch {
      return `unparseable Origin/Referer: ${String(stated).slice(0, 60)}`;
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    // First run: if there is no config and no targeting, the dashboard is useless and the user has
    // nowhere obvious to start. Send them to Setup once. Any query string (including the flash
    // params a redirect adds) means they have been somewhere deliberately, so this cannot loop.
    if (req.method === "GET" && url.pathname === "/" && !url.search) {
      const unconfigured = await (async () => {
        try {
          await fs.access(path.join(ROOT, "config", "job-seeker.config.md"));
          return false;
        } catch {
          return true;
        }
      })();
      if (unconfigured) {
        res.writeHead(302, { location: "/settings?tab=setup&flash=ok&msg=" + encodeURIComponent("Welcome — set these up once and JobSeeker can start.") });
        return res.end();
      }
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/settings")) {
      const all = await loadAll();
      // The active tab is chosen server-side from ?tab= so there is no flash of the wrong pane, and
      // so a POST redirect can put you back where you were.
      all.tab = url.searchParams.get("tab") || "";
      const flash = url.searchParams.get("flash")
        ? { kind: url.searchParams.get("flash"), msg: url.searchParams.get("msg") || "" }
        : null;
      // Render BEFORE writing headers. Doing it inside res.end() meant a template error left the
      // headers already sent, so the catch below could not send a 500 — it threw
      // ERR_HTTP_HEADERS_SENT and killed the whole process, taking the dashboard down.
      const html = url.pathname === "/settings" ? settingsPage(all, flash) : page(all, flash);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && ASSETS.has(url.pathname)) {
      const [file, type] = ASSETS.get(url.pathname);
      const buf = await fs.readFile(path.join(PUBLIC, file));
      // Content-hash-free but immutable-ish: these change only when the logo is regenerated,
      // and a local dashboard reload should not re-fetch them every time.
      res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400" });
      res.end(buf);
      return;
    }
    if (req.method === "POST") {
      const bad = crossSitePost(req);
      if (bad) {
        // 403 with no detail to the caller; the reason goes to the operator's console.
        console.warn(`[csrf] rejected POST ${url.pathname} — ${bad}`);
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("Cross-site request rejected");
      }
      // Every mutation below shares data/ with record.mjs, which agents may be running right
      // now (a scheduled /job-run writing while you click Advance). Take the same lock so the
      // two never interleave a read-modify-write. GET is unlocked — a slightly stale render is
      // harmless, and blocking page loads behind a long agent run would not be.
      return await withLock(() => handlePost(req, res, url));
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Error: " + (e?.message || e));
  }
});

async function handlePost(req, res, url) {
  if (url.pathname === "/upload-cv") {
    await handleUploadCV(req, url);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  const form = parseForm(await readBody(req));
  // Stamped by the client on every POST form so redirect() can return you to the same pane.
  res._returnTab = form._tab || "";
  res._returnPage = form._page || "";
  if (url.pathname === "/save-config") {
    try {
      await handleSaveConfig(form);
      return redirect(res, { kind: "ok", msg: "Settings saved." });
    } catch (e) {
      return redirect(res, { kind: "err", msg: e.message });
    }
  }
  if (url.pathname === "/run-action") {
    try {
      const msg = await handleRunAction(form);
      return redirect(res, { kind: "ok", msg });
    } catch (e) {
      return redirect(res, { kind: "err", msg: e.message });
    }
  }
  if (url.pathname === "/save-criteria") {
    await handleSaveCriteria(form);
    return redirect(res, { kind: "ok", msg: "Criteria saved." });
  }
  if (url.pathname === "/add-market") {
    await handleAddMarket(form);
    return redirect(res, { kind: "ok", msg: "Market added. Run /markets to build its list." });
  }
  if (url.pathname === "/add-company") {
    const r = await handleAddCompany(form);
    return redirect(res, r.flash);
  }
  if (url.pathname === "/dismiss-board") {
    try {
      return redirect(res, { kind: "ok", msg: await handleDismissBoard(form) });
    } catch (e) {
      return redirect(res, { kind: "err", msg: e.message });
    }
  }
  if (url.pathname === "/set-board") {
    const r = await handleSetBoard(form);
    return redirect(res, {
      kind: "ok",
      msg: r.cleared
        ? `${r.company}: careers URL cleared.`
        : `${r.company}: careers URL saved — the next scout run will try it first.`,
    });
  }
  if (url.pathname === "/add-task") {
    await handleAddTask(form);
    return redirect(res, { kind: "ok", msg: "Task added." });
  }
  if (url.pathname === "/add-task-nl") {
    await handleAddTaskNL(form);
    return redirect(res, { kind: "ok", msg: "Task added (parsed from your text)." });
  }
  if (url.pathname === "/set-proposal-status") {
    await handleSetProposalStatus(form);
    return redirect(res, { kind: "ok", msg: form.status === "dismissed" ? "Role dismissed." : "Role status updated." });
  }
  if (url.pathname === "/mark-all-proposals-seen") {
    await handleMarkAllProposalsSeen();
    return redirect(res, { kind: "ok", msg: "All new roles marked seen." });
  }
  if (url.pathname === "/set-app-status") {
    await handleSetAppStatus(form);
    return redirect(res, { kind: "ok", msg: form.status === "Dismissed" ? "Lead dismissed." : "Lead status updated." });
  }
  if (url.pathname === "/dismiss-advance") {
    const r = await handleDismissAdvance(form);
    return redirect(res, r);
  }
  if (url.pathname === "/advance-app-stage") {
    await handleAdvanceAppStage(form);
    return redirect(res, { kind: "ok", msg: "Stage advanced." });
  }
  if (url.pathname === "/set-task-status") {
    await handleSetTaskStatus(form);
    return redirect(res, { kind: "ok", msg: form.status === "dismissed" ? "Task dismissed." : "Task updated." });
  }
  if (url.pathname === "/add-contact") {
    await handleAddContact(form);
    return redirect(res, { kind: "ok", msg: "Contact added." });
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
}

const cfg = await loadConfig();
const PORT = Number(process.env.PORT || cfg.dashboard_port || 4319);

// Bind LOOPBACK ONLY. Node's default is every interface, which was verified reachable from this
// machine's LAN address: on any cafe, hotel or office network, anyone could read the entire job
// search -- applications, contacts, offer and salary notes, message summaries -- and POST to all of
// the mutating routes. There is no authentication here by design, because "localhost only" IS the
// authentication.
//
// Override only if you understand that: JOBSEEKER_DASHBOARD_HOST=0.0.0.0 exposes unauthenticated
// personal data to the whole network. It warns loudly rather than failing, so the choice stays the
// operator's, but the safe value is the default.
const HOST = process.env.JOBSEEKER_DASHBOARD_HOST || "127.0.0.1";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

server.listen(PORT, HOST, () => {
  console.log(`Job-seeker dashboard on http://localhost:${PORT}`);
  if (!LOOPBACK.has(HOST)) {
    console.warn(
      `\n!! WARNING: bound to ${HOST}, not loopback. The dashboard has NO authentication, so your\n` +
        `!! job-search data is readable and writable by anyone who can reach this machine on the\n` +
        `!! network. Unset JOBSEEKER_DASHBOARD_HOST to bind 127.0.0.1 only.\n`
    );
  }
});
