#!/usr/bin/env node
// Tiny local dashboard for the job-seeker agent layer. One file, Node built-ins only.
// Reads data/*.md (the source of truth) and renders a single self-contained page.
// Writes a handful of things back: criteria, a new market, manual tasks/contacts, and the
// uploaded CV. Agent-driven actions (curate/apply/track/followup/parse-cv) stay as Claude
// Code slash commands — this server never runs the agents.

import http from "http";
import { promises as fs, default as fsSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import * as platform from "./platform.mjs";
import {
  parseFrontmatter,
  stringifyFrontmatter,
  readRecordDir,
  readTable,
  appendTableRow,
  sanitizeCell,
  splitRow,
  newId,
  writeFileAtomic,
} from "./md.mjs";
import { withLock } from "./lock.mjs";
import { updateState, startChecking, checkNow, TAG_OK } from "./update.mjs";

let VERSION_CACHE = "";
async function currentVersion() {
  if (VERSION_CACHE) return VERSION_CACHE;
  try {
    VERSION_CACHE = String(JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")).version || "");
  } catch {
    VERSION_CACHE = "";
  }
  return VERSION_CACHE;
}
import { findRepost, setCompanyAliases} from "./match.mjs";
import { companyAliases } from "./config.mjs";
import { DISMISS_TAGS } from "./record.mjs";
import { buildBundle } from "./feedback.mjs";

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

// The Chrome-extension bridge (server/bridge.mjs) is how Windows reaches the browser: there is no
// Apple Events / launchd broker to lean on, so a small extension talks to this server over
// /bridge/*. The module is loaded dynamically and guarded, so a checkout without it (or a bridge
// that fails to construct) still gets a working dashboard -- the Settings row then reports it.
const bridge = await import("./bridge.mjs")
  .then((mod) => (mod && typeof mod.createBridge === "function" ? mod.createBridge({ dataDir: DATA }) : null))
  .catch(() => null);
// The pairing code most recently minted from the UI, kept only until it expires. Minting is a POST;
// the code is shown on the GET that follows, so it has to live somewhere between the two.
let pairing = null;
function activePairing() {
  if (!pairing) return null;
  const exp = typeof pairing.expires === "number" ? pairing.expires : Date.parse(pairing.expires);
  if (Number.isNaN(exp) || exp <= Date.now()) {
    pairing = null;
    return null;
  }
  return pairing;
}
// Where a Connect click should land back. An allow-list -- never a raw Referer.
const BRIDGE_RETURN = new Map([
  ["settings", "/settings?tab=setup&sub=system"],
  ["welcome", "/welcome?step=chrome"],
  ["setup-step", "/setup-step?step=chrome&back=settings"],
]);

// Brand assets, served from public/. An explicit allowlist rather than a static file handler:
// this server has no other GET surface, and a literal map cannot be path-traversed.
const ASSETS = new Map([
  ["/favicon.ico", ["favicon.ico", "image/x-icon"]],
  // Shown inside the Chrome-extension instructions on Windows, so the reader can match the page in
  // front of them to the one being described.
  ["/help-chrome-extensions.png", ["help-chrome-extensions.png", "image/png"]],
  ["/help-chrome-details.png", ["help-chrome-details.png", "image/png"]],
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

// Runs in <head>, before the body paints. Setting data-theme here rather than after load is the
// difference between a themed page and a page that flashes the wrong scheme on every navigation --
// and this dashboard is a multi-page app, so that flash would happen on every click.
const APPEARANCE_JS = `(function(){
  var G={
    auto:'<circle cx="10" cy="10" r="7.25" fill="none" stroke="currentColor" stroke-width="1.5"></circle><path d="M10 2.75a7.25 7.25 0 0 0 0 14.5z" fill="currentColor"></path>',
    light:'<circle cx="10" cy="10" r="7.25" fill="none" stroke="currentColor" stroke-width="1.5"></circle>',
    dark:'<circle cx="10" cy="10" r="7.25" fill="currentColor"></circle>'};
  var N={auto:'light',light:'dark',dark:'auto'};
  var L={auto:'Auto',light:'Light',dark:'Dark'};
  var mode='auto';
  try{ var m=localStorage.getItem('jobseeker.appearance'); if(G[m]) mode=m; }catch(e){}
  function apply(){
    var r=document.documentElement;
    // Auto writes NO attribute, which is what hands the decision back to the media query.
    if(mode==='auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme',mode);
    var b=document.getElementById('appearance');
    if(!b) return;
    b.innerHTML='<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">'+G[mode]+'</svg>';
    var t='Appearance: '+L[mode]+' \\u2014 click for '+L[N[mode]];
    b.title=t; b.setAttribute('aria-label',t);
  }
  apply();
  document.addEventListener('DOMContentLoaded',function(){
    var b=document.getElementById('appearance');
    if(!b) return;
    b.addEventListener('click',function(){
      mode=N[mode];
      try{ localStorage.setItem('jobseeker.appearance',mode); }catch(e){}
      apply();
    });
    apply();
  });
})();`;

const HEAD_ICONS = `<link rel="icon" href="${v("/favicon.ico")}" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="${v("/favicon-32.png")}">
<link rel="icon" type="image/png" sizes="16x16" href="${v("/favicon-16.png")}">
<link rel="apple-touch-icon" href="${v("/apple-touch-icon.png")}">
<meta name="theme-color" content="#0f1220">
<script>${APPEARANCE_JS}</script>`;

// One button, three states, shown as one silhouette at three fill levels: empty is light, half is
// auto, full is dark. Auto sits visually between the two states it chooses from, which is what it
// does -- a sun/moon pair has no natural third member, and adding a monitor glyph for Auto puts
// three unrelated shapes in a 16px box.

// ---------------------------------------------------------------------------- first-run tour
// Anchored to elements that already exist rather than to markup added for the tour, so nothing
// here changes the page it is describing. If a target is missing (a narrower layout, a future
// change) that step is skipped rather than pointing at nothing.
// Viewport size that is never zero.
//
// window.innerWidth reports 0 in real conditions — during a restore, before first layout, and in
// some embedded views. Every positioner here then computed `innerWidth - width - padding`, went
// NEGATIVE, and threw the panel off the left edge with its arrow still correctly under the button.
// It looked like a misaligned popup; it was arithmetic on a zero.
const VIEWPORT_JS = `
function vpW(){
  return window.innerWidth || document.documentElement.clientWidth ||
    (document.body && document.body.clientWidth) || 1024;
}
function vpH(){
  return window.innerHeight || document.documentElement.clientHeight ||
    (document.body && document.body.clientHeight) || 768;
}
`;

const TOUR_JS = `${VIEWPORT_JS}(function(){
  var STEPS = [
    { sel: 'nav.tabs', title: 'Everything lives behind these five',
      body: 'Today is what needs you now. Jobs are roles found for you, Pipeline is what you have applied to, People is who you have spoken to.' },
    { sel: '.statbar', title: 'The count that matters',
      body: 'Due today, overdue, approvals waiting. If these are all zero, there is nothing for you to do.' },
    { sel: '.runmenu-btn', title: 'Run something now',
      body: 'A job search, a check of your channels, or your follow-ups — without waiting for the morning run.' },
    { sel: '#appearance', title: 'Light or dark',
      body: 'Follows your Mac by default. Click to pin it one way.' },
    { sel: 'a.moonbtn[href="/settings"]', title: 'Your CV and your targets',
      body: 'Everything the agents read about you, and the boards they search, live in Settings.' },
    { sel: '#bugbtn', title: 'Something broken?',
      body: 'Writes a file describing what went wrong, into your Downloads. You look at it, then email it — nothing is sent for you.' }
  ];
  var TOUR_KEY = 'jobseeker.tour';
  var i = 0, veil, spot, bub, steps, key = TOUR_KEY;

  function seen(k){ try { return localStorage.getItem(k) === 'done'; } catch(e){ return true; } }
  function markSeen(k){ try { localStorage.setItem(k, 'done'); } catch(e){} }

  function stop(){
    markSeen(key);
    [veil, spot, bub].forEach(function(el){ if (el && el.parentNode) el.parentNode.removeChild(el); });
    veil = spot = bub = null;
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('keydown', onKey);
  }
  function onKey(e){ if (e.key === 'Escape') stop(); }

  function place(){
    var st = steps[i], t = document.querySelector(st.sel);
    if (!t) { next(); return; }
    var r = t.getBoundingClientRect();
    spot.style.top = (r.top - 4) + 'px';
    spot.style.left = (r.left - 4) + 'px';
    spot.style.width = (r.width + 8) + 'px';
    spot.style.height = (r.height + 8) + 'px';

    // Prefer sitting under the target; flip above when there is no room.
    var below = r.bottom + 14, bh = bub.offsetHeight || 150;
    var goBelow = (below + bh) < (vpH() - 12);
    bub.className = 'tour-bub ' + (goBelow ? 'below' : 'above');
    bub.style.top = (goBelow ? below : Math.max(12, r.top - 14 - bh)) + 'px';
    /* The outer Math.max is what stops a bubble wider than the viewport being pushed off-screen
       left: clamp to the right edge, but never past the left one. */
    var left = Math.max(12, Math.min(Math.max(12, r.left), vpW() - bub.offsetWidth - 12));
    bub.style.left = left + 'px';
    var arrow = bub.querySelector('i');
    var ax = Math.min(Math.max(14, r.left + r.width / 2 - left - 6), bub.offsetWidth - 26);
    arrow.style.left = ax + 'px';
  }

  function render(){
    var st = steps[i];
    bub.innerHTML = '<i></i><h4></h4><p></p><footer><span class="tour-step"></span>' +
      '<span class="tour-acts"><button type="button" data-skip>Skip</button>' +
      '<button type="button" class="go" data-next></button></span></footer>';
    bub.querySelector('h4').textContent = st.title;
    bub.querySelector('p').textContent = st.body;
    /* "1 of 1" is a counter for a tour of one — noise. */
    bub.querySelector('.tour-step').textContent = steps.length > 1 ? (i + 1) + ' of ' + steps.length : '';
    bub.querySelector('[data-next]').textContent = (i === steps.length - 1) ? 'Done' : 'Next';
    /* Skip and Done say the same thing when there is only one card. */
    bub.querySelector('[data-skip]').hidden = steps.length === 1;
    bub.querySelector('[data-skip]').onclick = stop;
    bub.querySelector('[data-next]').onclick = next;
    place();
  }
  function next(){ i++; if (i >= steps.length) { stop(); return; } render(); }

  /* One placement engine, two callers: the five-step tour, and the single balloon shown to someone
     who finished setup without starting a run. A second balloon system would be a second thing to
     keep aligned with a sticky, horizontally scrolling tab strip. */
  function start(list, k){
    key = k || TOUR_KEY;
    steps = (list || STEPS).filter(function(s){ return document.querySelector(s.sel); });
    if (!steps.length) return;
    i = 0;
    veil = document.createElement('div'); veil.className = 'tour-veil';
    veil.onclick = stop;
    spot = document.createElement('div'); spot.className = 'tour-spot';
    bub = document.createElement('div'); bub.className = 'tour-bub below';
    document.body.appendChild(veil); document.body.appendChild(spot); document.body.appendChild(bub);
    requestAnimationFrame(function(){ veil.classList.add('on'); });
    window.addEventListener('resize', place);
    /* The Run now button rides in a sticky, horizontally scrollable tab strip, so the ring drifts
       off its target on any scroll unless it is re-measured. Capture phase, because the strip's own
       scroll does not bubble. */
    window.addEventListener('scroll', place, true);
    window.addEventListener('keydown', onKey);
    render();
  }

  window.__tourReplay = function(){ try { localStorage.removeItem(TOUR_KEY); } catch(e){} start(STEPS, TOUR_KEY); };

  /* Either/or, never both. A brand-new user who declines the first run would otherwise get the full
     tour AND the hint back to back — two veils in a row — and it would be redundant: the tour's own
     third step already points at the same button and says the same thing. */
  var hint = window.__tourHint;
  if (!seen(TOUR_KEY)) {
    if (hint) markSeen(hint.key);
    setTimeout(function(){ start(STEPS, TOUR_KEY); }, 450);   /* let the page settle before dimming it */
  } else if (hint && !seen(hint.key)) {
    setTimeout(function(){ start([hint], hint.key); }, 450);
  }
})();`;

// What a ?hint= may point at, and what it may say. An allow-list, not the query string itself: a
// hint is a spotlight plus authoritative-looking words in JobSeeker's own voice, and a link that
// chose both would be a link that could put anything anywhere. Same reasoning as BACK_TO.
const PAGE_HINTS = new Map([
  [
    "runnow",
    {
      sel: ".runmenu-btn",
      key: "jobseeker.hint.runnow",
      title: "Start your first run here",
      body: "Everything, or just one part of it. Nothing here applies or sends — it queues anything needing you for approval.",
    },
  ],
]);

const APPEARANCE_BTN = `<button type="button" id="appearance" class="moonbtn"></button>`;

// Settings and Report-a-problem are the same 16px pill as Appearance, in that order: the thing you
// touch every week, the thing you touch monthly, the thing you touch twice a year. The bug sits
// furthest out because it is the rarest — and because a report button you brush past by accident is
// worse than one you have to aim at.
const SETTINGS_BTN = `<a class="moonbtn" href="/settings" title="Settings — criteria, markets, careers boards, CV" aria-label="Settings">
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="10" cy="10" r="2.6"></circle>
    <path d="M10 1.9v1.8M10 16.3v1.8M16.72 5.95l-1.56.9M4.84 13.15l-1.56.9M16.72 14.05l-1.56-.9M4.84 6.85l-1.56-.9"></path>
    <circle cx="10" cy="10" r="7.1"></circle>
  </svg>
</a>`;

const FEEDBACK_BTN = `<button type="button" id="bugbtn" class="moonbtn" title="Report a problem" aria-label="Report a problem">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="7.5" y="7" width="9" height="12.5" rx="4.5"></rect>
    <path d="M9.6 7.3 8 4.6"></path><path d="M14.4 7.3 16 4.6"></path>
    <path d="M7.5 11H4.6"></path><path d="M7.5 14.5H4"></path><path d="M7.9 18 5.4 19.9"></path>
    <path d="M16.5 11h2.9"></path><path d="M16.5 14.5H20"></path><path d="M16.1 18l2.5 1.9"></path>
    <path d="M12 11.5v5"></path>
  </svg>
</button>`;

// The dialog itself. Injected into every page that has a header, so a problem can be reported from
// wherever it happened rather than only from Today.
//
// Two things about the shape are deliberate:
//   * The log is not a checkbox. It is redacted before it is written (server/feedback.mjs), so
//     there is nothing to consent to, and a checkbox would only invite people to withhold the one
//     artefact that makes a report actionable.
//   * The screenshot IS, with an acknowledgement, because it is the single thing in the bundle that
//     can carry the user's own data. It shows their dashboard, and their dashboard has their
//     companies and contacts on it.
const FEEDBACK_MODAL = `
<div id="fbOverlay" class="overlay" role="dialog" aria-modal="true" aria-labelledby="fbTitle">
  <div class="modal fb-modal">
    <button type="button" class="mclose" id="fbClose" aria-label="Close">&times;</button>
    <h3 id="fbTitle">Report a problem</h3>
    <p class="fb-lede">This goes to the person who maintains JobSeeker. Nothing leaves your machine on
      its own &mdash; you get a file, and you decide whether to send it.</p>

    <label class="fb-fld" for="fbText">What went wrong?</label>
    <textarea id="fbText" class="fb-ta" rows="4"
      placeholder="What were you doing, and what happened instead?"></textarea>

    <div class="fb-opts">
      <label class="fb-opt">
        <input type="checkbox" id="fbShot">
        <span><span class="fb-t">Attach a picture of this page</span>
        <span class="fb-d">Drawn from the page itself, exactly as you are looking at it now &mdash; this dialog
          closes first, so it is not in the picture. Nothing outside the JobSeeker window is captured.</span></span>
      </label>
    </div>

    <div class="fb-warn" id="fbWarn" hidden>
      <div class="fb-wt">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 4.5 21 20H3Z"></path><path d="M12 10.5v4"></path><path d="M12 17.4v.1"></path>
        </svg>
        A picture of this page shows what is on it
      </div>
      <p>Company names, contacts and message text from your tracker will be visible in it. Open the file
        and look before you send it &mdash; nothing else in the bundle carries your data.</p>
      <label class="fb-ack">
        <input type="checkbox" id="fbAck">
        <span>I understand the picture may contain private information.</span>
      </label>
    </div>

    <div class="fb-what">
      <p class="fb-wh">What goes in the file</p>
      <ul class="fb-manifest">
        <li><span class="fb-mk yes">+</span><span>What you wrote above</span></li>
        <li><span class="fb-mk yes">+</span><span>Version, OS and browser</span></li>
        <li><span class="fb-mk yes">+</span><span>The same log report <code>npm run logs</code> writes &mdash; always
          included, with names, emails, phone numbers and company names masked</span></li>
        <li><span class="fb-mk no">&minus;</span><span>Never: your <code>data/</code> tables, CV, contacts,
          message text or any credential</span></li>
      </ul>
    </div>

    <div class="fb-acts">
      <span class="fb-err" id="fbErr" hidden></span>
      <button type="button" class="btn-secondary" id="fbCancel">Cancel</button>
      <button type="button" id="fbSend" disabled>Create the file</button>
    </div>
  </div>
</div>

<div id="fbDone" class="overlay" role="dialog" aria-modal="true" aria-labelledby="fbDoneTitle">
  <div class="modal fb-modal">
    <button type="button" class="mclose" id="fbDoneClose" aria-label="Close">&times;</button>
    <h3 id="fbDoneTitle">Your report is ready to send</h3>
    <p class="fb-lede">It is saved on your machine and nowhere else. Open it, check you are happy with
      what is in it, then attach it to an email.</p>

    <div class="fb-file">
      <div class="fb-fi">
        <div class="fb-nm" id="fbName"></div>
        <div class="fb-loc" id="fbLoc"></div>
      </div>
    </div>

    <div class="fb-mail">
      <p class="fb-mt">Send it to Christos</p>
      <ol class="fb-steps">
        <li>Start a new email to the address below.</li>
        <li>Drag the file out of your Downloads folder and drop it into the message.</li>
        <li>Send it. Anything you want to add in the body is welcome.</li>
      </ol>
      <div class="fb-addr">
        <span class="fb-a" id="fbAddr">ventouris@gmail.com</span>
        <button type="button" id="fbCopy">Copy the address</button>
      </div>
    </div>

    <div class="fb-acts">
      <button type="button" class="btn-secondary" id="fbDoneOk">Done</button>
    </div>
  </div>
</div>`;

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
  const marketAskDismissed = await readMarketAskDismissed();
  const dismissedNotices = await readDismissedNotices();
  const update = await updateState();
  // Read separately from `update`, not off it. The update check is a background job that has not
  // necessarily run yet -- on a first launch, offline, or within the first seconds -- and the
  // version of the thing you are looking at should not depend on whether GitHub answered.
  const version = await currentVersion();
  let updateRun = null;
  try {
    updateRun = JSON.parse(await fs.readFile(path.join(DATA, ".setup", "update.json"), "utf8"));
  } catch {
    /* nothing has ever been updated here */
  }
  // The extension's own version, which is not package.json's. Windows only: on a Mac Chrome is
  // driven through the Apple Events broker and there is no extension to reload.
  let extVersion = "";
  if (platform.IS_WIN) {
    try {
      extVersion = String(
        JSON.parse(await fs.readFile(path.join(ROOT, "extension", "manifest.json"), "utf8")).version || ""
      );
    } catch {
      /* no manifest, no notice */
    }
  }
  // Roles left behind by a vertical dropped from criteria. Computed here because page() is
  // synchronous and this needs to read the proposal records.
  const orphans = await orphanedProposals().catch(() => ({ count: 0, ids: [], byMarket: {} }));
  // scripts/job-run.sh writes this. A failed scheduled run is otherwise invisible, so Today shows it.
  // The schedule ladder's own state. scripts/schedule-ladder.sh owns the writes; this only reads,
  // so the dashboard can say what is about to change and offer the way out.
  let ladder = null;
  try {
    ladder = JSON.parse(await fs.readFile(path.join(DATA, ".schedule-tier.json"), "utf8"));
  } catch {
    /* not armed yet */
  }
  let lastRun = null;
  try {
    lastRun = JSON.parse(await fs.readFile(path.join(DATA, ".job-run.status.json"), "utf8"));
  } catch {
    /* never run, or the file predates the status machinery */
  }
  // The Run now buttons. Two separate facts, and the page needs both: whether something is running
  // RIGHT NOW (the lock file, which carries the live pid), and how the last one you started ended.
  // Without the first, the buttons invite a second run that scripts/run-now.sh would only refuse
  // after the click; without the second, a run that failed at 08:03 looks exactly like one that
  // worked.
  const runNow = await readRunLock();
  let lastRunNow = null;
  try {
    lastRunNow = JSON.parse(await fs.readFile(path.join(DATA, ".run-now.status.json"), "utf8"));
  } catch {
    /* nothing has been run from the dashboard yet */
  }
  // scripts/research-market.sh writes this. Market research is the only long job the dashboard
  // starts that used to report nothing at all: it is spawned detached with stdio ignored, so a
  // script that died on its first line looked exactly like one quietly working. Meanwhile the flash
  // promised companies would appear on reload, and they never did.
  let marketsRun = null;
  try {
    marketsRun = JSON.parse(await fs.readFile(path.join(DATA, ".markets-run.status.json"), "utf8"));
  } catch {
    /* no market has been researched from the dashboard yet */
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
    marketAskDismissed,
    dismissedNotices,
    update,
    version,
    updateRun,
    extVersion,
    boards,
    orphans,
    lastRun,
    ladder,
    runNow,
    lastRunNow,
    marketsRun,
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
  // SHORT facts only. These used to share a two-column label/value grid with the next-action
  // narrative — which meant a 400-word paragraph was squeezed down one half-width column into a
  // tall ribbon about 30 characters wide, while the column beside it sat empty. Facts are a few
  // words each and belong on a line together; prose needs the full width and a sane measure. They
  // are different kinds of content and stopped sharing a layout.
  const facts = [
    ["Type", d.kind ? esc(d.kind === "application" ? "Application" : "Lead") : ""],
    ["Status", `<span class="pill s-${esc((d.status || "").toLowerCase())}">${esc(d.status)}</span>`],
    ["Channel", channelTag(d.channel)],
    ["Via", esc(d.source)],
    ["Referrer", esc(d.referrer)],
    ["Location", esc(d.location)],
    ["Applied", esc(d.applied_date)],
    ["Updated", esc(d.last_update)],
    ["Contact", esc(d.contact)],
  ]
    .filter(([, v]) => v && v !== "")
    .map(([k, v]) => `<span class="fact"><span class="fk">${k}</span><span class="fv">${v}</span></span>`)
    .join("");

  // The narrative the user actually opened this to read. Full width, its own block, set at a
  // comfortable measure — not a table cell.
  const nextAction = d.next_action
    ? `<section class="mblock mnext">
         <p class="mh">Next action${d.next_action_date ? ` <span class="muted">· ${esc(d.next_action_date)}</span>` : ""}</p>
         <p class="mprose">${linkifyText(String(d.next_action))}</p>
       </section>`
    : "";
  const dismissed = d.dismiss_reason
    ? `<section class="mblock mdismiss"><p class="mh">Dismissed</p><p class="mprose">${esc(d.dismiss_reason)}</p></section>`
    : "";

  const commsList = relComms.length
    ? relComms
        .map((c) => {
          const link = threadLink(c.thread_url);
          const opener = link ? ` <a href="${esc(link)}" target="_blank" rel="noreferrer">open ↗</a>` : "";
          return `<li>
            <p class="tmeta"><span class="tdate">${esc(String(c.date || "").slice(0, 10))}</span>
              <span class="muted">${esc(c.source)}</span> <strong>${esc(c.from)}</strong>${opener}</p>
            <p class="mprose">${esc(c.summary)}</p>
          </li>`;
        })
        .join("")
    : `<li class="muted">No linked messages.</li>`;
  const tasksList = relTasks.length
    ? relTasks
        .map(
          (t) => `<li>
            <p class="tmeta"><span class="tdate">${esc(t.due_date || "—")}</span>
              <span class="pill s-${esc((t.status || "").toLowerCase())}">${esc(t.status)}</span></p>
            <p class="mprose">${esc(t.detail)}</p>
          </li>`
        )
        .join("")
    : `<li class="muted">No tasks.</li>`;
  const notes = app.body
    ? `<section class="mblock"><p class="mh">Notes</p><div class="mprose mnote">${linkifyText(app.body)}</div></section>`
    : "";

  // Header is sticky so the company you are reading about stays visible while you scroll a long
  // history — the drawer scrolls itself now rather than the whole overlay.
  return `<header class="mhead">
      <h3>${esc(d.company)} <span class="muted">— ${esc(d.role)}</span></h3>
      ${d.job_url ? `<a class="btn" href="${esc(d.job_url)}" target="_blank" rel="noreferrer">↗ Job posting</a>` : ""}
    </header>
    <div class="mfacts">${facts}</div>
    ${nextAction}
    ${dismissed}
    ${notes}
    <section class="mblock">
      <p class="mh">Activity <span class="muted">· ${relComms.length}</span></p>
      <ul class="tline">${commsList}</ul>
    </section>
    <section class="mblock">
      <p class="mh">Tasks <span class="muted">· ${relTasks.length}</span></p>
      <ul class="tline">${tasksList}</ul>
    </section>`;
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
function tasksHTML(rows, appTok, appIds, emptyMsg = "Nothing yet.", dueIds = null) {
  if (!rows.length) return `<p class="empty">${esc(emptyMsg)}</p>`;
  const headers = ["due_date", "type", "who", "status", "detail"];
  const body = rows
    .map((t) => {
      const target = taskTarget(t, appTok, appIds);
      const dismissed = t.status === "dismissed";
      const cls = [target ? "clickrow" : "", t.status === "done" ? "taskdone" : "", dismissed ? "rowdismissed" : ""].filter(Boolean).join(" ");
      const isDue = dueIds ? dueIds.has(t.id) : false;
      // How long it has been sitting there. A date alone does not read as urgent — "21d overdue"
      // does, and it is what separates a live follow-up from one that has quietly become fiction.
      const overdueDays =
        t.status === "open" && t.due_date && t.due_date < today()
          ? Math.round((new Date(today()) - new Date(t.due_date)) / 864e5)
          : 0;
      const stale = overdueDays > STALE_TASK_DAYS;
      const attrs = `${cls ? ` class="${cls}"` : ""}${target ? ` onclick="openDetail('${esc(target)}')" title="Open activity summary"` : ""} data-status="${esc(t.status || "")}" data-type="${esc(t.type || "")}" data-due="${isDue ? "yes" : "no"}" data-stale="${stale ? "yes" : "no"}"`;
      const act = dismissed
        ? `<form method="POST" action="/set-task-status" class="prowact" onclick="event.stopPropagation()"><input type="hidden" name="id" value="${esc(t.id)}"><input type="hidden" name="status" value="open"><button type="submit" title="Restore">↺</button></form>`
        : `<form method="POST" action="/set-task-status" class="prowact" onclick="event.stopPropagation()"><input type="hidden" name="id" value="${esc(t.id)}"><input type="hidden" name="status" value="dismissed"><button type="submit" class="xbtn" title="Dismiss task">×</button></form>`;
      // Clamp long values here too. The tasks table renders raw esc() rather than cell(), so a
      // 4,161-character detail once filled the entire Today page with one row. The writer now caps
      // details at 200 chars, but the display must survive legacy rows and anything hand-edited.
      return `<tr${attrs}><td>${act}</td>${headers
        .map((h) =>
          h === "due_date" && overdueDays
            ? `<td${cellCls(t[h])}>${cell(t[h] || "")}<div class="odue${stale ? " odue-stale" : ""}">${overdueDays}d overdue</div></td>`
            : `<td${cellCls(t[h])}>${cell(t[h] || "")}</td>`
        )
        .join("")}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table><thead><tr><th></th>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// The full Tasks section: a natural-language add field, Open/Done/All filter chips + search, and the table.
// `dueRows` (optional) adds a "Due" chip and makes it the default — used on Today, where the point
// is the short list. Without it the section behaves as the old standalone Tasks tab did.
function tasksSection(rows, appTok, appIds, dueRows = null) {
  const open = rows.filter((r) => r.status === "open").length;
  const done = rows.filter((r) => r.status === "done").length;
  const hasDue = Array.isArray(dueRows);
  // Marking the due rows lets one client-side filter serve both chips, rather than rendering the
  // same table twice and having the two drift apart.
  const dueIds = new Set(hasDue ? dueRows.map((r) => r.id) : []);
  const chip = (f, label, on = false) => `<button type="button" class="tf${on ? " active" : ""}" data-f="${f}">${label}</button>`;
  const t0 = today();
  const staleRows = rows.filter(
    (r) => r.status === "open" && r.due_date && r.due_date < addDays(t0, -STALE_TASK_DAYS)
  );
  return `<div class="taskfilters">
    ${hasDue ? chip("due", `Due (${dueRows.length})`, true) : ""}
    ${chip("open", `Open (${open})`, !hasDue)}
    ${staleRows.length ? chip("stale", `Stale (${staleRows.length})`) : ""}
    ${chip("done", `Done (${done})`)}
    ${chip("dismissed", `Dismissed (${rows.filter((r) => r.status === "dismissed").length})`)}
    ${chip("all", `All (${rows.length})`)}
    <input class="tsearch" placeholder="filter text…" autocomplete="off">
  </div>
  ${
    // The backlog only shrinks if there is a way to clear it in one pass. Shown only when there is
    // actually something stale, so it is not a permanent button nagging at an empty list.
    staleRows.length
      ? `<div class="alert warn stalebar">
           <b>${staleRows.length} follow-up${staleRows.length === 1 ? " is" : "s are"} more than ${STALE_TASK_DAYS} days overdue.</b>
           Deciding on them is the point — but if they have gone stale, clear them in one go rather
           than scrolling past them every morning. They stay under <b>Dismissed</b> with ↺ to restore.
           <form method="POST" action="/dismiss-stale-tasks" class="inline" style="margin-left:8px"
                 data-confirm-title="Dismiss ${staleRows.length} stale follow-up${staleRows.length === 1 ? "" : "s"}?"
                 data-confirm-ok="Dismiss all ${staleRows.length}" data-confirm-danger
                 data-confirm="Every follow-up more than ${STALE_TASK_DAYS} days overdue is cleared in one go.

Nothing is deleted — they move to Dismissed, where ↺ restores any of them.">
             <button type="submit" class="btn-small">Dismiss all ${staleRows.length}</button>
           </form>
         </div>`
      : ""
  }
  ${tasksHTML(rows, appTok, appIds, "No tasks yet.", dueIds)}`;
}

// ---------- People (contacts + their messages) ----------
//
// Comms was 179 rows of raw log with its own tab, and nobody opens a message log on purpose — it is
// context ABOUT a person. Contacts, meanwhile, was a bare table with no sign of whether you had ever
// spoken. Together they answer the question actually being asked: "who is this, and where did we
// leave it?"
//
// Messages are matched to a contact by name or email appearing in the comms `from` field. That is
// deliberately loose — comms rows store whatever identifier the channel gave us, raw and unguessed
// (AGENT-RULES §1 forbids inventing a name from a handle) — so anything unmatched is kept and shown
// under "Not matched to a contact" rather than dropped.
function peopleHTML(all) {
  const contacts = all.contacts.rows ?? [];
  const comms = all.communications.rows ?? [];
  const norm = (s) => String(s || "").toLowerCase().trim();

  const used = new Set();
  const forContact = (c) => {
    const name = norm(c.name);
    const email = norm(c.email);
    return comms.filter((m, i) => {
      const from = norm(m.from) + " " + norm(m.subject);
      const hit = (email && from.includes(email)) || (name.length >= 4 && from.includes(name));
      if (hit) used.add(i);
      return hit;
    });
  };

  const msgRows = (list) =>
    list
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
      .map((m) => {
        const link = threadLink(m.thread_url);
        return `<tr><td class="nw">${esc(String(m.date || "").slice(0, 10))}</td><td class="nw">${esc(m.source)}</td><td>${esc(m.subject)}</td><td>${cell(m.summary)}</td><td>${
          link ? `<a href="${esc(link)}" target="_blank" rel="noreferrer">open ↗</a>` : ""
        }</td></tr>`;
      })
      .join("");

  const cards = contacts
    .map((c) => {
      const mine = forContact(c);
      const last = mine.length ? String(mine.map((m) => m.date || "").sort().pop() || "").slice(0, 10) : "";
      const who = [c.company, c.role].filter(Boolean).map(esc).join(" · ");
      return `<details class="person" data-q="${esc(norm(c.name + " " + c.company + " " + c.role + " " + c.email + " " + c.notes))}">
        <summary>
          <span class="pname">${esc(c.name || c.email || "(unnamed)")}</span>
          ${who ? `<span class="muted pmeta">${who}</span>` : ""}
          <span class="pcount">${mine.length ? `${mine.length} message${mine.length === 1 ? "" : "s"}` : `<span class="muted">no messages logged</span>`}</span>
          ${last ? `<span class="muted plast">last ${esc(last)}</span>` : ""}
        </summary>
        <div class="pbody">
          <p class="muted pcontact">${[
            c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "",
            c.linkedin_url ? `<a href="${esc(c.linkedin_url)}" target="_blank" rel="noreferrer">LinkedIn ↗</a>` : "",
            c.notes ? esc(c.notes) : "",
          ]
            .filter(Boolean)
            .join(" · ")}</p>
          ${mine.length ? `<div class="scroll"><table><thead><tr><th>date</th><th>source</th><th>subject</th><th>summary</th><th>link</th></tr></thead><tbody>${msgRows(mine)}</tbody></table></div>` : ""}
        </div>
      </details>`;
    })
    .join("");

  // Everything the matcher could not attribute. Shown rather than hidden: a message from an unknown
  // number is often exactly the one worth noticing.
  const orphans = comms.filter((_, i) => !used.has(i));
  const orphanBlock = orphans.length
    ? `<details class="person orphans">
        <summary><span class="pname">Not matched to a contact</span>
          <span class="pcount">${orphans.length} message${orphans.length === 1 ? "" : "s"}</span></summary>
        <div class="pbody"><div class="scroll"><table><thead><tr><th>date</th><th>source</th><th>from</th><th>subject</th><th>summary</th><th>link</th></tr></thead><tbody>${orphans
          .slice()
          .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
          .map((m) => {
            const link = threadLink(m.thread_url);
            return `<tr><td class="nw">${esc(String(m.date || "").slice(0, 10))}</td><td class="nw">${esc(m.source)}</td><td>${esc(m.from)}</td><td>${esc(m.subject)}</td><td>${cell(m.summary)}</td><td>${
              link ? `<a href="${esc(link)}" target="_blank" rel="noreferrer">open ↗</a>` : ""
            }</td></tr>`;
          })
          .join("")}</tbody></table></div></div>
      </details>`
    : "";

  return `<div class="taskfilters">
      <input class="tsearch psearch2" placeholder="search people, companies, notes…" autocomplete="off">
      <span class="muted pmatch"></span>
    </div>
    ${contacts.length ? cards : `<p class="empty">No contacts yet.</p>`}
    ${orphanBlock}
    <h3 style="margin-top:18px">Add a contact</h3>
    ${addContactFormHTML()}`;
}

// Small colored tag for the lead/application channel.
function channelTag(ch) {
  const c = String(ch || "").toLowerCase();
  if (!c) return "";
  return `<span class="tag tag-${esc(c)}">${esc(c)}</span>`;
}

// Leads: opportunities WITHOUT confirmed-application evidence (CV sent / referral). Shows the
// referrer and the channel it came through.
// ---------- Pipeline (leads + applications, one funnel) ----------
//
// These were two tabs over ONE record type — the split was a single field, `kind === "application"`
// (see the `applied`/`leads` filter in page()). Same ids, same detail drawer, same advance button,
// near-identical columns. Two tabs meant checking two places to answer "where does this company
// stand", and a lead becoming an application appeared to move between tables.
//
// The lead-vs-application distinction is NOT dropped — it is load-bearing (AGENT-RULES: a sent CV
// is a lead; only confirmation evidence makes an application, so the tracker cannot flatter you).
// It stays as a visible Kind column and its own filter chip; what goes away is having to look twice.
function pipelineHTML(records) {
  if (!records.length)
    return `<p class="empty">Nothing in the pipeline yet. A CV sent or a referral is a lead; a confirmation email makes it an application.</p>`;
  const rows = records
    .map((a) => a.data)
    .sort((x, y) => (y.last_update ?? "").localeCompare(x.last_update ?? ""))
    .map((a) => {
      const st = (a.status || "").toLowerCase();
      const isApp = a.kind === "application";
      const dismissed = st === "dismissed";
      const act = dismissed
        ? `<form method="POST" action="/set-app-status" class="prowact" onclick="event.stopPropagation()"><input type="hidden" name="id" value="${esc(a.id)}"><input type="hidden" name="status" value="Saved"><button type="submit" title="Restore">↺</button></form>`
        : `<button type="button" class="xbtn dbtn" data-id="${esc(a.id)}" data-label="${esc(a.company + " — " + a.role)}" title="Dismiss (add a reason)">×</button>`;
      // data-kind drives the Lead/Applied chips; data-status drives the stage chips.
      return `<tr class="clickrow${dismissed ? " rowdismissed" : ""}${a.pending_stage ? " rowpending" : ""}" data-status="${esc(st)}" data-kind="${isApp ? "application" : "lead"}" title="${esc(shortSummary(a))}${dismissed && a.dismiss_reason ? " — dismissed: " + esc(a.dismiss_reason) : ""}" onclick="openDetail('${esc(a.id)}')">
        <td>${act}</td>
        <td>${esc(a.company)}</td>
        <td>${esc(a.role)}</td>
        <td>${
          isApp
            ? `<span class="kindtag k-app" title="Confirmed by a received/confirmation email">application</span>`
            : `<span class="kindtag k-lead" title="CV sent or referral — no confirmation evidence yet">lead</span>`
        }</td>
        <td><span class="pill s-${esc(st)}">${esc(a.status)}</span>${advanceBtn(a)}</td>
        <td>${esc(a.channel || a.source || "")}${a.referrer ? ` <span class="muted">· ${esc(a.referrer)}</span>` : ""}</td>
        <td>${dismissed && a.dismiss_reason ? `<span class="muted">✕ ${esc(a.dismiss_reason)}</span>` : `${esc(a.next_action)}${a.next_action_date ? ` <span class="muted">(${esc(a.next_action_date)})</span>` : ""}`}</td>
        <td>${a.job_url ? `<a href="${esc(a.job_url)}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">↗ open</a>` : ""}</td>
      </tr>`;
    })
    .join("");
  return `<div class="scroll"><table>
    <thead><tr><th></th><th>Company</th><th>Role</th><th>Kind</th><th>Stage</th><th>Via</th><th>Next action</th><th>Job</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function pipelineSection(records) {
  const st = (a) => (a.data.status || "").toLowerCase();
  const kind = (a) => (a.data.kind === "application" ? "application" : "lead");
  const present = [...new Set(records.map(st).filter((s) => s && s !== "dismissed"))];
  const n = (f) =>
    records.filter((a) =>
      f === "all" ? true
      : f === "active" ? st(a) !== "dismissed"
      : f === "lead" || f === "application" ? kind(a) === f && st(a) !== "dismissed"
      : st(a) === f
    ).length;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const chip = (f, label) => `<button type="button" class="tf${f === "active" ? " active" : ""}" data-f="${f}">${label} (${n(f)})</button>`;
  return `<div class="taskfilters lfilters">
    ${chip("active", "Active")}<span class="chipsep"></span>${chip("lead", "Leads")}${chip("application", "Applications")}<span class="chipsep"></span>${present
      .map((s) => chip(s, cap(s)))
      .join("")}${chip("dismissed", "Dismissed")}${chip("all", "All")}
    <input class="tsearch lsearch" placeholder="filter text…" autocomplete="off">
  </div>
  <p class="muted nlhint">A <b>lead</b> is a CV sent or a referral. It only becomes an <b>application</b>
    when there is confirmation evidence — so the count you see is the one you can trust.</p>
  ${pipelineHTML(records)}`;
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

function proposalsHTML(props, appliedByCompany, reposts = {}, busy = null) {
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
      // Fill this form for me.
      //
      // It fills and STOPS: the tab is left open in the user's own Chrome and they press Submit.
      // Nothing here can submit an application — that is the point, not a limitation. An unattended
      // agent has nobody to ask when a form asks something the CV does not answer, and a confidently
      // wrong answer on an application is worse than an obvious gap.
      //
      // Shares the run lock with everything else that drives Chrome (AGENT-RULES §13), so it greys
      // out while any run is going and vice versa.
      const canFill = Boolean(p.job_url) && st !== "dismissed" && st !== "applied";
      const applyBtn = canFill
        ? `<form method="POST" action="/apply-now" class="prowact applyform">
             <input type="hidden" name="_tab" value="proposals">
             <input type="hidden" name="id" value="${esc(p.id)}">
             <button type="submit" class="applybtn"${busyAttrs(busy)}
               title="${esc(
                 busy
                   ? `${runLabel(busy.slug)} is running — only one thing can drive Chrome at a time`
                   : "Opens the posting in your Chrome and fills what it can from your CV. It does not submit — you do."
               )}">Fill form</button>
           </form>`
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
        <td class="linkcell">${applyBtn}${
          !p.job_url
            ? ""
            : (p.url_volatile || "no") === "yes"
              ? // The warning is carried by the LINK, not by a badge beside it. As a badge it was a
                // second line of text on every volatile row, and the Link column grew to fit the
                // longest one — so a caveat about a minority of links set the width of the whole
                // table. The wavy red underline says "something is off with this link" at a glance;
                // hovering says what.
                `<span class="volatile-url" title="⚠ This link may expire — re-search by Job ID.&#10;&#10;It uses a short-lived token that rotates and can expire silently. If it 404s, re-search the vendor careers site by location or Job ID (see the proposal notes).">${linkify(p.job_url)}</span>`
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
function proposalsSection(propRecords, appliedByCompany, reposts = {}, orphans = null, busy = null) {
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
  ${
    // Residue from a vertical dropped before criteria started clearing up after itself. Shown only
    // when there is some, so it disappears for good once acted on.
    orphans && orphans.count
      ? `<div class="alert warn">
           <b>${orphans.count} open role${orphans.count === 1 ? " is" : "s are"} from markets you no longer target</b>
           — ${Object.entries(orphans.byMarket).map(([m, n]) => `${n} from ${esc(m)}`).join(", ")}.
           Removing a market stops new roles being found there, but these were already on the list.
           <form method="POST" action="/dismiss-orphaned-proposals" class="inline" style="margin-left:8px"
                 data-confirm-title="Dismiss ${orphans.count} role${orphans.count === 1 ? "" : "s"}?"
                 data-confirm-ok="Dismiss all ${orphans.count}" data-confirm-danger
                 data-confirm="These are open roles from markets you no longer target.

They can be restored at any time from the Dismissed filter.">
             <button type="submit" class="btn-small">Dismiss all ${orphans.count}</button>
           </form>
         </div>`
      : ""
  }
  ${proposalsHTML(propRecords, appliedByCompany, reposts, busy)}`;
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

/**
 * Markets with no vendors in them yet.
 *
 * A market you have just added is only a name and an empty file until something researches it.
 * server/audit.mjs already reports such a market as `stale`, and the daily run researches every
 * stale market — so with a schedule this resolves itself overnight and the right thing to do is
 * say so, not nag. Without a schedule nothing will ever pick it up, which is the case that needs a
 * button.
 */
function emptyMarkets(markets) {
  return (markets ?? []).filter((m) => (m.table?.rows?.length ?? 0) === 0).map((m) => m.label || m.name);
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

  // An empty market needs research before it is worth anything. What to SAY about it depends
  // entirely on whether a daily run exists — with one, this fixes itself and a button would just be
  // an expensive way to skip the wait; without one, nothing will ever pick it up and telling the
  // user "it will be researched" would be a lie.
  const empties = emptyMarkets(all.markets);
  const scheduled = Boolean(all.status?.schedInstalled);
  // How the last research pass ended. The button used to promise "reload this page to see the
  // companies appear" and then never mention it again, so a pass that could not start at all — no
  // claude on the PATH the app hands its children — was indistinguishable from one still working.
  // Whatever it says, it is read from the script's own status file rather than assumed.
  const mr = all.marketsRun;
  const mrAt = String(mr?.finished || mr?.started || "").slice(0, 16).replace("T", " ");
  const marketRunBlock = !mr
    ? ""
    : mr.state === "running"
      ? `<div class="alert"><b>Researching ${esc(mr.market || "a market")} now.</b>
           Started ${esc(mrAt)} — it takes a few minutes. Reload to see the companies appear.</div>`
      : mr.state === "ok"
        ? ""
        : `<div class="alert bad"><b>Researching ${esc(mr.market || "a market")} did not finish.</b>
             ${esc(mr.detail || "No detail recorded.")}
             <span class="muted">Tried ${esc(mrAt)} — the full output is in <code>data/.markets-run.log</code>.</span></div>`;
  const emptyBlock = empties.length
    ? `<div class="alert warn">
         <b>${empties.map(esc).join(", ")} ${empties.length === 1 ? "has" : "have"} no companies yet.</b>
         ${
           scheduled
             ? `The ${esc(all.status.schedTime || "daily")} run researches any market that has never been
                reviewed, so ${empties.length === 1 ? "it" : "they"} will be filled in then — nothing to do.
                To do it now instead:`
             : `You have no daily run, so nothing will research
                ${empties.length === 1 ? "it" : "them"} on its own. Either
                <a href="/settings?tab=setup">schedule a daily run</a>, or do it now:`
         }
         ${empties
           .map(
             (m) => `<form method="POST" action="/research-market" class="inline" style="margin-left:6px"
                 data-confirm-title="Research ${esc(m)} now?"
                 data-confirm-ok="Research it now"
                 data-confirm="This runs a Claude pass to find and rank vendors in ${esc(m)}. It takes a few minutes and costs roughly a dollar, charged to your usual spend cap.

It runs in the background — reload this page to see the results.">
                 <input type="hidden" name="market" value="${esc(m)}">
                 <button type="submit" class="btn-small">Research ${esc(m)} now</button>
               </form>`
           )
           .join("")}
       </div>`
    : "";

  if (!entries.length)
    return `${marketRunBlock}${emptyBlock}<p class="empty">No companies yet. Add a market under <b>Setup</b> to get started.</p>`;

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
            ? `<form method="POST" action="/dismiss-board" class="inline"
                 data-confirm-title="Remove ${esc(e.company)}?"
                 data-confirm-ok="Remove it" data-confirm-danger
                 data-confirm="It stops appearing here and scouts will skip it.

It stays in data/boards.md and can be restored from there.">
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
               data-confirm-title="Remove all ${noBoard.length}?"
               data-confirm-ok="Remove all ${noBoard.length}" data-confirm-danger
               data-confirm="Some of these DO have a careers page — the &quot;no board&quot; verdict came from agents that only guessed ATS slugs.

They stay in data/boards.md and can be restored.">
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
    ${marketRunBlock}
    ${emptyBlock}
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
  notice:  { hue: 45,  types: ["notification"] },
  // Things that did not work. Its own family, its own red, its own filter chip — because the
  // question this log gets opened to answer is usually "I pressed the button and nothing
  // happened", and until now the answer to that was a status file that had already been
  // overwritten, or a .log under data/ that nobody knows to open. The scripts write these
  // (scripts/lib/claude-tools.sh, log_problem) with the cause in plain words, not an exit code.
  problem: { hue: 0,   types: ["run-failed", "run-partial", "markets-failed", "cv-failed", "send-failed", "run-skipped"] },
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
// A run boundary is the one row worth spotting from across the page. So is a failure — and for the
// same reason: you are scanning for where something changed, not reading top to bottom.
const isRunStart = (t) => t === "run-start";
const isProblem = (t) => ACTIVITY_FAMILY.problem.types.includes(t);

function activityHTML(table) {
  if (!table.rows.length) return `<p class="empty">Nothing logged yet.</p>`;
  const body = table.rows
    .map((r) => {
      const type = String(r.type || "").trim();
      const fam = Object.entries(ACTIVITY_FAMILY).find(([, f]) => f.types.includes(type));
      const rowClass = isRunStart(type) ? " class=\"runrow\"" : isProblem(type) ? " class=\"probrow\"" : "";
      return `<tr data-type="${esc(type)}" data-fam="${esc(fam ? fam[0] : "other")}"${rowClass}>
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
  const label = { run: "Runs", track: "Tracking", find: "Finding", apply: "Applying", close: "Dismissals", done: "Tasks", config: "Config", notice: "Notifications", problem: "Problems" };
  return `<div class="taskfilters afilters">
      <button type="button" class="tf active" data-f="all">All (${table.rows.length})</button>
      ${fams.map(([k]) => `<button type="button" class="tf" data-f="${k}" style="--h:${ACTIVITY_FAMILY[k].hue}">${label[k]} (${count(k)})</button>`).join("")}
      <input class="tsearch asearch" placeholder="search the log…" autocomplete="off">
    </div>
    ${activityHTML(table)}`;
}

// A real on/off switch for a value that is genuinely a yes/no.
//
// These were text boxes containing the literal word "true" — asking someone to spell a boolean, in
// a field that would silently accept "ture". `channelEnabled()` in server/config.mjs already
// tolerates yes/on/1, which is a parser working around a UI that should never have posed the
// question this way.
//
// Browsers omit an unchecked checkbox from the POST entirely, so "off" and "never touched" look
// identical to the server — and handleSaveConfig deliberately treats an absent key as "leave it
// alone". The usual trick is a hidden `false` field before the checkbox, but NOT here: parseForm
// joins repeated keys with a comma (so multi-checkbox groups work), which would store the literal
// string "false,true" in the user's config file. Instead the form declares which keys are booleans
// in a `_bools` field, and the handler resolves absent-means-false from that list.
function toggleHTML(name, label, on, hint = "") {
  return `<label class="tgl">
    <input type="checkbox" name="${name}" value="true"${on ? " checked" : ""}>
    <span class="tgl-track"><span class="tgl-thumb"></span></span>
    <span class="tgl-text">${label}${hint ? `<span class="muted tgl-hint">${hint}</span>` : ""}</span>
  </label>`;
}

// Config values are strings from Markdown frontmatter, and an absent key means "default on" for
// these switches — matching channelEnabled()'s opt-OUT semantics in server/config.mjs.
const isOn = (v, dflt = true) => {
  const s = String(v ?? "").trim();
  if (!s) return dflt;
  return !/^(false|no|off|0)$/i.test(s);
};

/**
 * A comma-separated setting, edited as a list instead of a string.
 *
 * These were plain text boxes. Nothing told you the separator, "Cybersecurity - Israel" contains a
 * hyphen that reads like one, and free text constrains nothing — which is why this tracker ended up
 * with "Fintech" and "fintech" as two separate markets, each carrying its own proposals. A list
 * makes each value a discrete thing you can see and remove, and the control refuses a duplicate
 * that differs only by case or punctuation.
 *
 * Storage is unchanged: a hidden input carries the same comma-joined string the form always posted,
 * so criteria.md, the config file, and every agent that reads them are untouched. This is purely
 * the input control.
 *
 * `suggestions` renders a native <datalist>, which is a dropdown you can also type past — the exact
 * "pick one or add your own" behaviour wanted, with no library and no custom popup to get wrong.
 */
function chipsFieldHTML(name, label, value, { suggestions = [], placeholder = "", hint = "", sep: sepOpt = "", split: splitOpt = "" } = {}) {
  // Which character separates entries is a property of the DATA, not a global choice. `locations`
  // is stored as "Dubai, UAE; Remote" — semicolons separate, and the comma is part of a single
  // place name. Splitting that on commas would turn one location into two ("Dubai" and "UAE") and
  // quietly change what the scout searches for. So: if a semicolon is present it is the separator,
  // otherwise commas are. The same character is used to re-join, so the stored string keeps its
  // existing shape and no agent reading it sees a difference.
  //
  // Inferring it from the value alone breaks on an EMPTY field, which is every field on a first run:
  // a user who types the single location "Dubai, UAE" into an empty box has it stored comma-first
  // and read back as two places. So a caller that knows the field's shape can say so, and
  // `locations` does.
  const sep = sepOpt || (String(value || "").includes(";") ? ";" : ",");
  // Writing and READING can differ. `markets` writes commas but must accept semicolons too: a value
  // saved during the window when this field inferred its own separator is semicolon-joined, and a
  // comma-only field would render the whole line as one chip -- disagreeing with marketList(), just
  // in the other direction. Accepting both shows the four markets that were actually picked, and
  // the next Save rewrites them with commas, so the file heals itself by being looked at.
  const split = splitOpt || sep;
  const splitRe = new RegExp(`[${split}]`);   // only , and ; are used; both are literal in a class
  const values = String(value || "")
    .split(splitRe)
    .map((s) => s.trim())
    .filter(Boolean);
  const listId = `dl_${name}`;
  const chips = values
    .map(
      (v) => `<span class="chip" data-v="${esc(v)}">${esc(v)}<button type="button" class="chipx"
        aria-label="Remove ${esc(v)}" tabindex="-1">×</button></span>`
    )
    .join("");
  // Only offer a suggestion that is not already chosen.
  const chosen = new Set(values.map((v) => v.toLowerCase().replace(/[^a-z0-9]+/g, "")));
  const opts = suggestions
    .filter((s) => !chosen.has(String(s).toLowerCase().replace(/[^a-z0-9]+/g, "")))
    .map((s) => `<option value="${esc(s)}"></option>`)
    .join("");
  return `<div class="chipfield" data-name="${esc(name)}" data-sep="${sep}" data-split="${esc(split)}">
    <label class="chiplabel">${label}</label>
    <div class="chipbox">
      ${chips}
      <input type="text" class="chipin" ${suggestions.length ? `list="${listId}"` : ""}
             placeholder="${esc(placeholder)}" autocomplete="off" aria-label="${esc(label)}">
    </div>
    ${hint ? `<p class="muted chiphint">${hint}</p>` : ""}
    ${suggestions.length ? `<datalist id="${listId}">${opts}</datalist>` : ""}
    <input type="hidden" name="${esc(name)}" value="${esc(values.join(sep + " "))}">
  </div>`;
}

function criteriaFormHTML(criteria, marketNames = [], extraHidden = "") {
  const d = criteria.data ?? {};
  const val = (k) => esc(d[k] ?? "");
  const raw = (k) => d[k] ?? "";
  return `<form method="POST" action="/save-criteria" class="grid chipgrid" id="criteriaform">
    ${extraHidden}
    ${chipsFieldHTML("markets", "Markets", raw("markets"), {
      // The market files on disk ARE the valid options, so the dropdown cannot drift from reality.
      // Picking rather than typing is what stops a second "fintech" appearing beside "Fintech".
      suggestions: marketNames,
      placeholder: "pick or type a market…",
      hint: "— from your market lists; typing a new one creates it on the next /markets run",
      // Commas, said out loud rather than inferred. Without this, one pasted value containing a
      // semicolon flipped the whole field to semicolon-separated and SAVED it that way, while
      // marketList() below went on splitting only on commas -- so the box showed four markets and
      // every agent read one, named "Economic Development; Exporting; Trade; Government". A market
      // name has no comma in it, which is exactly why this field can say so and `locations` cannot.
      //
      // Semicolons are still ACCEPTED, for the lists already stored that way and for the paste that
      // caused this in the first place: someone copying "Economic Development; Exporting; Trade"
      // out of an industry list is doing the obvious thing, and it should become three markets.
      sep: ",",
      split: ",;",
    })}
    ${chipsFieldHTML("roles", "Target roles", raw("roles"), {
      suggestions: ["Product Management", "Solution Architect", "Solutions Engineer", "VP Product", "System Engineer", "Presales Engineer", "Technical Account Manager"],
      placeholder: "add a role title…",
    })}
    ${chipsFieldHTML("locations", "Locations", raw("locations"), {
      suggestions: ["Dubai, UAE", "Abu Dhabi, UAE", "Remote", "Saudi Arabia", "Qatar"],
      placeholder: "add a location…",
      sep: ";",
    })}
    ${chipsFieldHTML("seniority", "Seniority", raw("seniority"), {
      suggestions: ["Senior", "Principal", "Director", "VP", "Head of", "Lead"],
      placeholder: "add a level…",
    })}
    <div class="actions"><button type="submit">Save</button></div>
    ${/* The three scoring weights live in Advanced, but they must still POST from THIS form —
         /save-criteria writes all of criteria.md, so omitting them here would blank them on every
         save. Rendered hidden, and mirrored by the visible Advanced inputs via a tiny sync script. */
      ["weight_market", "weight_role", "weight_cv"]
        .map((k) => `<input type="hidden" name="${k}" id="h_${k}" value="${val(k)}">`)
        .join("")}
  </form>`;
  // The separate "Add market" form is gone. It did exactly what the Markets field above does —
  // append a name to criteria.md — so the screen offered two controls for one action, neither of
  // which created the market file or started any work. Adding a market is now one place, and
  // saving it actually sets the market up (see handleSaveCriteria).
}

// Scoring weights: real controls, but the wrong thing to put in front of someone on day one. They
// only make sense relative to each other, so they render as sliders showing their normalised share
// rather than three decimals the user is left to make sum to 1.
function weightsHTML(criteria) {
  const d = criteria.data ?? {};
  const num = (k, dflt) => {
    const n = Number(d[k]);
    return Number.isFinite(n) ? n : dflt;
  };
  const w = { weight_market: num("weight_market", 0.4), weight_role: num("weight_role", 0.35), weight_cv: num("weight_cv", 0.25) };
  const label = { weight_market: "Market fit", weight_role: "Role match", weight_cv: "CV match" };
  const rows = Object.entries(w)
    .map(
      ([k, v]) => `<label class="wrow">
        <span class="wname">${label[k]}</span>
        <input type="range" class="wslider" data-for="${k}" min="0" max="100" step="5" value="${Math.round(v * 100)}">
        <span class="wpct" data-pct="${k}">—</span>
      </label>`
    )
    .join("");
  return `<p class="muted">How much each factor counts when a role is scored. Only the balance between
    them matters — the percentages shown are each one's share of the total.</p>
    <div class="wgrid">${rows}</div>
    <p class="muted" id="wnote"></p>
    ${/* Weights live in criteria.md, not the config file, so they belong to the criteria form —
         which is a SIBLING form further up the page. `form="criteriaform"` is the standards-based
         way to submit it from here, so the button next to the sliders saves the sliders, rather
         than the nearby "Save settings" button (which posts a different form) appearing to. */""}
    <button type="submit" form="criteriaform" class="btn-secondary btn-small">Save weights</button>`;
}

function profileHTML(profile) {
  const parsed = profile.data?.parsed_at;
  const status = parsed
    ? `<span class="pill s-offer">CV parsed ${esc(parsed)}</span>`
    : `<span class="pill s-rejected">No CV parsed</span>`;
  // The upload form that used to live here left you to run /parse-cv yourself, and a PDF uploaded
  // but never read is indistinguishable from no CV at all. One page now does both.
  return `<p>${status} ${profile.data?.source_cv ? esc(profile.data.source_cv) : ""}</p>
    <p><a class="btn-small linkbtn" href="/setup-step?step=cv&back=cv">${parsed ? "Replace my CV" : "Add my CV"}</a></p>
    <p class="muted">Uploading it also reads it — Claude turns the PDF into <code>data/profile.md</code>,
      which is what roles are scored against. <code>/parse-cv</code> in Claude Code does the same thing.</p>`;
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
function sec(id, titleHTML, bodyHTML, actionsHTML = "") {
  return `<section class="sec open" data-id="${id}">
    ${titleHTML ? `<div class="sechead"><h2>${titleHTML}</h2>${actionsHTML}</div>` : ""}
    <div class="secbody">${bodyHTML}</div>
  </section>`;
}

// One tab's pane. Exactly one carries `on`; the rest are hidden by CSS until clicked.
function tabPanel(id, active, inner) {
  return `<div class="tabpanel${active ? " on" : ""}" data-tab="${id}" ${active ? "" : 'hidden'}>${inner}</div>`;
}

// The tab strip. `tabs` = [{id, label, count}]. Rendered server-side with the active tab already
// chosen, so there is no flash of the wrong pane on load.
function tabStrip(tabs, activeId, trailingHTML = "") {
  return `<nav class="tabs" role="tablist">${tabs
    .map(
      (t) =>
        `<button type="button" class="tab${t.id === activeId ? " on" : ""}" role="tab" data-tab="${t.id}"
           aria-selected="${t.id === activeId}">${t.label}${
          t.count != null ? `<span class="tn">${t.count}</span>` : ""
        }</button>`
    )
    .join("")}${trailingHTML ? `<span class="tabs-end">${trailingHTML}</span>` : ""}</nav>`;
}

// A new version, and what is in it.
//
// Its own modal rather than uiConfirm: that one writes its body with textContent, deliberately, so
// callers cannot smuggle markup into a confirmation. Three grouped lists are not prose, so this
// gets purpose-built markup and keeps the same .overlay / .modal shell as every other dialog.
//
// Rendered on the page whether or not it is due; showing it is the script's decision, which keeps
// the "have they already said not now" test in one place.
function updateModal(u, page = "") {
  if (!u || !u.available) return "";
  // What "Not now" records. The summary is what Activity shows weeks later, so it is a whole
  // sentence and it says where the offer went rather than only that there was one.
  const key = updateNoticeKey(u.latest);
  const summary = `JobSeeker ${u.latest} is available — install it from Settings whenever you want it.`;
  const group = (label, items) =>
    items.length
      ? `<div class="upd-group">
          <p class="upd-glabel">${esc(label)}</p>
          <ul class="upd-list">${items.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
        </div>`
      : "";
  return `<div id="updateOverlay" class="overlay" role="dialog" aria-modal="true" aria-labelledby="updTitle">
    <div class="modal upd-modal">
      <div class="upd-head">
        <h3 id="updTitle">JobSeeker ${esc(u.latest)} is available</h3>
        <span class="upd-have">You have ${esc(u.current)}</span>
      </div>
      ${u.date ? `<p class="upd-date">Released ${esc(u.date)}</p>` : ""}
      <div class="upd-groups">
        ${group("New", u.groups.new)}
        ${group("Changed", u.groups.changed)}
        ${group("Fixed", u.groups.fixed)}
      </div>
      <p class="upd-safe">Your applications, tasks, settings and CV are left exactly as they are.
        JobSeeker quits and reopens by itself, which takes about a minute.</p>
      <div class="actions confirm-acts">
        <form method="POST" action="/dismiss-notice" class="inline">
          ${page === "settings" ? `<input type="hidden" name="_page" value="settings"><input type="hidden" name="_tab" value="setup">` : ""}
          <input type="hidden" name="key" value="${esc(key)}">
          <input type="hidden" name="summary" value="${esc(summary)}">
          <button type="submit" class="btn-secondary">Not now</button>
        </form>
        <form method="POST" action="/update-now" class="inline">
          <input type="hidden" name="tag" value="${esc(u.tag)}">
          <button type="submit">Update now</button>
        </form>
      </div>
    </div>
  </div>`;
}

// The key an offer is dismissed under. One expression in one place, because the dialog writes
// it, the page test reads it and /run-state has to agree with both -- three copies of a string
// is three chances for a Not now that does not stick.
function updateNoticeKey(version) {
  return `update:${version}`;
}

// Whether the dialog is DUE, handed to the script that decides.
//
// "Not now" is an answer, and it is remembered: the offer is not put back in front of the user
// the next day, or the day after. It is keyed to the VERSION, so the next release is a
// different question and asks itself; and the offer never disappears, it moves to the version
// row in Settings, which carries the same Update button.
//
// `forced` is a manual "Check for updates": someone who asks the question out loud is not being
// told they already answered it, so the dialog opens whatever they said before.
function updateSignal(all, forced) {
  if (!all.update?.available) return "";
  const dismissed = Boolean((all.dismissedNotices || {})[updateNoticeKey(all.update.latest)]);
  return `<script>window.__UPDATE__=${JSON.stringify({
    version: all.update.latest,
    dismissed,
    forced: Boolean(forced),
  }).replace(/</g, "\\u003c")};</script>`;
}

// ---------- Notices ----------
// The banners at the top of Today. Each one is a fact about the machinery — the run was partial,
// the schedule switched itself off, Chrome cannot be read — and each one used to occupy a fifth of
// the screen with no way to put it away short of fixing it.
//
// So every notice carries a key and an × . Dismissing writes the key (see readDismissedNotices for
// why it is a key and not a deletion) and logs the notice's own words to the activity table as a
// `notification`, where the Notifications filter finds it. Nothing is lost by pressing ×; it moves.
//
// `summary` is what Activity will show, so it is written as a whole sentence rather than a slug —
// the log is read weeks later, without the banner beside it.
function notice({ key, kind = "warn", title, body, summary, dismissed, tab = "today" }) {
  if (!key || (dismissed || {})[key]) return "";
  return `<div class="alert ${kind} noticebox">
    <div class="notice-body"><strong>${title}</strong> ${body}</div>
    <form method="POST" action="/dismiss-notice" class="notice-x">
      <input type="hidden" name="_tab" value="${esc(tab)}">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="hidden" name="summary" value="${esc(summary)}">
      <button type="submit" class="xbtn" aria-label="Dismiss this notice"
        title="Dismiss — kept in Activity under Notifications">&times;</button>
    </form>
  </div>`;
}

// ---------- Run now ----------
// The manual half of the product. Everything the 08:00 schedule does can also be started by hand,
// and there is exactly ONE menu of what can be started, one endpoint that starts it, and one busy
// state — rendered in two shapes. Today carries the whole menu behind a dropdown; each tab carries
// the single run that fills that tab, where its result will actually land.
//
// Order matters: "Everything" is first so it is the pre-selected option. Someone who opens the
// dropdown and hits Run without reading gets the full pipeline, which is the safe wrong answer —
// it queues approvals and sends nothing.
const RUN_MENU = [
  ["job-run", "Everything", "The full daily pipeline — 10–40 min"],
  ["track", "Read my channels", "Gmail, Calendar, WhatsApp and LinkedIn — 2–5 min"],
  ["curate", "Find new roles", "Scores openings at your target companies — 3–8 min"],
  ["followup", "Draft follow-ups", "Writes what is due, for you to approve — 1–3 min"],
];
// `apply` is not on the Run now menu — it is started from a job row and needs a target — but it
// takes the same lock, so every badge and every refusal has to be able to name it.
const runLabel = (slug) => (slug === "apply" ? "Filling an application" : RUN_MENU.find((r) => r[0] === slug)?.[1] || slug);

// Which agent has the browser, and what it is doing with it — said the way the user would say it.
//
// Chrome is serial (AGENT-RULES §13), so anything that drives it has to wait its turn. "Disabled"
// alone answers none of the questions a person actually has at that moment: what is running, why
// can I not do this, and how long. This maps the running slug to that answer.
const BUSY_SAYS = new Map([
  ["job-run", ["The daily run", "working through your whole pipeline"]],
  ["track", ["The channel tracker", "reading your WhatsApp and LinkedIn"]],
  ["curate", ["The role scout", "searching for new roles"]],
  ["followup", ["The follow-up writer", "drafting your due follow-ups"]],
  ["apply", ["The application agent", "filling in an application form"]],
  ["market", ["The prioritisation agent", "researching a market"]],
]);

function busyMessage(busy) {
  if (!busy) return "";
  const [who, doing] = BUSY_SAYS.get(busy.slug) || ["A run", "using the browser"];
  const el = runElapsed(busy.started);
  return `${who} is using the browser — ${doing}${el ? `, ${el} so far` : ""}. Only one thing can drive Chrome at a time, so this will work again the moment it finishes.`;
}

// A gated button keeps its click. Marking it `disabled` would have been simpler and is what this
// used to do — but a disabled button fires NO events, so there is nowhere to hang the explanation
// and the user is left clicking a dead control. aria-disabled greys it out and still reports it as
// unavailable to a screen reader, while leaving the click for the balloon.
const busyAttrs = (busy) =>
  busy ? ` aria-disabled="true" data-busy="${esc(busyMessage(busy))}"` : "";

// "2 min" beats a UTC timestamp for the only question being asked: has this hung, or did I start it
// a moment ago? Computed at render — the page is reloaded to find out anyway.
function runElapsed(started) {
  const t = Date.parse(started || "");
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// One running job, said the same way everywhere it appears.
function runBadge(busy, { own = false } = {}) {
  if (!busy) return "";
  const el = runElapsed(busy.started);
  const what = own ? "Already running" : `${runLabel(busy.slug)} is running`;
  return `<span class="runbadge" title="Started ${esc(String(busy.started).slice(0, 16).replace("T", " "))} · pid ${esc(String(busy.pid))}">
    <span class="rdot"></span>${esc(what)}${el ? ` · ${esc(el)}` : ""}</span>`;
}

// Two shapes, one form. `slugs` of length 1 is a plain button — the per-tab trigger, sitting in the
// section header of the tab its result lands in. The full menu is a popover: one "Run now" button in
// the tab bar that unfolds into the list, so four commands cost one button of screen until asked for.
//
// Everything is disabled while ANY run is live: Chrome is serial (AGENT-RULES §13) and two runs
// reading WhatsApp at once read each other's tabs. run-now.sh refuses a second run regardless, and
// so does the endpoint — disabling, and saying what is running, is so the refusal is never a surprise.
function runNowButton({ slug, tab, busy }) {
  const row = RUN_MENU.find((r) => r[0] === slug);
  if (!row) return "";
  const tip = busy ? `${runLabel(busy.slug)} is already running — only one run at a time` : row[2];
  // No badge here. The stat bar carries one already, a few centimetres up and on every tab, so a
  // second copy beside the button said the same sentence twice on one screen. The button is greyed
  // and answers a click with the balloon, which is the part the stat bar cannot do.
  return `<div class="runctl compact">
    <form method="POST" action="/run-now" class="inline">
      <input type="hidden" name="_tab" value="${esc(tab)}">
      <input type="hidden" name="slug" value="${esc(slug)}">
      <button type="submit" class="btn-small"${busyAttrs(busy)} title="${esc(tip)}">${esc(row[1])}</button>
    </form>
  </div>`;
}

// The menu, folded. Rides in the tab bar on the far right, on every tab, next to the badge that says
// what is already running — so the answer to "is this worth clicking" is beside the button itself.
function runNowMenu({ tab, busy, lastNow }) {
  const lastLine = (() => {
    if (!lastNow || busy) return "";
    const st = String(lastNow.state || "");
    const pill =
      st === "ok"
        ? `<span class="ok-pill">finished</span>`
        : st === "partial"
          ? `<span class="warn-pill">finished, partly</span>`
          : st.startsWith("skipped-")
            ? `<span class="warn-pill">${esc(st.replace("skipped-", "skipped: "))}</span>`
            : `<span class="bad-pill">${esc(st)}</span>`;
    return `<p class="runmenu-last">Last run from here: <b>${esc(lastNow.label || lastNow.slug)}</b> ${pill}
      <span class="muted">${esc(String(lastNow.finished || "").slice(0, 16).replace("T", " "))}</span></p>`;
  })();
  return `<span class="popwrap runmenu-wrap">
    <button type="button" class="runmenu-btn" aria-haspopup="dialog" aria-expanded="false"
      onclick="popToggle('runmenu', this)"
      title="${esc(busy ? `${runLabel(busy.slug)} is already running` : "Start one of the job-search commands now")}">
      Run now <span class="caret" aria-hidden="true">▾</span></button>
    <div id="runmenu" class="pop pop-run hide" role="dialog" aria-label="Run now">
      <p class="pop-h">Run now</p>
      <p class="pop-sub">Nothing here applies or sends — it queues approvals for you, exactly as the
        scheduled run does. One at a time: Chrome cannot be driven by two.</p>
      ${
        busy
          ? `<div class="runmenu-busy">${runBadge(busy)}
               <span class="muted">Started ${esc(String(busy.started).slice(0, 16).replace("T", " "))}${
                 busy.starting ? ", starting up" : ""
               } · pid ${esc(String(busy.pid))}. Progress is in <code>data/.run-now.log</code>.</span></div>`
          : ""
      }
      <div class="runmenu-list">
        ${RUN_MENU.map(
          ([slug, label, sub]) => `<form method="POST" action="/run-now">
            <input type="hidden" name="_tab" value="${esc(tab)}">
            <input type="hidden" name="slug" value="${esc(slug)}">
            <button type="submit" class="runmenu-item"${busyAttrs(busy)}>
              <span class="rmi-label">${esc(label)}</span>
              <span class="rmi-sub">${esc(sub)}</span>
            </button></form>`
        ).join("")}
      </div>
      ${lastLine}
    </div>
  </span>`;
}

// "+ Add task" rides in the tab bar beside Run now. Adding a follow-up is the one thing you do from
// every tab, and as a permanent row at the top of Today it cost two lines of the screen whether or
// not you were adding anything — while still being easy to miss, because a field that is always
// there reads as furniture. Folded into a button, it is one line of chrome and an explicit act.
//
// The panel is the same `.pop` shell as the Run now menu, so Escape, click-outside, viewport
// clamping and focus-return all come from popToggle rather than from a second implementation here.
//
// It shows what it parsed BEFORE you commit: the same text can be read three ways ("Friday" is a
// date, "call" is a type, "Dana" is a who), and a task that quietly landed with the wrong due date
// is worse than no task, because it disappears from Today and resurfaces as overdue.
function addTaskMenu() {
  return `<span class="popwrap addtask-wrap">
    <button type="button" class="runmenu-btn addtask-btn" aria-haspopup="dialog" aria-expanded="false"
      aria-label="Add a task" onclick="popToggle('addtask', this)"
      title="Add a follow-up, typed in plain English">
      <span class="atplus" aria-hidden="true">+</span><span class="atlabel">Add task</span></button>
    <div id="addtask" class="pop pop-addtask hide" role="dialog" aria-label="Add a task">
      <p class="pop-h">Add a follow-up</p>
      <p class="pop-sub">Type it as you would say it. Below is what will land in the columns.</p>
      <form method="POST" action="/add-task-nl" id="addtaskform">
        <input name="nl" id="addtasknl" data-popfocus autocomplete="off" required
               placeholder="e.g. call Dana Friday about the referral">
        <div id="addtaskparsed" class="parsed hide" aria-live="polite"></div>
        <p class="parsenote">Nothing matched a column? It still saves — the whole sentence is kept
          as the detail.</p>
        <div class="pop-acts">
          <span class="esc"><kbd>&#8629;</kbd> to add · <kbd>Esc</kbd> to cancel</span>
          <button type="button" class="btn-secondary" onclick="popClose('addtask')">Cancel</button>
          <button type="submit">OK</button>
        </div>
      </form>
    </div>
  </span>`;
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
// What setup did not finish, derived from the files rather than from a progress counter — so it is
// equally right for someone who skipped a step in the wizard, someone who never ran it, and someone
// who set everything up with /onboard.
function unfinishedHTML(w, markets) {
  if (!w) return "";
  const rows = [];
  const row = (state, cls, title, why, action) =>
    `<div class="titem"><span class="ti-co"><span class="${cls}">${esc(state)}</span></span>
      <span class="ti-tx"><b>${esc(title)}</b><div class="ti-sub">${why}</div></span>
      <span class="ti-acts">${action}</span></div>`;

  if (!w.profileParsed) {
    rows.push(
      row(
        w.cvFiles.length ? "unread" : "missing",
        "bad-pill",
        "Your CV",
        w.cvFiles.length
          ? "A PDF is uploaded but nothing has been read out of it, so roles are not scored against your experience."
          : "Roles cannot be scored against your experience without it, and the summary JobSeeker drafts for you stays empty.",
        `<a class="btn-small linkbtn" href="/setup-step?step=cv&back=settings">${w.cvFiles.length ? "Read it now" : "Add my CV"}</a>`
      )
    );
  }
  const unresearched = (markets || []).filter((m) => !m.table.rows.length);
  if (!String(w.criteria.markets || "").trim()) {
    rows.push(row("none yet", "bad-pill", "Markets",
      "A market is an industry to research. Without one there is nowhere to hunt, and Today stays empty.",
      `<a class="btn-small linkbtn" href="/setup-step?step=markets&back=settings">Add a market</a>`));
  } else if (unresearched.length) {
    rows.push(row("unresearched", "bad-pill", `Markets — ${esc(unresearched.map((m) => m.label).join(", "))}`,
      "Added, but never researched, so they have no company list yet.",
      `<a class="btn-small linkbtn" href="/">Research from Today</a>`));
  }
  if (!w.answered) {
    rows.push(row(w.skipped.includes("answers") ? "skipped" : "empty", "ok-pill", "Application answers",
      "The handful of questions every form asks. Nothing depends on them — it just saves you looking them up.",
      `<a class="btn-small linkbtn" href="/setup-step?step=answers&back=settings">Fill them in</a>`));
  }
  // The wizard stopped asking where approvals should reach you, so this is now the only place that
  // says so. A setting the wizard drops has to reappear somewhere, or it is not "moved to Settings",
  // it is gone.
  if (!String(w.cfg.approval_channels || "").trim()) {
    rows.push(row("not set", "ok-pill", "Where approvals reach you",
      "Chat by default. Add WhatsApp and the digest, and anything waiting on your yes, arrive on your phone.",
      `<a class="btn-small linkbtn" href="/setup-step?step=channels&back=settings">Choose</a>`));
  }
  if (!rows.length) return "";
  return `<div class="tblock">
      <p class="th">Unfinished setup <span class="muted">— each one runs on its own; nothing else has to be redone</span></p>
      ${rows.join("")}
      <p class="tiny muted" style="margin-top:10px">Prefer the terminal? <code>/onboard</code> in Claude
        Code asks the same questions and writes the same files. Or
        <a href="/welcome">run the whole wizard again</a>.</p>
    </div>`;
}

// Windows only: the extension's connection state and, once Connect has been clicked, the two
// steps that pair it. Shared by Settings and the wizard so the words cannot drift apart.
function bridgeStateHTML(bs) {
  if (!bs) return `<span class="bad-pill">bridge unavailable</span>`;
  if (bs.connected) return `<span class="ok-pill">connected</span>`;
  if (bs.paired) return `<span class="bad-pill">Chrome not running</span>`;
  return `<span class="bad-pill">not connected</span>`;
}

/**
 * What the state actually costs, and what to do about it. Three states, three different fixes, and
 * a pill on its own tells the reader none of that.
 */
function bridgeWhyHTML(bs) {
  const lost =
    "Until it is connected, a run cannot read WhatsApp Web, LinkedIn or careers pages. Everything " +
    "else — your email, the tracker, applying — is unaffected.";
  if (!bs) return `The bridge did not start. Restart JobSeeker, then re-check.`;
  if (bs.connected) return `Reading WhatsApp Web, LinkedIn and careers pages through your own Chrome.`;
  if (bs.paired) {
    return `This Chrome is paired, but nothing is answering. Open Chrome and give it a moment. ${lost}`;
  }
  return `The JobSeeker Bridge extension is not connected to this dashboard yet. ${lost}`;
}

function bridgeConnectHTML(back, extraHidden = "") {
  return `<form method="POST" action="/bridge-mint" class="inline">${extraHidden}
      <input type="hidden" name="_back" value="${esc(back)}">
      <button type="submit" class="btn-small">Connect</button></form>`;
}

/** The two steps, with no code yet. Pressing Connect adds the code to the same shape. */
function bridgeHowToHTML() {
  const folder = path.join(ROOT, "extension");
  return `<div class="alert warn bridge-pair">
      <ol>
        <li>Open <code>chrome://extensions</code>, turn on <b>Developer mode</b>, click <b>Load unpacked</b>
          and choose this folder:<br><code class="bridge-path" title="Select and copy">${esc(folder)}</code></li>
        <li>Press <b>Connect</b> above for a six-digit code, then enter it in the extension's <b>Options</b>.</li>
      </ol>
      <p class="muted">You only do this once. Chrome does not let a program add an extension for you.</p>
      <figure class="bridge-shot">
        <img src="/help-chrome-extensions.png" alt="Chrome's Extensions page, with two things circled: the Developer mode switch at the top right,
          and the Load unpacked button below it on the left. Once loaded, JobSeeker Bridge appears as a card."
          loading="lazy" width="1050" height="560">
        <figcaption>Chrome's Extensions page. Developer mode is the switch top right; Load unpacked appears
          under it once that is on. After loading, JobSeeker Bridge shows up as a card here.</figcaption>
      </figure>
      <figure class="bridge-shot">
        <img src="/help-chrome-details.png" alt="The extension's Details page, with the Extension options row
          circled near the bottom, below Collect errors and above Source." loading="lazy" width="695" height="570">
        <figcaption>Press <b>Details</b> on that card, then scroll to <b>Extension options</b> near the
          bottom. That is where the code goes.</figcaption>
      </figure>
    </div>`;
}

function bridgePairingHTML(pair) {
  if (!pair) return "";
  const exp = typeof pair.expires === "number" ? pair.expires : Date.parse(pair.expires);
  const when = Number.isNaN(exp) ? "" : new Date(exp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const folder = path.join(ROOT, "extension");
  return `<div class="alert warn bridge-pair">
      <ol>
        <li>Open <code>chrome://extensions</code>, turn on <b>Developer mode</b>, click <b>Load unpacked</b>
          and choose this folder:<br><code class="bridge-path" title="Select and copy">${esc(folder)}</code></li>
        <li>Open the extension's <b>Options</b> and enter this code:
          <div class="bridge-code">${esc(String(pair.code))}</div>
          ${when ? `<span class="muted tiny">Expires at ${esc(when)}.</span>` : ""}</li>
      </ol>
    </div>`;
}

function setupHTML(st, criteria, marketNames = [], subReq = "", upd = null) {
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
  const updRow = (() => {
    if (!upd) return null;
    if (upd.available) {
      return [
        "JobSeeker",
        `<span class="bad-pill">${esc(upd.latest)} available</span>`,
        `<form method="POST" action="/update-now" class="inline">
           <input type="hidden" name="tag" value="${esc(upd.tag)}">
           <button type="submit" class="btn-small">Update</button></form>`,
        `You are on ${esc(upd.current)}.${upd.date ? ` Released ${esc(upd.date)}` : ""}${
          upd.url ? ` — <a href="${esc(upd.url)}" target="_blank" rel="noreferrer">what changed</a>.` : "."
        }`,
      ];
    }
    return [
      "JobSeeker",
      `<span class="ok-pill">up to date</span>`,
      "",
      `${esc(upd.current)}${upd.checkedAt ? `, checked ${esc(String(upd.checkedAt).slice(0, 16).replace("T", " "))}` : ""}.`,
    ];
  })();

  const rows = [
    ...(updRow ? [updRow] : []),
    [
      "Browser access",
      pill(canRead, b?.capabilities?.read_mechanism || "working", "cannot read pages"),
      actionBtn("probe", "Re-check"),
      canRead ? "" : (b?.blockers || []).join(" "),
    ],
    platform.IS_WIN
      ? [
          "Chrome extension",
          bridgeStateHTML(st.bridge),
          st.bridge && st.bridge.connected ? "" : bridgeConnectHTML("settings", hidden),
          bridgeWhyHTML(st.bridge) +
            // A red pill with no way forward is a dead end, so the steps appear as soon as there is
            // something to fix, rather than waiting for the user to guess that Connect comes first.
            (st.bridge && st.bridge.connected
              ? ""
              : bridgePairingHTML(activePairing()) || bridgeHowToHTML()),
        ]
      : [
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
      "Reads your channels and sends the digest. It never applies or sends anything." +
        // Without this, Settings shows a time and says nothing about the fact that the CADENCE was
        // changed for you — so the one page that looks authoritative about the schedule would be
        // the one page that omits half of it.
        (st.ladderTier > 1
          ? ` <b>Currently ${esc(
              { 2: "Mondays and Thursdays", 3: "Mondays only", 4: "not running" }[st.ladderTier] || "reduced"
            )}</b> — JobSeeker stepped this down because roles were not being reviewed. Restoring it returns to the cadence you chose, not to every day.`
          : ""),
    ],
  ];

  // --- what only you can do -----------------------------------------------------------------
  const manual = [];
  // Apple Events and the Automation pane do not exist on Windows; there the extension row above is
  // the whole story.
  if (!platform.IS_WIN) {
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

  // ---- panes -----------------------------------------------------------------------------------
  //
  // Setup was one scroll: criteria, spend, channels, a collapsed Advanced, the system table and a
  // spend-history table, in that order, with no way to see any one of them without the other five.
  // It is now four sub-panes behind a pill row.
  //
  // Two things constrain the markup, and both are why the panes are plain <div>s rather than
  // separate forms:
  //   * Roles posts to /save-criteria; Channels, Advanced and Spend all post to /save-config. So
  //     ONE cfgform wraps those three — a hidden <div> still submits its inputs, which is what keeps
  //     saving from Channels from blanking what Advanced holds.
  //   * The Advanced weight sliders mirror hidden inputs inside the CRITERIA form (see
  //     criteriaFormHTML). They are in different panes but the same document, so the existing sync
  //     script still finds both.
  //
  // Spend is built and last, but not shown: on a paid Claude plan a running total reads as a second
  // bill for the same work. Its inputs stay in the form so the values survive every save. One flag
  // brings it back.
  const SPEND_HIDDEN = true;
  const PANES = [
    ["roles", "Roles", "what you are looking for"],
    ["channels", "Channels", "what JobSeeker may read, and where it asks you"],
    ["advanced", "Advanced", "scoring, privacy and applying"],
    ["system", "System checks", "whether it is actually working"],
    ["spend", "Spend", "what a run is allowed to cost"],
  ].filter(([id]) => !(SPEND_HIDDEN && id === "spend"));

  const activeSub = PANES.some(([id]) => id === subReq) ? subReq : PANES[0][0];
  const subStrip = `<div class="subtabs" role="tablist" aria-label="Setup sections">
    ${PANES.map(
      ([id, label, blurb]) => `<button type="button" class="subpill${id === activeSub ? " on" : ""}"
        role="tab" data-sub="${esc(id)}" data-blurb="${esc(blurb)}"
        aria-selected="${id === activeSub}">${esc(label)}</button>`
    ).join("")}
  </div>`;
  const blurbOf = (id) => (PANES.find(([p]) => p === id) || ["", "", ""])[2];
  const pane = (id, inner) =>
    `<div class="subpane${id === activeSub ? " on" : ""}" data-sub="${esc(id)}"${
      id === activeSub ? "" : " hidden"
    }>${inner}</div>`;

  // Every form in here is stamped with the pane it was submitted from, so a save comes back to it.
  const subField = (id) => `<input type="hidden" name="_sub" value="${esc(id)}">`;

  const spendPane = `
    <div class="cfggrid" style="max-width:640px">
      <label>Cap per run (USD)<input name="max_spend_per_run_usd" value="${esc(cfg.max_spend_per_run_usd ?? "5")}" inputmode="decimal"></label>
      <label>Monthly ceiling (USD, blank = none)<input name="max_spend_per_month_usd" value="${esc(cfg.max_spend_per_month_usd ?? "")}" inputmode="decimal" placeholder="no ceiling"></label>
    </div>
    <div class="spendcard">
      <div class="spendrow"><span class="muted">Spent this month</span>
        <span class="spendnum">$${(sp.month_total_usd || 0).toFixed(2)}</span></div>
      <div class="muted tiny">across ${sp.month_runs || 0} run${sp.month_runs === 1 ? "" : "s"}.
        Past the ceiling the daily run does not start, and tells you why.</div>
    </div>
    <p class="muted panenote">This is what JobSeeker's own runs cost through your Claude plan. It is
      not a second bill.</p>`;

  return `
  ${subStrip}
  <p class="subblurb muted">${esc(blurbOf(activeSub))}</p>
  <div class="subpanes">

    ${pane("roles", criteriaFormHTML(criteria, marketNames, subField("roles")))}

    <form method="POST" action="/save-config" class="cfgform">${hidden}
      <input type="hidden" name="_sub" id="cfg_sub" value="${esc(activeSub)}">
      <input type="hidden" name="_bools" value="whatsapp_web_enabled,linkedin_enabled,linkedin_open_tab">

      ${pane("channels", `
        <div class="tglgrid">
          ${toggleHTML("whatsapp_web_enabled", "Read WhatsApp Web", isOn(cfg.whatsapp_web_enabled), "Reads threads you have already read; never opens an unread chat.")}
          ${toggleHTML("linkedin_enabled", "Read LinkedIn", isOn(cfg.linkedin_enabled), "Same rule, through your logged-in Chrome.")}
          ${toggleHTML("linkedin_open_tab", "Open a LinkedIn messaging tab", isOn(cfg.linkedin_open_tab, false), "Off: only reads a tab you leave open. On: opens one, which can mark the first conversation read.")}
        </div>
        <div class="panerule"></div>
        <div class="cfggrid">
          ${chipsFieldHTML("approval_channels", "Where to send approvals", cfg.approval_channels ?? "", {
            suggestions: ["whatsapp", "chat"],
            placeholder: "add a channel…",
          })}
          <label>Your WhatsApp number<input name="whatsapp_owner_jid" value="${esc(cfg.whatsapp_owner_jid ?? "")}" placeholder="971xxxxxxxxx@s.whatsapp.net"></label>
        </div>
        <div class="paneacts"><button type="submit">Save settings</button></div>`)}

      ${pane("advanced", `
        <p class="th">Scoring weights</p>
        ${weightsHTML(criteria)}

        <p class="th">Privacy</p>
        <div class="cfggrid">
          ${chipsFieldHTML("ignored_chats", "Chats never to log", cfg.ignored_chats ?? "", {
            placeholder: "add a chat name…",
            hint: "— matched as a case-insensitive prefix",
          })}
          <label>Company aliases<input name="company_aliases" value="${esc(cfg.company_aliases ?? "")}" placeholder="oldname=New Name"></label>
        </div>

        <p class="th">Applying</p>
        <div class="cfggrid" style="max-width:440px">
          ${chipsFieldHTML("apply_stop_before", "Pause applying before", cfg.apply_stop_before ?? "", {
            suggestions: ["each_section", "file_upload", "unknown_question", "submit"],
            placeholder: "add a checkpoint…",
          })}
        </div>
        <p class="muted panenote">Checkpoints where an application pauses for you. Removing <code>submit</code>
          does <b>not</b> let anything be sent without approval — that gate is in the agent rules, not here.</p>
        <div class="paneacts"><button type="submit">Save settings</button></div>`)}

      ${
        // Hidden, but still submitted: dropping these inputs would let a save from another pane
        // rewrite the config file without them.
        SPEND_HIDDEN
          ? `<div class="subpane" data-sub="spend" hidden>${spendPane}</div>`
          : pane("spend", `${spendPane}<div class="paneacts"><button type="submit">Save settings</button></div>`)
      }
    </form>

    ${pane("system", `
      <div class="scroll"><table><tbody>
        ${rows.map(([k, v, act, note]) => `<tr><td class="nw"><b>${esc(k)}</b></td><td class="nw">${v}</td><td class="nw">${act}</td><td class="muted">${note}</td></tr>`).join("")}
        ${chanRow("Gmail / Calendar", st.channels.gmail, "Connected in Claude Code, not here.")}
        ${chanRow("WhatsApp", st.channels.whatsapp, "Read through Chrome by the daily run.")}
        ${chanRow("LinkedIn", st.channels.linkedin, "Read through Chrome by the daily run.")}
        <tr><td class="nw"><b>CV</b></td><td class="nw">${st.profileParsed ? `<span class="ok-pill">parsed</span>` : `<span class="bad-pill">not parsed</span>`}</td><td class="nw"></td><td class="muted">Upload on the CV tab, then run <code>/parse-cv</code> in Claude Code.</td></tr>
      </tbody></table></div>

      ${manual.length ? `<p class="th">Only you can do these</p>` + manual.map(([k, v]) => `<div class="alert warn"><b>${esc(k)}</b>${v}</div>`).join("") : ""}`)}
  </div>
  `;
}

async function systemStatus() {
  let browser = null;
  try {
    browser = JSON.parse(await fs.readFile(path.join(DATA, ".browser-status.json"), "utf8"));
  } catch {
    /* probe has not run here yet */
  }

  // platform.mjs is the only module that knows which OS this is; everything here is OS-neutral.
  const [agentStatus, schedInstalled, schedShown, spendRaw] = await Promise.all([
    platform.browserAgentStatus(),
    platform.isScheduled(),
    platform.scheduleShow(),
    platform.node([path.join(ROOT, "server", "record.mjs"), "list-spend", "--limit", "10"]),
  ]);
  const agent = { ok: agentStatus.installed };
  const sched = { ok: schedInstalled };
  const schedTime = { out: schedShown };

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
    // The tier is a fact ABOUT the schedule, so it travels with it. Read straight from the ladder's
    // own state file rather than recomputed, so Settings and the Today banner cannot disagree.
    ladderTier: await (async () => {
      try {
        return Number(JSON.parse(await fs.readFile(path.join(DATA, ".schedule-tier.json"), "utf8")).tier) || 1;
      } catch {
        return 1;
      }
    })(),
    spend,
    channels: {
      gmail: ageDays(wm.gmail),
      whatsapp: ageDays(wm.whatsapp),
      linkedin: ageDays(wm.linkedin),
    },
    profileParsed,
    bridge: bridge ? bridge.status() : null,
  };
}

function todayHTML(all, dueToday, appTok, appIds) {
  const t = today();
  const NX = all.dismissedNotices || {};
  const NX_VERSION = String(all.update?.current || "");
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
  const digestNotice =
    d && d.delivered === false
      ? notice({
          // The reason is free text from the delivery layer; the key has to survive being written to
          // JSON and matched by NOTICE_KEY_OK, so it carries a slug of the reason, not the reason.
          key: `digest:undelivered:${String(d.reason || "none")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 40) || "none"}`,
          kind: "bad",
          title: "Your last digest was not delivered.",
          body: `${esc(d.reason || "reason not recorded")} — so it is reproduced below.`,
          summary: `Digest not delivered — ${d.reason || "reason not recorded"}`,
          dismissed: NX,
        })
      : "";
  // The digest body itself is not a notice: it is the content the failed delivery was carrying, and
  // it goes on being shown until the next digest replaces it.
  const digestBlock = digestNotice
    ? `${digestNotice}<div class="tblock"><pre class="digest">${esc(d.body)}</pre></div>`
    : "";

  // Reading messages can be blocked while the digest still sends — they are different capabilities
  // (AGENT-RULES §10). The blockers array carries the specific one-time fix, so it is shown verbatim
  // rather than paraphrased into "Chrome unavailable".
  const b = all.browser;
  // Suppressed when the run banner is already reporting `browser-read` — the two say the same thing,
  // and the run banner says it better because it names the run and when it happened.
  // `failed` carries gaps just as `partial` does: a run that died with Chrome unreadable listed the
  // same gap and got both banners, one under the other, saying it twice.
  const runCoversBrowser =
    (run?.state === "partial" || run?.state === "failed") && (run.gaps || []).includes("browser-read");
  const browserBanner =
    !runCoversBrowser && b && b.capabilities && !b.capabilities.read_page_content
      ? notice({
          // Keyed on the capability, not on the probe timestamp: the probe reruns constantly and a
          // notice that returns every few minutes has not been dismissed at all.
          key: "browser:cannot-read",
          title: "WhatsApp Web and LinkedIn messages cannot be READ.",
          body: `${b.whatsapp?.unread ? `<strong>${b.whatsapp.unread} unread</strong> waiting on WhatsApp Web. ` : ""}
           ${b.blockers?.length ? esc(b.blockers[0]) : "No mechanism available."}
           <span class="muted">Sending still works — the digest goes over the WhatsApp API, which needs no browser.</span>`,
          summary: `WhatsApp Web and LinkedIn cannot be read — ${b.blockers?.length ? String(b.blockers[0]).slice(0, 200) : "no mechanism available"}`,
          dismissed: NX,
        })
      : "";

  // What a run could not do, in the user's words rather than the slugs the machine passes around.
  // The blocker text underneath is reproduced verbatim (AGENT-RULES §10) — each one is written as
  // the exact one-time fix, and paraphrasing it leaves the reader with nothing to act on.
  const GAP_SAYS = {
    "browser-read":
      "WhatsApp Web and LinkedIn messages were not read, and no LinkedIn role search ran — Chrome could not be read.",
    "boards-queued": "Careers boards that need a browser were left unread for the same reason.",
    "digest-undelivered": "Your digest was written but never reached you.",
  };

  const runBanner = (() => {
    if (!run) return "";
    if (run.state === "failed") {
      // "scheduled" was asserted rather than read, so a run the user had just started by hand from
      // the wizard was reported as a scheduled one — which reads as somebody else's problem.
      const which = run.source === "manual" ? "run you started" : "scheduled run";
      // A failed run carries the same `gaps` a partial one does. Listing them is also what earns
      // the right to suppress the browser banner below: without this the specific one-time fix was
      // only in the notice being hidden.
      const gaps = Array.isArray(run.gaps) ? run.gaps : [];
      const blockers = run.coverage?.blockers ?? [];
      return notice({
        // Keyed on the run itself, so dismissing one failure never hides the next one.
        key: `run:failed:${run.started || run.finished || ""}`,
        kind: "bad",
        title: `The last ${which} failed.`,
        body: `${esc(run.detail || "")} <span class="muted">(started ${esc(run.started || "?")})</span>
           — check <code>data/.job-run.log</code>.
           ${gaps.length ? `<ul class="gaplist">${gaps.map((g) => `<li>${esc(GAP_SAYS[g] || g)}</li>`).join("")}</ul>` : ""}
           ${blockers.length ? `<div class="ti-sub">${esc(String(blockers[0]).slice(0, 400))}</div>` : ""}`,
        summary: `The last ${which} failed (started ${run.started || "?"}) — ${run.detail || "no detail recorded"}`,
        dismissed: NX,
      });
    }
    // A run that finished but could not do half the job used to render as an unqualified success:
    // no banner at all, because only `failed` was handled. That is the whole reason `partial`
    // exists, so it gets a banner of its own rather than sharing the red one.
    if (run.state === "partial") {
      const gaps = Array.isArray(run.gaps) ? run.gaps : [];
      const blockers = run.coverage?.blockers ?? [];
      return notice({
        key: `run:partial:${run.started || run.finished || ""}`,
        title: "The last run finished, but not all of it ran.",
        body: `<ul class="gaplist">${gaps.map((g) => `<li>${esc(GAP_SAYS[g] || g)}</li>`).join("")}</ul>
          ${blockers.length ? `<div class="ti-sub">${esc(String(blockers[0]).slice(0, 400))}</div>` : ""}
          <span class="muted">Started ${esc(String(run.started || "?").slice(0, 16).replace("T", " "))}.</span>`,
        summary: `Run of ${String(run.started || "?").slice(0, 16).replace("T", " ")} finished partly — ${gaps
          .map((g) => GAP_SAYS[g] || g)
          .join(" ")}`,
        dismissed: NX,
      });
    }
    return "";
  })();

  // The ladder speaks before it acts, and again after. Both states link to the one place the
  // schedule can be changed by hand.
  const ladderBanner = (() => {
    const l = all.ladder;
    if (!l) return "";
    const tier = Number(l.tier) || 1;
    const SCHEDULE = { 1: "every day", 2: "Mondays and Thursdays", 3: "Mondays only", 4: "not at all" };
    const NEXT = { 1: "Mondays and Thursdays", 2: "Mondays only", 3: "not at all" };
    // Keyed on the state the ladder is IN, plus the day it moved there — so a further step down
    // announces itself even though the previous one was dismissed.
    const stamp = String(l.warned_at || l.changed_at || l.armed_on || "");
    if (l.warned_at) {
      return notice({
        key: `ladder:warned:${tier}:${stamp}`,
        title: "JobSeeker is about to run less often.",
        body: `${esc(l.why || "")} On its next run it will drop from <b>${esc(SCHEDULE[tier])}</b> to
          <b>${esc(NEXT[tier] || "not at all")}</b>.
          <span class="muted">Review a few roles on the Jobs tab and it stays as it is</span> —
          or <a href="/settings?tab=setup">set the schedule yourself</a>.`,
        summary: `Schedule about to drop from ${SCHEDULE[tier]} to ${NEXT[tier] || "not at all"} — ${l.why || ""}`,
        dismissed: NX,
      });
    }
    if (tier >= 4) {
      return notice({
        key: `ladder:off:${stamp}`,
        kind: "bad",
        title: "The daily run is switched off.",
        body: `${esc(l.why || "")} Nothing is being read and nothing new will appear here until you turn it
          back on.
          <form method="POST" action="/restore-schedule" class="inline" style="margin-left:8px">
            <button type="submit" class="btn-small">Turn it back on</button></form>
          <a class="btn-small linkbtn" href="/settings?tab=setup">Choose a different schedule</a>`,
        summary: `Daily run switched off — ${l.why || "no reason recorded"}`,
        dismissed: NX,
      });
    }
    if (tier > 1) {
      return notice({
        key: `ladder:tier${tier}:${stamp}`,
        kind: "",
        title: `JobSeeker now runs ${esc(SCHEDULE[tier])}.`,
        body: `${esc(l.why || "")}
          <form method="POST" action="/restore-schedule" class="inline" style="margin-left:8px">
            <button type="submit" class="btn-small">Back to my usual schedule</button></form>
          <a class="btn-small linkbtn" href="/settings?tab=setup">Settings</a>`,
        summary: `Schedule stepped down to ${SCHEDULE[tier]} — ${l.why || ""}`,
        dismissed: NX,
      });
    }
    return "";
  })();

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

  // The approval loop, closed. This block used to be a read-only list: it told you a message was
  // waiting and gave you nowhere to say yes, so the decision happened in Claude Code or on WhatsApp
  // and the dashboard — the screen you actually live in — could not do the one thing the product
  // promises. data/approvals/appr_gwrlzf.md is what that cost: an approval nobody could act on
  // here sat pending for fifteen days while the message it gated had already gone out by hand.
  //
  // So: the full text is readable without leaving the page, the decision is two clicks, and
  // approving DISPATCHES the send (scripts/send-approval.sh) rather than leaving an approved
  // record for a future run to notice. Edit is not a separate state to manage — you edit and
  // approve in one move, because an edited draft you did not then approve helps nobody.
  const approvalItem = (a) => {
    const d = a.data;
    const kind = String(d.kind || "message");
    const isApply = kind === "apply";
    const days = d.created ? Math.max(0, Math.round((Date.now() - Date.parse(d.created)) / 86400000)) : null;
    const stale = days != null && days >= 3;
    const preview = String(a.body || "").trim();
    const hidden = `<input type="hidden" name="_tab" value="today"><input type="hidden" name="id" value="${esc(d.id)}">`;
    // An application approval cannot be "sent" — it is a form half-filled in a browser session that
    // /apply is holding open. Saying "Approve & send" on one would be a lie, so it says what it
    // does: it records your yes, and /apply does the submitting.
    const approveLabel = isApply ? "Approve" : "Approve &amp; send";
    return `<div class="titem">
      <span class="ti-co">${esc(kind)}</span>
      <span class="ti-tx">${esc(d.summary || d.title || d.id)}
        <div class="ti-sub">${esc(d.channels || "")}${d.channels ? " · " : ""}<code>${esc(d.id)}</code></div>
        ${days != null ? `<div class="ti-age${stale ? " stale" : ""}">waiting ${days === 0 ? "since today" : `${days} day${days === 1 ? "" : "s"}`}${stale ? " — it will read as late" : ""}</div>` : ""}
        ${preview ? `<details class="apprev"><summary>Show the full text</summary><pre class="digest">${esc(preview)}</pre></details>` : `<div class="ti-sub muted">No preview was recorded.</div>`}
        ${isApply ? `<div class="ti-sub muted">Approving records your decision. The submit itself happens in the <code>/apply</code> session that opened this.</div>` : ""}
      </span>
      <span class="ti-acts">
        <form method="POST" action="/decide-approval" class="inline">${hidden}
          <input type="hidden" name="decision" value="approve">
          <button type="submit">${approveLabel}</button></form>
        ${isApply ? "" : `<span class="popwrap">
          <button type="button" class="btn-small" aria-haspopup="dialog" aria-expanded="false"
            onclick="popToggle('edit_${esc(d.id)}', this)">Edit…</button>
          <div id="edit_${esc(d.id)}" class="pop pop-wide hide" role="dialog" aria-label="Edit and approve ${esc(d.summary || d.id)}">
            <form method="POST" action="/decide-approval">${hidden}
              <input type="hidden" name="decision" value="edit">
              <p class="pop-h">Edit, then send</p>
              <p class="pop-sub">Your wording replaces the draft. Keep the <code>channel:</code> and <code>to:</code> lines — they are how the sender knows where this goes.</p>
              <textarea name="text" rows="12" spellcheck="true">${esc(preview)}</textarea>
              <div class="pop-acts">
                <button type="button" class="btn-secondary" onclick="popClose('edit_${esc(d.id)}')">Cancel</button>
                <button type="submit">Save &amp; send</button>
              </div>
            </form>
          </div>
        </span>`}
        <span class="popwrap">
          <button type="button" class="dismbtn" aria-haspopup="dialog" aria-expanded="false"
            onclick="popToggle('rej_${esc(d.id)}', this)">Reject</button>
          <div id="rej_${esc(d.id)}" class="pop hide" role="dialog" aria-label="Reject ${esc(d.summary || d.id)}">
            <form method="POST" action="/decide-approval">${hidden}
              <input type="hidden" name="decision" value="reject">
              <p class="pop-h">Reject this</p>
              <p class="pop-sub">Nothing is sent. The record stays, so the agent that drafted it does not draft it again tomorrow.</p>
              <textarea name="note" rows="3" placeholder="Why? Optional." autocomplete="off"></textarea>
              <div class="pop-acts">
                <button type="button" class="btn-secondary" onclick="popClose('rej_${esc(d.id)}')">Cancel</button>
                <button type="submit">Reject</button>
              </div>
            </form>
          </div>
        </span>
      </span>
    </div>`;
  };

  const approvalsBlock = pendingApprovals.length
    ? `<div class="tblock">
        <p class="th">Approvals waiting <span class="muted">— nothing is sent until you approve it</span></p>
        ${pendingApprovals.map(approvalItem).join("")}
      </div>`
    : "";

  // What happened after you decided. Without this the loop still feels open: you press "Approve &
  // send", the row vanishes, and the page has told you nothing about whether the message left the
  // building. A send that failed is the case that matters, so it is not hidden behind a tab.
  const recentlyDecided = all.approvals
    .filter((a) => a.data.status && a.data.status !== "pending" && a.data.decided)
    .filter((a) => Date.now() - Date.parse(a.data.decided) < 7 * 86400000)
    .sort((x, y) => String(y.data.decided).localeCompare(String(x.data.decided)))
    .slice(0, 5);

  const DISPATCH_TEXT = {
    queued: ["warn", "queued to send"],
    running: ["warn", "sending now"],
    sent: ["ok", "sent"],
    failed: ["bad", "SEND FAILED — see data/.approvals.log"],
  };

  const decidedBlock = recentlyDecided.length
    ? `<div class="tblock">
        <p class="th">Recently decided <span class="muted">— the last 7 days</span></p>
        ${recentlyDecided
          .map((a) => {
            const d = a.data;
            const dis = DISPATCH_TEXT[String(d.dispatch || "")];
            const st = String(d.status);
            const stCls = st === "rejected" ? "bad-pill" : "ok-pill";
            return `<div class="titem">
              <span class="ti-co"><span class="${stCls}">${esc(st)}</span></span>
              <span class="ti-tx">${esc(d.summary || d.id)}
                <div class="ti-sub">${esc(String(d.decided).slice(0, 16).replace("T", " "))} · <code>${esc(d.id)}</code>
                  ${dis ? ` · <span class="${dis[0] === "ok" ? "ok-pill" : dis[0] === "bad" ? "bad-pill" : "warn-pill"}">${esc(dis[1])}</span>` : ""}</div>
              </span>
              <span class="ti-acts">${
                d.dispatch === "failed"
                  ? `<form method="POST" action="/decide-approval" class="inline">
                       <input type="hidden" name="_tab" value="today">
                       <input type="hidden" name="id" value="${esc(d.id)}">
                       <input type="hidden" name="decision" value="retry">
                       <button type="submit" class="btn-small">Try sending again</button></form>`
                  : ""
              }</span>
            </div>`;
          })
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

  // Run now.
  //
  // Until this existed, everything the product does was behind a terminal: `claude`, then a slash
  // command. The dashboard could set the 08:00 schedule but not run the thing it schedules — so on
  // any day you wanted an answer before tomorrow morning, the answer was "open a terminal".
  //
  const busy = all.runNow;

  // The one question setup deliberately did not ask. A market with an empty table has never been
  // researched, and until it is there is nothing for anything else to work with — so this is asked
  // where the answer has a visible consequence (this screen, empty) rather than in a wizard where
  // it is one more thing to click past.
  //
  // "Not now" is honoured but not forgotten: it becomes one amber line instead of a card. Hiding it
  // entirely would leave Today permanently empty with no explanation of why.
  const unresearched = (all.markets || []).filter((m) => !m.table.rows.length);
  const askable = unresearched.filter((m) => !(all.marketAskDismissed || []).includes(m.name));
  const deferred = unresearched.filter((m) => (all.marketAskDismissed || []).includes(m.name));
  const askMarket = askable[0];

  const marketAskBlock = askMarket
    ? `<div class="tblock askblock">
        <p class="th">One thing before you start</p>
        <p class="askh">Shall I research ${esc(askMarket.label)} now?</p>
        <p class="asksub">You picked it as a market, but nothing has been looked at yet. Researching it
          means finding the companies in it, ranking them against what you are after, and starting to
          watch their careers pages. Until that happens there is nothing to hunt through — this screen
          stays empty.</p>
        <div class="askacts">
          <form method="POST" action="/research-market" class="inline">
            <input type="hidden" name="_tab" value="today">
            <input type="hidden" name="market" value="${esc(askMarket.label)}">
            <button type="submit"${busyAttrs(busy)}>Yes — research it now</button></form>
          <form method="POST" action="/defer-market-ask" class="inline">
            <input type="hidden" name="_tab" value="today">
            <input type="hidden" name="market" value="${esc(askMarket.name)}">
            <button type="submit" class="btn-secondary">Not now</button></form>
        </div>
        <p class="tiny muted">A few minutes and about a dollar. Not now is fine: it happens on your
          first scheduled run, or whenever you press <b>Run now</b> below.</p>
      </div>`
    : deferred.length
      ? `<div class="alert warn"><strong>${esc(deferred.map((m) => m.label).join(", "))}
           ${deferred.length === 1 ? "has" : "have"} not been researched.</strong>
           Until then there are no companies to watch and no roles to find.
           <form method="POST" action="/research-market" class="inline">
             <input type="hidden" name="_tab" value="today">
             <input type="hidden" name="market" value="${esc(deferred[0].label)}">
             <button type="submit" class="btn-small"${busyAttrs(busy)}>Research ${esc(deferred[0].label)} now</button></form></div>`
      : "";

  // How the last update ended.
  //
  // The updater cannot report its own death, so a run that is neither finished nor recent is read
  // as having died — otherwise the page would sit on a phase like "swapping" for ever, which looks
  // like something is still happening when nothing is.
  const updateOutcome = (() => {
    const r = all.updateRun;
    if (!r || !r.phase || r.phase === "none" || r.seen) return "";
    const to = String(r.to || "");
    const done = ["done", "failed", "refused", "checked"].includes(r.phase);
    const ageMin = r.updatedAt ? (Date.now() - Date.parse(r.updatedAt)) / 60000 : 0;

    if (r.phase === "done" && to && to === NX_VERSION) {
      return notice({
        key: `update:done:${to}`,
        kind: "",
        title: `Updated to ${esc(to)}.`,
        body: `<a href="https://github.com/cventour/jobseeker/releases/tag/${esc(r.tag || "v" + to)}"
                 target="_blank" rel="noreferrer">See everything that changed</a>.`,
        summary: `Updated to ${to}`,
        dismissed: NX,
      });
    }
    if (r.phase === "failed") {
      return notice({
        key: `update:failed:${to}`,
        kind: "bad",
        title: `The update to ${esc(to)} did not finish.`,
        body: `JobSeeker is still running ${esc(r.from || NX_VERSION)} and nothing was lost.
          ${r.error ? `<div class="ti-sub">${esc(r.error)}</div>` : ""}
          ${r.rolledBack ? `<div class="ti-sub">What had already changed was put back.</div>` : ""}`,
        summary: `Update to ${to} failed — ${r.error || "no reason recorded"}`,
        dismissed: NX,
      });
    }
    if (!done && ageMin > 10) {
      return notice({
        key: `update:stalled:${to}`,
        kind: "warn",
        title: `An update was started but never reported back.`,
        body: `It stopped at "${esc(r.phase)}" and has said nothing since. JobSeeker is running
          ${esc(NX_VERSION)}, which is what it was running before.`,
        summary: `Update to ${to} stalled at ${r.phase}`,
        dismissed: NX,
      });
    }
    return "";
  })();

  // Chrome will not let a program reload an unpacked extension — measured, not assumed
  // (extension/README.md). So when an update changes the extension's code, the only honest thing is
  // to say so and give the two clicks. The pairing itself survives: the extension's id comes from
  // its folder path, which an update does not move.
  const extensionReload = (() => {
    const r = all.updateRun;
    if (!platform.IS_WIN || !r || r.phase !== "done" || !all.extVersion) return "";
    if (!r.extFrom || r.extFrom === all.extVersion) return "";
    return notice({
      key: `update:ext:${all.extVersion}`,
      kind: "warn",
      title: "The Chrome extension changed — reload it once.",
      body: `JobSeeker cannot do this for you; Chrome only lets a person load an unpacked extension.
        <ol class="gaplist"><li>Open <code>chrome://extensions</code></li>
        <li>Find <b>JobSeeker Bridge</b> and click the reload arrow</li></ol>
        <div class="ti-sub">Your pairing is not affected — it stays connected. This is version
        ${esc(all.extVersion)}; it was ${esc(r.extFrom)}.</div>`,
      summary: `Chrome extension updated to ${all.extVersion} — reload it at chrome://extensions`,
      dismissed: NX,
    });
  })();

  const boardsBlock = boardsNeeding
    ? notice({
        // The count is in the key: fix some, and the notice returns with the number that is left.
        key: `boards:needs-url:${boardsNeeding}`,
        title: `${boardsNeeding} careers boards have no readable URL.`,
        body: `Agents cannot fix these by trying harder — paste the real careers page and the next scout run
         will use it. <a href="/settings?tab=companies">Open in Settings →</a>`,
        summary: `${boardsNeeding} careers boards have no readable URL — paste the real careers page in Settings`,
        dismissed: NX,
      })
    : "";

  return `${ladderBanner}
    ${browserBanner}
    ${runBanner}
    ${digestBlock}
    ${queues.length ? `<div class="tsummary">${queues.join(" · ")}</div>` : ""}
    ${marketAskBlock}
    ${advancesBlock}
    ${approvalsBlock}
    ${decidedBlock}
    ${updateOutcome}
    ${extensionReload}
    ${boardsBlock}
    ${
      // Dismissing must not mean losing. One muted line, and the way back, for however many notices
      // are currently being hidden from this screen.
      (() => {
        const n = Object.keys(NX).length;
        if (!n) return "";
        // A <div>, not a <p>: a <form> start tag closes an open paragraph, which split this line
        // in two and left the full stop stranded on a line of its own.
        return `<div class="noticefoot muted">${n} notice${n === 1 ? "" : "s"} dismissed —
          <button type="button" class="linkish" onclick="var b=document.querySelector('.tab[data-tab=activity]'); if(b) b.click();">see them under Notifications in Activity</button>,
          or <form method="POST" action="/restore-notices" class="inline"><input type="hidden" name="_tab" value="today">
          <button type="submit" class="linkish">show them again</button></form>.</div>`;
      })()
    }
    <div class="tblock taskblock">
      <p class="th">Follow-ups <span class="muted">— due on or before today; switch to All for the rest</span></p>
      ${/* The Tasks tab was this same table with the same five columns, filtered differently — so it
           is now a chip here instead of a tab. "Due" stays the default: Today is meant to be the
           short list, and defaulting to 136 rows would make it another backlog to scroll past. */""}
      ${tasksSection(all.tasks.rows, appTok, appIds, dueToday)}
    </div>`;
}

// Date arithmetic without Date.now(): shift a YYYY-MM-DD string by n days.
function addDays(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function page(all, flash, forceUpdate = false) {
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

  // Eight tabs became five. What merged, and why:
  //   Applications + Leads -> Pipeline   one record type split by a single field; see pipelineHTML
  //   Contacts + Comms     -> People     179 comms rows are context ABOUT a person, not a destination
  //   Tasks                -> Today      identical columns; Today was already Tasks filtered to "due"
  // Jobs stays separate on purpose: triaging ~100 incoming suggestions is a different activity from
  // tracking the ~50 conversations already in flight, and it carries machinery the others do not
  // (NEW badges + mark-all-seen, repost flags, applied-here cross-refs, verified/volatile links).
  // Folding it in would produce one 150-row table that is worse at both jobs.
  const TABS = [
    { id: "today", label: "Today", count: todayCount || null },
    { id: "proposals", label: "Jobs", count: openProposals.length },
    { id: "pipeline", label: "Pipeline", count: applied.length + activeLeads.length },
    { id: "people", label: "People", count: all.contacts.rows.length },
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
    ${APPEARANCE_BTN}
    ${SETTINGS_BTN}
    ${FEEDBACK_BTN}
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
  ${
    // A run takes minutes to tens of minutes and reports nothing until it lands, so the one place
    // it must be visible is every place — not only the tab you happened to start it from.
    all.runNow ? runBadge(all.runNow) : ""
  }
</div>
${tabStrip(TABS, active, addTaskMenu() + runNowMenu({ tab: active, busy: all.runNow, lastNow: all.lastRunNow }))}
</div>
<div id="panels">
${tabPanel("today", on("today"), sec("today", "", todayHTML(all, dueToday, appTok, appIds)))}
${tabPanel("proposals", on("proposals"), sec("proposals", `Jobs <span class="muted">— curated openings to review (× to dismiss · filter by status)</span>`, proposalsSection(all.proposals, appliedByCompany, reposts, all.orphans, all.runNow), runNowButton({ slug: "curate", tab: "proposals", busy: all.runNow })))}
${tabPanel("pipeline", on("pipeline"), sec("pipeline", `Pipeline <span class="muted">— everything you have acted on, from CV sent to offer</span>`, statusBoardHTML(applied) + pipelineSection(all.applications), runNowButton({ slug: "followup", tab: "pipeline", busy: all.runNow })))}
${tabPanel("people", on("people"), sec("people", `People <span class="muted">— who you are talking to, and every message logged with them</span>`, peopleHTML(all), runNowButton({ slug: "track", tab: "people", busy: all.runNow })))}
${tabPanel("activity", on("activity"), sec("activity", `Activity <span class="muted">— append-only audit log (filter by kind · search · run boundaries highlighted)</span>`, activitySection(all.activity)))}
</div>

<footer class="muted">Local Markdown is the source of truth (<code>data/</code>). Agent actions run as Claude Code slash commands. Configuration lives in <a href="/settings">Settings</a>. <button type="button" class="tour-replay" onclick="window.__tourReplay&&window.__tourReplay()">Show me around again</button></footer>

<div id="overlay" class="overlay" onclick="if(event.target===this)closeDetail()">
  <div class="modal"><button class="mclose" onclick="closeDetail()" aria-label="Close">×</button><div id="mbody"></div></div>
</div>
<div id="dismissOverlay" class="overlay" onclick="if(event.target===this)closeDismiss()">
  <div class="modal" style="max-width:460px">
    <button class="mclose" onclick="closeDismiss()" aria-label="Close">×</button>
    <h3>Dismiss lead</h3>
    <p class="muted" id="dismissWhat" style="margin:0 0 10px"></p>
    <div id="dismissImpact" class="impact" hidden></div>
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
<div id="confirmOverlay" class="overlay" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
  <div class="modal confirm-modal">
    <h3 id="confirmTitle"></h3>
    <div id="confirmBody" class="confirm-body"></div>
    <div class="actions confirm-acts">
      <button type="button" class="btn-secondary" id="confirmCancel">Cancel</button>
      <button type="button" id="confirmOk"></button>
    </div>
  </div>
</div>
${updateModal(all.update)}
${updateSignal(all, forceUpdate)}
<script>window.__DETAILS__=${detailsJSON};</script>
${
  // Escaped the same way __DETAILS__ is: a literal "</script>" inside the JSON would end the block
  // early and leave the rest of it as page text.
  all.hint
    ? `<script>window.__tourHint=${JSON.stringify(all.hint).replace(/</g, "\\u003c")};</script>`
    : ""
}
${FEEDBACK_MODAL}
<script>${TOUR_JS}</script>
<script>${JS}${FEEDBACK_JS}</script>
</body></html>`;
}

// ---------- Settings ----------
// Configuration only: things set once and changed rarely. Split out so the daily page holds nothing
// but what actually changes daily. Same tab mechanics, its own small set of panes.
function settingsPage(all, flash, forceUpdate = false) {
  // One tab, not two. "Markets & vendors" and "Careers boards" described the same entity from two
  // angles and overlapped on 183 companies — see joinCompanies().
  const companies = joinCompanies(all);
  const companyCount = companies.length;
  // Only rows a person can actually fix, using the SAME classification the page renders. The old
  // count folded in `browser` and `blocked`, which the board sweep now works on its own — so the
  // banner demanded attention for 45 boards nobody needed to touch.
  const needing = companies.filter((e) => companyState(e) === "needs-url").length;
  const TABS = [
    // No separate "Criteria & weights" tab: its fields (markets, roles, locations, seniority and
    // the three weights) were an exact subset of Setup's, so it was the same form rendered twice —
    // two places to change one value, and two places for them to disagree. Setup is the single home;
    // the weights moved into Setup > Advanced.
    { id: "setup", label: "Setup", count: null },
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
  <div class="head-actions">${APPEARANCE_BTN}<a class="gearlink" href="/">← Back to work</a>${FEEDBACK_BTN}</div>
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
${tabPanel("setup", on("setup"), sec("setup", `Setup`, unfinishedHTML(all.welcome, all.markets) + setupHTML(all.status, all.criteria, (all.markets ?? []).map((m) => m.label), all.sub, all.update)))}
${tabPanel("companies", on("companies"), sec("companies", `Companies <span class="muted">— who you are targeting and where their jobs are read from (🔎 to find a board, ✏️ to paste one)</span>`, companiesHTML(all)))}
${tabPanel("cv", on("cv"), sec("cv", `CV <span class="muted">— parsed into data/profile.md by /parse-cv</span>`, profileHTML(all.profile)))}
</div>
<footer class="muted">Local Markdown is the source of truth (<code>data/</code>). <a href="/">Back to work →</a>${
  platform.IS_WIN
    ? ` <form method="POST" action="/quit" class="inline" style="display:inline"><button type="submit" class="quitbtn">Quit JobSeeker</button></form>`
    : ""
}${
  // Which version this is, on every visit to Settings. The Setup tab already says so, but only
  // once the background update check has answered -- and "which version am I on" is the first
  // question of every bug report, so it cannot be conditional on GitHub being reachable.
  all.version
    ? `<span class="ver">JobSeeker ${esc(all.version)}
        <form method="POST" action="/check-update" class="inline">
          <input type="hidden" name="_page" value="settings"><input type="hidden" name="_tab" value="setup">
          <button type="submit" class="verbtn" title="Ask GitHub whether there is a newer release">Check for updates</button>
        </form></span>`
    : ""
}</footer>
<div id="confirmOverlay" class="overlay" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
  <div class="modal confirm-modal">
    <h3 id="confirmTitle"></h3>
    <div id="confirmBody" class="confirm-body"></div>
    <div class="actions confirm-acts">
      <button type="button" class="btn-secondary" id="confirmCancel">Cancel</button>
      <button type="button" id="confirmOk"></button>
    </div>
  </div>
</div>
${updateModal(all.update, "settings")}
${updateSignal(all, forceUpdate)}
${FEEDBACK_MODAL}
<script>${JS}${FEEDBACK_JS}</script>
</body></html>`;
}

const CSS = `
:root{--bg:#0f1220;--card:#181c2f;--line:#2a2f48;--fg:#e7e9f3;--mut:#9aa0bd;--acc:#6ea8fe;}
/* Appearance, three states. The base :root above is dark, so the ONLY thing that needs saying
   twice is light. No data-theme attribute means Auto: the media query alone decides, so the page
   really does follow the OS instead of guessing once at load. An explicit choice writes the
   attribute and must beat the OS in both directions -- the :not() guard is what stops a light Mac
   overriding someone who asked for dark, and the attribute rule after it is what lets a light
   choice win on a dark Mac. color-scheme rides along so scrollbars and form controls follow too. */
:root{color-scheme:dark;}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f7f5f0;--card:#fffdf9;--line:#e8e3d9;--fg:#1f1c17;--mut:#6b6355;--acc:#2f5fd0;color-scheme:light;}}
:root[data-theme="light"]{--bg:#f7f5f0;--card:#fffdf9;--line:#e8e3d9;--fg:#1f1c17;--mut:#6b6355;--acc:#2f5fd0;color-scheme:light;}
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
/* The version sits at the far end of the footer: findable when someone is asked for it, quiet
   enough that nobody reading the footer for anything else has to step over it. */
body>footer .ver{float:right;opacity:.62;font-variant-numeric:tabular-nums;
  display:inline-flex;align-items:baseline;gap:8px}
body>footer .ver form{display:inline}
/* A link, not a button. Checking for updates is a thing you may do idly and costs nothing, so it
   should not carry the weight of the buttons that spend money or change the install. */
body>footer .verbtn{background:transparent;border:0;padding:0;font:inherit;color:var(--acc);
  cursor:pointer;text-decoration:underline;text-underline-offset:2px}
body>footer .verbtn:hover{opacity:.8}
@media (max-width:640px){body>footer .ver{float:none;display:flex;margin-top:6px}}
/* Sticky toolbar: the tab strip stays reachable while a long table scrolls. */
.topbar{position:sticky;top:0;z-index:6;background:var(--bg);border-bottom:1px solid var(--line);
  box-shadow:0 1px 0 var(--line)}
.topbar>.statbar{padding-top:12px;padding-bottom:10px}
/* ---- tab shell ---- */
.gearlink{display:inline-block;padding:6px 12px;border:1px solid var(--line);border-radius:8px;
  color:var(--acc);text-decoration:none;font-size:13px;white-space:nowrap}
.gearlink:hover{background:var(--line)}
/* Same shell as .gearlink -- 8px radius, 1px --line border, 13px accent -- so the two sit as a
   pair. The 1.5 line-height is what makes the heights match without hard-coding a pixel value. */
.moonbtn{display:inline-block;padding:6px 9px;border:1px solid var(--line);border-radius:8px;
  color:var(--acc);background:none;cursor:pointer;font:inherit;font-size:13px;line-height:1.5}
.moonbtn:hover{background:var(--line)}
.moonbtn svg{display:block}
.moonbtn:focus-visible{outline:2px solid var(--acc);outline-offset:2px}

/* ---- First-run tour ---------------------------------------------------------------------------
   Coach marks: a dimmed page, the element being described left bright, and a bubble with a pointer
   aimed at it. Shown once, on the first open of the dashboard, and replayable from the footer --
   a tour you cannot get back is one people click past and then wish they had not. */
.tour-veil{position:fixed;inset:0;z-index:60;background:rgba(8,10,20,.55);
  opacity:0;transition:opacity .18s ease;pointer-events:auto}
.tour-veil.on{opacity:1}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]) .tour-veil{background:rgba(31,28,23,.38)}}
:root[data-theme="light"] .tour-veil{background:rgba(31,28,23,.38)}

/* The spotlight is a ring drawn around the target rather than a hole punched through the veil:
   one element, no clip-path, and it survives the target moving or resizing. */
.tour-spot{position:fixed;z-index:61;border-radius:12px;pointer-events:none;
  box-shadow:0 0 0 4px var(--acc),0 0 0 9999px rgba(8,10,20,.55);
  transition:top .2s ease,left .2s ease,width .2s ease,height .2s ease}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]) .tour-spot{box-shadow:0 0 0 4px var(--acc),0 0 0 9999px rgba(31,28,23,.38)}}
:root[data-theme="light"] .tour-spot{box-shadow:0 0 0 4px var(--acc),0 0 0 9999px rgba(31,28,23,.38)}

.tour-bub{position:fixed;z-index:62;max-width:330px;background:var(--card);color:var(--fg);
  border:1px solid var(--line);border-radius:12px;padding:15px 17px 13px;
  box-shadow:0 18px 44px -16px rgba(0,0,0,.55);transition:top .2s ease,left .2s ease}
.tour-bub h4{margin:0 0 5px;font-size:14px;font-weight:650;letter-spacing:-.01em}
.tour-bub p{margin:0 0 12px;font-size:13px;line-height:1.55;color:var(--mut)}
.tour-bub footer{display:flex;align-items:center;justify-content:space-between;gap:12px;
  border:0;padding:0;margin:0}
.tour-step{font:500 11.5px/1 ui-monospace,Menlo,monospace;color:var(--mut)}
.tour-acts{display:flex;gap:7px}
.tour-bub button{appearance:none;border:1px solid var(--line);background:var(--bg);color:var(--fg);
  font:inherit;font-size:12.5px;font-weight:550;padding:6px 13px;border-radius:7px;cursor:pointer}
.tour-bub button.go{background:var(--acc);border-color:var(--acc);color:var(--bg)}
.tour-bub button:hover{filter:brightness(1.08)}
/* The pointed edge. A rotated square behind the bubble, so it inherits border and background. */
.tour-bub i{position:absolute;width:12px;height:12px;background:var(--card);
  border:1px solid var(--line);transform:rotate(45deg)}
.tour-bub.below i{top:-7px;border-right:0;border-bottom:0}
.tour-bub.above i{bottom:-7px;border-left:0;border-top:0}
.tour-replay{background:none;border:0;padding:0;font:inherit;color:var(--acc);cursor:pointer;
  text-decoration:underline}
@media (prefers-reduced-motion:reduce){.tour-veil,.tour-spot,.tour-bub{transition:none}}

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
/* Chroma pulled back a little against the warmer ground: the same pill saturation that
   reads as crisp on cool grey reads as garish on cream. */
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]){
    --tbg-l:0.955; --tbg-c:0.035; --tfg-l:0.440; --tfg-c:0.110;
    --ton-bg-l:0.870; --ton-bg-c:0.080; --ton-fg-l:0.310; --ton-fg-c:0.060;
    --tring-l:0.550; --tring-c:0.130;
  }
}
:root[data-theme="light"]{
    --tbg-l:0.955; --tbg-c:0.035; --tfg-l:0.440; --tfg-c:0.110;
    --ton-bg-l:0.870; --ton-bg-c:0.080; --ton-fg-l:0.310; --ton-fg-c:0.060;
    --tring-l:0.550; --tring-c:0.130;
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
nav.tabs .tab[data-tab="proposals"]{--h:187}      /* teal */
nav.tabs .tab[data-tab="pipeline"]{--h:152}       /* green, echoing the interview status pill */
nav.tabs .tab[data-tab="people"]{--h:30}          /* orange */
nav.tabs .tab[data-tab="activity"]{--h:228;--tab-c:.3}  /* muted on purpose: it is a log */
/* Settings tabs reuse the same hues so the two pages read as one system. */
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
/* Chip fields. The box looks and focuses like one input; the chips live inside it. */
.chipgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px 18px}
/* The label is one line in every column and the hint sits UNDER the field, so the boxes line up
   across the row. With the hint inside the label, one longer note pushed its own column's input
   down and nothing else's -- which read as a misaligned box rather than as a longer label. */
.chipfield{display:flex;flex-direction:column;gap:5px;min-width:0}
.chiplabel{font-size:12.5px;color:var(--mut)}
.chiphint{font-size:11px;line-height:1.45;margin:1px 0 0}
.chipbox{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;min-height:38px;
  border:1px solid var(--line);border-radius:8px;background:var(--bg);cursor:text}
.chipbox:focus-within{border-color:var(--acc)}
.chip{display:inline-flex;align-items:center;gap:5px;background:var(--card);border:1px solid var(--line);
  border-radius:99px;padding:3px 4px 3px 10px;font-size:12.5px;max-width:100%;overflow-wrap:anywhere}
.chipx{background:none;border:0;color:var(--mut);cursor:pointer;font-size:15px;line-height:1;
  padding:0 5px;border-radius:99px}
.chipx:hover{color:var(--fg);background:var(--line);filter:none}
.chipin{flex:1;min-width:120px;border:0;background:transparent;color:var(--fg);font:inherit;
  padding:3px 2px;outline:none}

/* Blast radius of a dismissal, shown before you confirm it. */
.impact{background:rgba(214,138,0,.10);border-left:3px solid #d68a00;border-radius:0 8px 8px 0;
  padding:9px 12px;margin:0 0 12px;font-size:12.5px;line-height:1.5}

/* Overdue age. A date does not read as urgent; "21d overdue" does. */
.odue{font-size:11px;color:#d68a00;font-weight:650;margin-top:2px;white-space:nowrap}
.odue-stale{color:#f85149}
.stalebar{margin:10px 0 12px}

/* Pipeline: lead vs application stays visible at a glance — it is the distinction the whole
   tracker is built to protect, so it must not read as a minor detail. */
.kindtag{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:650;letter-spacing:.02em}
.k-lead{background:rgba(110,168,254,.16);color:#6ea8fe}
.k-app{background:rgba(46,160,67,.18);color:#3fb950}
.chipsep{display:inline-block;width:1px;height:18px;background:var(--line);margin:0 4px;vertical-align:middle}

/* People: one card per contact, their messages folded inside. */
details.person{border:1px solid var(--line);border-radius:9px;margin:0 0 8px;background:var(--card)}
details.person > summary{cursor:pointer;padding:11px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
details.person[open] > summary{border-bottom:1px solid var(--line)}
.pname{font-weight:650}
.pmeta{font-size:12px}
.pcount{font-size:12px;margin-left:auto}
.plast{font-size:11.5px}
.pbody{padding:12px 14px}
.pcontact{font-size:12px;margin:0 0 10px}
details.orphans{border-style:dashed}

/* Setup page */
.cfgform{margin:0 0 26px}
.cfggrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px 18px;margin:0 0 18px}
.cfggrid label{display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:var(--mut)}
.cfggrid input{padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);font:inherit}

/* Toggle switches. The real checkbox stays in the DOM and keeps working for keyboard and
   screen readers — it is moved offscreen rather than display:none, which would drop it from the
   tab order and from form submission. The track/thumb are painted from its :checked state. */
.tglgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px 18px;margin:0 0 18px}
.tgl{display:flex;align-items:flex-start;gap:11px;cursor:pointer;font-size:13px}
.tgl input[type=checkbox]{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.tgl-track{flex:0 0 auto;width:38px;height:22px;border-radius:99px;background:var(--line);
  position:relative;transition:background .15s ease;margin-top:1px}
.tgl-thumb{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;
  background:var(--fg);opacity:.55;transition:transform .15s ease,opacity .15s ease}
.tgl input:checked + .tgl-track{background:var(--acc)}
.tgl input:checked + .tgl-track .tgl-thumb{transform:translateX(16px);background:#fff;opacity:1}
.tgl input:focus-visible + .tgl-track{outline:2px solid var(--acc);outline-offset:2px}
.tgl-text{display:flex;flex-direction:column;gap:2px;line-height:1.35}
.tgl-hint{font-size:11.5px}

/* Setup's sub-panes. Deliberately quieter than the tab strip above: one hue-coded pill row per
   page is a navigation system, two is a competition. These are flat slate, smaller, and sit on a
   rule that ties them to the pane below. */
.subtabs{display:flex;gap:6px;padding:0 0 10px;border-bottom:1px solid var(--line);overflow-x:auto;
  scrollbar-width:none}
.subtabs::-webkit-scrollbar{display:none}
.subpill{appearance:none;border:0;border-radius:999px;font:inherit;font-size:12.5px;font-weight:550;
  padding:6px 13px;cursor:pointer;white-space:nowrap;background:#1b1f33;color:#b6bcd6;
  transition:background .14s ease,color .14s ease,box-shadow .14s ease}
.subpill:hover{box-shadow:inset 0 0 0 1px #3d4468}
.subpill:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.subpill.on{background:#2f3757;color:#f2f4ff;font-weight:700;box-shadow:inset 0 0 0 1px #5a67a0}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]) .subpill{background:#f0ece3;color:#6b6355}
  :root:not([data-theme="dark"]) .subpill:hover{box-shadow:inset 0 0 0 1px #ddd6c8}
  :root:not([data-theme="dark"]) .subpill.on{background:#e4ddcf;color:#1f1c17;box-shadow:inset 0 0 0 1px #c3b9a4}
}
:root[data-theme="light"] .subpill{background:#f0ece3;color:#6b6355}
:root[data-theme="light"] .subpill:hover{box-shadow:inset 0 0 0 1px #ddd6c8}
:root[data-theme="light"] .subpill.on{background:#e4ddcf;color:#1f1c17;box-shadow:inset 0 0 0 1px #c3b9a4}
.subblurb{font-size:12.5px;margin:10px 0 18px}
.subpane[hidden]{display:none}
.paneacts{margin-top:22px}
.panenote{font-size:12.5px;max-width:640px;line-height:1.55;margin:10px 0 0}
.panerule{height:1px;background:var(--line);margin:22px 0;max-width:900px}
.spendcard{margin-top:22px;max-width:640px;background:var(--card);border:1px solid var(--line);
  border-radius:12px;padding:16px 18px}
.spendrow{display:flex;align-items:baseline;justify-content:space-between;gap:16px}
.spendnum{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
.tiny{font-size:12px}

/* Advanced — collapsed by default; these are real controls, just not first-run ones. */
details.adv{margin:4px 0 18px;border-top:1px solid var(--line);padding-top:12px}
details.adv > summary{cursor:pointer;font-size:12.5px;font-weight:650;color:var(--mut);
  letter-spacing:.04em;text-transform:uppercase;padding:4px 0}
details.adv[open] > summary{margin-bottom:10px;color:var(--fg)}

/* Weight sliders — shown as share-of-total, because only the ratio between them means anything. */
.wgrid{display:flex;flex-direction:column;gap:10px;max-width:520px;margin:0 0 12px}
.wrow{display:grid;grid-template-columns:110px 1fr 48px;align-items:center;gap:12px;font-size:13px}
.wname{color:var(--mut)}
.wslider{width:100%;accent-color:var(--acc)}
.wpct{text-align:right;font-variant-numeric:tabular-nums;color:var(--fg);font-size:12.5px}
.noticebox{display:flex;align-items:flex-start;gap:10px}
.noticebox .notice-body{flex:1;min-width:0}
.noticebox .notice-x{margin:-2px -4px 0 0;flex:0 0 auto}
.noticebox .notice-x .xbtn{font-size:17px;line-height:1;padding:2px 7px;opacity:.55}
.noticebox .notice-x .xbtn:hover{opacity:1}
.noticefoot{font-size:11.5px;margin:2px 0 0}
.noticefoot form.inline{display:inline;margin:0}
.linkish{background:none;border:0;padding:0;font:inherit;color:var(--acc);cursor:pointer;
  text-decoration:underline;text-underline-offset:2px}
.ok-pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;background:rgba(46,160,67,.16);color:#3fb950}
.bad-pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;background:rgba(214,138,0,.16);color:#d68a00}
/* A send that is on its way is neither good news nor bad — it is unfinished, and reads as amber. */
.warn-pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;background:rgba(214,138,0,.16);color:#d68a00}
/* What a partial run could not do. A list, because a run can miss more than one thing at once and
   a comma-joined sentence hides the second one. */
.gaplist{margin:8px 0 6px;padding-left:20px}
.gaplist li{margin-bottom:4px}
/* The message itself, collapsed by default: Today is a list of decisions, and five open drafts
   would bury the other four things that need you. One click reveals the exact text that will go. */
.askblock{border:1px solid var(--acc);border-radius:12px;padding:14px 16px;background:var(--card)}
.askh{font-size:16px;font-weight:700;margin:2px 0 6px;letter-spacing:-.01em}
.asksub{color:var(--mut);font-size:13px;margin:0 0 12px;max-width:64ch;line-height:1.6}
.askacts{display:flex;gap:9px;flex-wrap:wrap;margin-bottom:9px}
/* "Why did nothing happen?" — the answer, on the button that did nothing. */
[data-busy]{opacity:.45;cursor:not-allowed}
.busybub{position:fixed;z-index:70;width:min(300px,calc(100vw - 24px));
  background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 13px;
  box-shadow:0 14px 34px rgba(0,0,0,.34)}
.busybub p{margin:0;font-size:12.5px;line-height:1.5;color:var(--fg)}
.busybub i{position:absolute;width:11px;height:11px;background:var(--card);border:1px solid var(--line);
  transform:rotate(45deg)}
.busybub.below i{top:-6px;border-right:0;border-bottom:0}
.busybub.above i{bottom:-6px;border-left:0;border-top:0}

/* Fill form — on the row, next to the link it opens. Quiet until hovered: it is one action among
   many on a long table, not the headline. */
.linkcell{white-space:nowrap}
.applyform{display:inline-block;margin:0 8px 0 0}
.prowact button.applybtn{font:inherit;font-size:11.5px;font-weight:650;padding:3px 10px;
  border-radius:99px;border:1px solid var(--line);background:var(--card);color:var(--mut);
  cursor:pointer;white-space:nowrap;line-height:1.5}
.prowact button.applybtn:hover:not([disabled]){background:var(--card);border-color:var(--acc);color:var(--acc)}
.prowact button.applybtn[disabled]{opacity:.4;cursor:not-allowed}

.runctl{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:0}
.runctl form.inline{display:flex;align-items:center;gap:8px;margin:0}
.runctl button[disabled]{opacity:.45;cursor:not-allowed}
.runctl.compact .runbadge{font-size:11.5px}
/* Run now lives in the tab bar, hard right, so it is on every tab and never in the content. */
/* Sticky to the right edge INSIDE the scrolling tab strip: on a narrow screen the tabs scroll
   horizontally, and a plain margin-left:auto would carry Run now off the side of the screen. */
.tabs-end{margin-left:auto;position:sticky;right:0;display:flex;align-items:center;gap:8px;
  padding-left:14px;background:var(--bg);box-shadow:-10px 0 10px -6px var(--bg)}
.runmenu-btn{font:inherit;font-size:12.5px;font-weight:650;padding:7px 14px;border-radius:99px;
  border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;
  display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.runmenu-btn:hover{border-color:var(--acc);color:var(--acc)}
.runmenu-btn[aria-expanded=true]{border-color:var(--acc);color:var(--acc)}
.runmenu-btn .caret{font-size:10px;opacity:.7}
.pop-run{width:min(360px,calc(100vw - 32px))}
.runmenu-busy{display:flex;flex-direction:column;gap:5px;margin:0 0 10px;padding:9px 10px;
  border-radius:8px;background:rgba(214,138,0,.10)}
.runmenu-busy .muted{font-size:11px;line-height:1.45}
.runmenu-list{display:flex;flex-direction:column;gap:5px}
.runmenu-list form{margin:0}
.runmenu-item{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;
  text-align:left;font:inherit;padding:8px 10px;border-radius:8px;border:1px solid transparent;
  background:transparent;color:var(--fg);cursor:pointer}
.runmenu-item:hover:not([disabled]){background:rgba(110,168,254,.12);border-color:var(--acc)}
.runmenu-item[disabled]{opacity:.4;cursor:not-allowed}
.rmi-label{font-size:13px;font-weight:650}
.rmi-sub{font-size:11px;color:var(--mut);line-height:1.4}
.runmenu-last{margin:10px 0 0;padding-top:9px;border-top:1px solid var(--line);font-size:11px;color:var(--mut)}
/* Add task — the one button in the bar that CREATES something, so it is filled rather than
   outlined and reads as the primary act next to Run now's outline. */
.addtask-btn{background:var(--acc);border-color:var(--acc);color:var(--bg);font-weight:700;gap:5px}
.addtask-btn:hover{filter:brightness(1.08);border-color:var(--acc);color:var(--bg)}
.addtask-btn[aria-expanded=true]{filter:brightness(1.08);border-color:var(--acc);color:var(--bg)}
.addtask-btn .atplus{font-size:15px;line-height:1;font-weight:700;margin-top:-1px}
/* One running job, said identically in the stat bar, on Today, and beside every per-tab trigger. */
.runbadge{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:99px;
  font-size:12px;font-weight:600;background:rgba(214,138,0,.16);color:#d68a00;white-space:nowrap}
.runbadge .rdot{width:7px;height:7px;border-radius:50%;background:currentColor;
  animation:rpulse 1.6s ease-in-out infinite}
@keyframes rpulse{0%,100%{opacity:1}50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.runbadge .rdot{animation:none}}
.sechead .runctl{flex:0 0 auto}
.apprev{margin-top:6px}
.apprev summary{cursor:pointer;font-size:12px;color:var(--mut);width:max-content}
.apprev summary:hover{color:var(--fg)}
.apprev pre.digest{margin-top:6px;max-height:320px;overflow:auto}
/* Editing a message needs room to see it. The narrow popover is right for a one-line reason and
   wrong for the paragraph you are about to send under your own name. */
.pop.pop-wide{width:min(560px,calc(100vw - 48px))}
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
.pop-addtask{width:min(560px,calc(100vw - 32px))}
/* Opt in to the measured arrow: at 560px wide this panel is centred and then pushed off the
   viewport edge, so the inherited right:18px arrow would point at empty tab strip. */
.pop-addtask::before{right:auto;left:var(--arrowx,50%)}
.pop-addtask form{margin:0}
.pop-addtask input[name=nl]{width:100%;font-size:13.5px;padding:10px 12px}
.pop-addtask input[name=nl]:focus{outline:2px solid var(--acc);outline-offset:-1px;border-color:transparent}
/* What the parser made of it, said before you commit rather than after. Hidden while the field is
   empty: three chips reading "no date · followup · not named" over an empty box is noise. */
.parsed{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin:11px 0 0}
.pchip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:4px 10px;border-radius:999px;
  background:rgba(110,168,254,.12);border:1px solid rgba(110,168,254,.35);color:var(--acc)}
/* A column the text did not fill is stated, not hidden — "not named" is information; a missing chip
   would just look like the preview had not caught up. */
.pchip.pnone{background:transparent;border-color:var(--line);color:var(--mut)}
.pchip .pk{color:var(--mut);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase}
.parsenote{margin:9px 0 0;font-size:11.5px;color:var(--mut);line-height:1.45}
.pop-addtask .pop-acts{margin-top:13px;padding-top:12px;border-top:1px solid var(--line)}
.pop-addtask .esc{margin-right:auto;font-size:11.5px;color:var(--mut);display:inline-flex;align-items:center;gap:5px}
.pop-addtask kbd{font:500 11px/1 ui-monospace,Menlo,monospace;color:var(--mut);border:1px solid var(--line);
  border-radius:5px;padding:3px 5px;background:var(--bg)}
.alert{padding:11px 14px;border-radius:9px;margin:0 0 18px;font-size:13px;line-height:1.5}
.alert.warn{background:rgba(214,138,0,.10);box-shadow:inset 3px 0 0 #d68a00}
/* Chrome-extension pairing (Windows): the folder to load and the code to type, both meant to be read
   across the room or copied in one select. */
.bridge-pair ol{margin:6px 0 0;padding-left:20px}
.bridge-pair li+li{margin-top:8px}
.bridge-shot{margin:10px 0 0}
.bridge-shot img{display:block;width:100%;max-width:560px;height:auto;border:1px solid var(--line);border-radius:8px}
.bridge-shot figcaption{margin-top:6px;font-size:12px;color:var(--muted)}
.bridge-path{display:inline-block;margin-top:4px;padding:3px 7px;user-select:all;-webkit-user-select:all;word-break:break-all}
.bridge-code{font:700 30px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.18em;margin:6px 0 2px;user-select:all;-webkit-user-select:all}
.quitbtn{background:transparent;border:0;padding:0;color:var(--mut);font:inherit;cursor:pointer;text-decoration:underline}
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
/* Light mode. Every pill above is a dark fill with no text colour of its own, which is correct
   against dark-mode ink and unreadable against light-mode ink — near-black text on a near-black
   pill. The status pills solved this with per-state --s-*-bg/fg pairs; these never got the same
   treatment, so they get it here: a tinted fill and a dark ink, in the same families as the fills
   they replace, so a green pill stays green. */
:root[data-theme="light"] .st-readable,
:root[data-theme="light"] .b-json{background:#d3f0e2;color:#10503a}
:root[data-theme="light"] .st-queued,
:root[data-theme="light"] .b-browser{background:#f7e6c4;color:#6b4708}
:root[data-theme="light"] .st-needs-url,
:root[data-theme="light"] .b-blocked{background:#fbdadf;color:#7a1b2a}
:root[data-theme="light"] .st-manual,
:root[data-theme="light"] .b-manual{background:#e6dffa;color:#402a78}
:root[data-theme="light"] .st-pending,
:root[data-theme="light"] .b-html{background:#dbe6fb;color:#1d3a72}
:root[data-theme="light"] .st-unknown{background:#e2e5f0;color:#4a5068}
:root[data-theme="light"] .b-none{background:#fadfe3;color:#6e2430}
:root[data-theme="light"] .b-volatile{background:#f5e6d2;color:#5c4020}
:root[data-theme="light"] .tier{background:#dbe6fb;color:#1d3a72}
:root[data-theme="light"] .tier-1{background:#d6f0d6;color:#14561f}
:root[data-theme="light"] .tier-2{background:#dbe6fb;color:#1d3a72}
:root[data-theme="light"] .tier-3{background:#e2e5f0;color:#4a5068}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]) .st-readable,
  :root:not([data-theme="dark"]) .b-json{background:#d3f0e2;color:#10503a}
  :root:not([data-theme="dark"]) .st-queued,
  :root:not([data-theme="dark"]) .b-browser{background:#f7e6c4;color:#6b4708}
  :root:not([data-theme="dark"]) .st-needs-url,
  :root:not([data-theme="dark"]) .b-blocked{background:#fbdadf;color:#7a1b2a}
  :root:not([data-theme="dark"]) .st-manual,
  :root:not([data-theme="dark"]) .b-manual{background:#e6dffa;color:#402a78}
  :root:not([data-theme="dark"]) .st-pending,
  :root:not([data-theme="dark"]) .b-html{background:#dbe6fb;color:#1d3a72}
  :root:not([data-theme="dark"]) .st-unknown{background:#e2e5f0;color:#4a5068}
  :root:not([data-theme="dark"]) .b-none{background:#fadfe3;color:#6e2430}
  :root:not([data-theme="dark"]) .b-volatile{background:#f5e6d2;color:#5c4020}
  :root:not([data-theme="dark"]) .tier{background:#dbe6fb;color:#1d3a72}
  :root:not([data-theme="dark"]) .tier-1{background:#d6f0d6;color:#14561f}
  :root:not([data-theme="dark"]) .tier-2{background:#dbe6fb;color:#1d3a72}
  :root:not([data-theme="dark"]) .tier-3{background:#e2e5f0;color:#4a5068}
}
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
/* Status pills state BOTH halves of the colour pair, the way the .tag-* pills below do.
   Background alone is not enough: with no colour the text falls back to --fg, which is near-black
   in the light theme and vanishes into these dark grounds. Every pair clears 4.5:1 in both themes.
   Colour is never the only cue -- the pill also spells the status out.
   Declared as tokens so the light theme restates values, not selectors, the same three-state way
   as the tab pills above: base :root is dark, light is said twice (media query for Auto, attribute
   for an explicit choice). */
:root{
  --s-applied-bg:#2b3a67; --s-applied-fg:#cfe0ff;
  --s-screening-bg:#3a2f67; --s-screening-fg:#ddd0f7;
  --s-interview-bg:#1f5b46; --s-interview-fg:#c6f0dc;
  --s-offer-bg:#1f6b2f; --s-offer-fg:#cdf0cf;
  --s-rejected-bg:#6b2330; --s-rejected-fg:#ffc9d2;
  --s-saved-bg:#3a3f57; --s-saved-fg:#d7dcf0;
  --s-withdrawn-bg:#4a3a2a; --s-withdrawn-fg:#f0d9b8;
  --s-proposed-bg:#2a3550; --s-proposed-fg:#cddcf7;
  --s-dismissed-bg:#4a2a30; --s-dismissed-fg:#f0c6cf;
  --s-open-bg:#5a3f0e; --s-open-fg:#f5cf85;
}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]){
    --s-applied-bg:#dbe6fb; --s-applied-fg:#1d3a72;
    --s-screening-bg:#e6dffa; --s-screening-fg:#402a78;
    --s-interview-bg:#d3f0e2; --s-interview-fg:#10503a;
    --s-offer-bg:#d6f0d6; --s-offer-fg:#14561f;
    --s-rejected-bg:#fbdadf; --s-rejected-fg:#7a1b2a;
    --s-saved-bg:#e2e5f0; --s-saved-fg:#363c56;
    --s-withdrawn-bg:#f5e6d2; --s-withdrawn-fg:#5c4020;
    --s-proposed-bg:#dfe6f5; --s-proposed-fg:#2a3f6b;
    --s-dismissed-bg:#fadfe3; --s-dismissed-fg:#6e2430;
    --s-open-bg:#f7e6c4; --s-open-fg:#6b4708;
  }
}
:root[data-theme="light"]{
    --s-applied-bg:#dbe6fb; --s-applied-fg:#1d3a72;
    --s-screening-bg:#e6dffa; --s-screening-fg:#402a78;
    --s-interview-bg:#d3f0e2; --s-interview-fg:#10503a;
    --s-offer-bg:#d6f0d6; --s-offer-fg:#14561f;
    --s-rejected-bg:#fbdadf; --s-rejected-fg:#7a1b2a;
    --s-saved-bg:#e2e5f0; --s-saved-fg:#363c56;
    --s-withdrawn-bg:#f5e6d2; --s-withdrawn-fg:#5c4020;
    --s-proposed-bg:#dfe6f5; --s-proposed-fg:#2a3f6b;
    --s-dismissed-bg:#fadfe3; --s-dismissed-fg:#6e2430;
    --s-open-bg:#f7e6c4; --s-open-fg:#6b4708;
}
.s-applied{background:var(--s-applied-bg);color:var(--s-applied-fg)}
.s-screening{background:var(--s-screening-bg);color:var(--s-screening-fg)}
.s-interview{background:var(--s-interview-bg);color:var(--s-interview-fg)}
.s-offer{background:var(--s-offer-bg);color:var(--s-offer-fg)}
.s-rejected{background:var(--s-rejected-bg);color:var(--s-rejected-fg)}
.s-saved{background:var(--s-saved-bg);color:var(--s-saved-fg)}
.s-withdrawn{background:var(--s-withdrawn-bg);color:var(--s-withdrawn-fg)}
.s-proposed{background:var(--s-proposed-bg);color:var(--s-proposed-fg)}
.s-dismissed{background:var(--s-dismissed-bg);color:var(--s-dismissed-fg)}
/* A task still owed by you. Amber, the same "needs a look" register as .rp-maybe below; its partner
   status "done" deliberately keeps the neutral .pill default, so settled reads as quiet. */
.s-open{background:var(--s-open-bg);color:var(--s-open-fg)}
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
.flash{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:1000;padding:11px 18px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);box-shadow:0 6px 24px var(--flash-shadow);opacity:1;transition:opacity .5s ease,transform .5s ease}
.flash.hide{opacity:0;transform:translateX(-50%) translateY(-8px)}
/* The toast's colours are tokens, said once per theme like the status pills. They used to be dark
   hex only, and the text inherited --fg — which on the light theme is near-black, so "Criteria
   saved." was black on dark green. "bad" (a refused input) and "warn" had no colour of their own at
   all and rendered as bare text floating over the page. Every kind the server sends is styled here. */
:root{
  --flash-shadow:rgba(0,0,0,.35);
  --flash-ok-bg:#153b2a; --flash-ok-bd:#1f6b2f; --flash-ok-fg:#cdf0cf;
  --flash-err-bg:#3b1520; --flash-err-bd:#6b2330; --flash-err-fg:#ffc9d2;
  --flash-warn-bg:#3a2a0e; --flash-warn-bd:#6b4708; --flash-warn-fg:#f5cf85;
}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]){
    --flash-shadow:rgba(31,28,23,.16);
    --flash-ok-bg:#e3f3e2; --flash-ok-bd:#a8d5ab; --flash-ok-fg:#14561f;
    --flash-err-bg:#fbe4e8; --flash-err-bd:#eab0ba; --flash-err-fg:#7a1b2a;
    --flash-warn-bg:#f8ecd2; --flash-warn-bd:#e2c47f; --flash-warn-fg:#6b4708;
  }
}
:root[data-theme="light"]{
    --flash-shadow:rgba(31,28,23,.16);
    --flash-ok-bg:#e3f3e2; --flash-ok-bd:#a8d5ab; --flash-ok-fg:#14561f;
    --flash-err-bg:#fbe4e8; --flash-err-bd:#eab0ba; --flash-err-fg:#7a1b2a;
    --flash-warn-bg:#f8ecd2; --flash-warn-bd:#e2c47f; --flash-warn-fg:#6b4708;
}
.flash.ok{background:var(--flash-ok-bg);border-color:var(--flash-ok-bd);color:var(--flash-ok-fg)}
.flash.err,.flash.bad{background:var(--flash-err-bg);border-color:var(--flash-err-bd);color:var(--flash-err-fg)}
.flash.warn{background:var(--flash-warn-bg);border-color:var(--flash-warn-bd);color:var(--flash-warn-fg)}
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
  /* Two buttons plus five tabs do not fit: Add task keeps its + and loses its word. */
  .addtask-btn .atlabel{display:none}
  .addtask-btn{padding-inline:11px}
  .ti-co{min-width:0}
  .titem{flex-wrap:wrap}
}
footer{padding:18px 24px}
.clickrow{cursor:pointer}.clickrow:hover{background:rgba(110,168,254,.10)}
.taskdone{opacity:.45}.taskdone td:last-child{text-decoration:line-through}
#pinned{padding:12px 24px 0}
#sections{padding:0 24px 0}
.sec{border:1px solid var(--line);border-radius:12px;background:var(--card);margin-bottom:12px;padding:0;overflow:hidden}
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
tr.probrow td{background:rgba(220,80,80,.07)}
tr.probrow td:first-child{box-shadow:inset 3px 0 0 oklch(var(--tring-l) calc(var(--tring-c) * .9) 22)}
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
/* The volatile link explains itself on hover — see the render side for why it is not a badge. */
.volatile-url{cursor:help}
tr.isnew td{background:rgba(46,160,110,.16)}tr.isnew td:first-child{box-shadow:inset 3px 0 0 #2ea06e}
.newbadge{background:#2ea06e;color:#04160e;font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;letter-spacing:.04em}
.repostbadge{display:inline-block;margin-top:4px;font-size:10.5px;font-weight:700;border-radius:6px;
  padding:1px 7px;line-height:1.4;cursor:help}
.rp-certain{color:#ffc9d2;background:rgba(214,0,60,.16);border:1px solid rgba(214,0,60,.55)}
.rp-maybe{color:#f0b357;background:rgba(214,138,0,.14);border:1px solid rgba(214,138,0,.5)}
.appliedhere{display:inline-block;margin-top:4px;font-size:10.5px;font-weight:600;color:#8fd0ff;background:rgba(110,168,254,.14);border:1px solid rgba(110,168,254,.4);border-radius:6px;padding:1px 7px;line-height:1.4}
.sec .sechead{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;user-select:none}
.sec .sechead h2{margin:0;flex:1}
.sec .secbody{padding:2px 16px 16px}
.secbody .board{margin-bottom:12px}
/* The dim AND a blur, so what is behind reads as out of reach rather than merely darker — the
   difference between "there is a dialog" and "the page is waiting on you". Every modal shares it:
   one of these appearing differently from the others would read as a different kind of thing.
   backdrop-filter is unsupported in a few engines; there the dim alone still carries it. */
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);
  -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);
  z-index:50;align-items:flex-start;justify-content:center;padding:32px 16px}
@media (prefers-reduced-transparency:reduce){
  .overlay{-webkit-backdrop-filter:none;backdrop-filter:none;background:rgba(0,0,0,.72)}
}
:root[data-theme="light"] .overlay{background:rgba(31,28,23,.38)}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]) .overlay{background:rgba(31,28,23,.38)}
}
/* The drawer scrolls ITSELF, capped to the viewport, so the header stays put and you are reading a
   panel rather than pushing the whole page around. */
.confirm-modal{max-width:440px;padding:20px 22px 18px}
.confirm-modal h3{margin:0 0 10px;font-size:16px}
.confirm-body p{margin:0 0 9px;font-size:13px;line-height:1.55;color:var(--mut)}
.confirm-body p:last-child{margin-bottom:0}
.confirm-acts{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
/* A new version, and what is in it. */
.upd-modal{max-width:520px;padding:22px 26px 20px}
.upd-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
.upd-head h3{margin:0;font-size:19px;line-height:1.35;letter-spacing:-.01em}
.upd-have{font-size:12.5px;color:var(--mut);white-space:nowrap}
.upd-date{margin:6px 0 0;font-size:12.5px;color:var(--mut)}
.upd-groups{display:flex;flex-direction:column;gap:16px;margin-top:20px}
.upd-group{display:flex;flex-direction:column;gap:7px}
.upd-glabel{margin:0;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--mut);font-weight:600}
.upd-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;font-size:13px;line-height:1.55}
.upd-safe{margin:18px 0 0;padding-top:14px;border-top:1px solid var(--line);font-size:12px;line-height:1.5;color:var(--mut)}
.upd-modal .confirm-acts form.inline{display:inline;margin:0}
.btn-danger{background:#c0392b;border-color:#c0392b;color:#fff}
.btn-danger:hover{background:#a93226;border-color:#a93226}
.modal{background:var(--card);border:1px solid var(--line);border-radius:14px;max-width:760px;width:100%;
  padding:0 26px 26px;position:relative;max-height:calc(100vh - 64px);overflow-y:auto;overscroll-behavior:contain}
.mclose{position:absolute;top:10px;right:12px;background:transparent;color:var(--mut);font-size:22px;padding:2px 8px;z-index:2}
.mclose:hover{filter:none;color:var(--fg)}
/* Title left, job link right, and 34px reserved on the end so neither ever slides under the close
   button — which is absolutely positioned and would otherwise sit on top of the link. */
.mhead{position:sticky;top:0;background:var(--card);padding:22px 34px 12px 0;margin:0 0 4px;
  border-bottom:1px solid var(--line);z-index:1;
  display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.modal h3{margin:0;font-size:19px;line-height:1.35;flex:1 1 260px}
.mhead .btn{flex:0 0 auto}

/* Facts wrap as a single flowing strip. Each is a few words, so they read as a line of context
   rather than a form — and nothing gets a column of its own to be squeezed into. */
.mfacts{display:flex;flex-wrap:wrap;gap:7px 9px;margin:14px 0 4px}
.fact{display:inline-flex;align-items:baseline;gap:6px;background:var(--bg);border:1px solid var(--line);
  border-radius:8px;padding:4px 10px;font-size:12.5px;max-width:100%}
.fk{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em;flex:0 0 auto}
.fv{color:var(--fg);overflow-wrap:anywhere}

.mblock{margin:20px 0 0}
.mh{margin:0 0 8px;font-size:11.5px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;font-weight:650}
/* One measure for every piece of prose in here. ~74 characters is the readable range; the old
   layout was forcing roughly 30. */
.mprose{margin:0;font-size:14px;line-height:1.62;max-width:74ch;overflow-wrap:anywhere}
.mnext{border-left:3px solid var(--acc);padding-left:14px}
.mdismiss{border-left:3px solid #6b2330;padding-left:14px}
.mnote{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:12px 14px;white-space:pre-wrap}

/* Activity/tasks as a timeline: one rule down the side, entries hanging off it. Reads as history
   rather than as bullet points. */
.tline{list-style:none;margin:0;padding:0 0 0 16px;border-left:1px solid var(--line)}
.tline li{position:relative;margin:0 0 16px;padding-left:4px}
.tline li:last-child{margin-bottom:4px}
.tline li::before{content:"";position:absolute;left:-21px;top:7px;width:7px;height:7px;border-radius:50%;
  background:var(--line)}
.tmeta{margin:0 0 4px;font-size:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.tdate{color:var(--mut);font-variant-numeric:tabular-nums}
a.btn{display:inline-block;background:var(--acc);color:#fff;padding:6px 12px;border-radius:8px;text-decoration:none;font-size:13px}
.tag{display:inline-block;padding:1px 8px;border-radius:6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.tag-email{background:#264a7a;color:#cfe0ff}.tag-whatsapp{background:#1f5b46;color:#c6f0dc}.tag-linkedin{background:#0a4a6b;color:#c3e7fb}.tag-web{background:#4a3a6b;color:#ddd0f7}
/* Nothing to collapse at narrow widths any more — the facts strip already wraps and the prose is
   capped by a character measure rather than a column, so both adapt on their own. */
@media(max-width:600px){.modal{padding:0 16px 18px;max-height:calc(100vh - 32px)}.overlay{padding:16px 8px}}

/* ---- Report a problem ------------------------------------------------------------------------
   Narrower than the detail drawer (560 vs 760): this is a form to fill in, not a record to read,
   and a short measure is what makes a form feel finishable. Everything below reuses the page's own
   tokens, so it themes with the rest for free. */
.fb-modal{max-width:560px;padding:22px 24px 20px}
.fb-modal h3{margin:0 0 7px;font-size:17px}
.fb-lede{margin:0 0 17px;font-size:13px;line-height:1.55;color:var(--mut);max-width:52ch}
.fb-fld{display:block;font-size:12px;color:var(--mut);margin:0 0 6px}
.fb-ta{width:100%;font-size:13.5px;line-height:1.6;min-height:104px;resize:vertical}
.fb-opts{margin:15px 0 0;border:1px solid var(--line);border-radius:10px;background:var(--bg);padding:4px}
.fb-opt{display:flex;gap:11px;padding:10px 11px;border-radius:8px;align-items:flex-start;cursor:pointer}
.fb-opt:hover{background:var(--card)}
.fb-opt input{margin:2px 0 0;accent-color:var(--acc);width:15px;height:15px;flex:0 0 auto}
.fb-t{display:block;font-size:13px;font-weight:650}
.fb-d{display:block;font-size:12px;color:var(--mut);line-height:1.5;margin-top:2px}
.fb-warn{margin:11px 0 0;border:1px solid rgba(240,179,87,.42);background:rgba(240,179,87,.09);
  border-radius:10px;padding:12px 13px}
.fb-wt{color:#f0b357;font-size:12.5px;font-weight:700;display:flex;gap:7px;align-items:center;margin-bottom:6px}
.fb-warn p{margin:0;font-size:12.5px;line-height:1.55;color:var(--mut)}
.fb-ack{display:flex;gap:10px;align-items:flex-start;margin-top:11px;font-size:12.5px;color:var(--fg);
  line-height:1.5;cursor:pointer}
.fb-ack input{margin:1px 0 0;accent-color:var(--acc);width:15px;height:15px;flex:0 0 auto}
.fb-what{margin:15px 0 0;border-top:1px solid var(--line);padding-top:13px}
.fb-wh{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);font-weight:650;margin:0 0 8px}
.fb-manifest{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.fb-manifest li{display:flex;gap:9px;font-size:12.5px;color:var(--mut);line-height:1.5;align-items:baseline}
.fb-mk{flex:0 0 auto;font-size:13px;line-height:1.35;font-weight:700}
.fb-mk.yes{color:#5fbf8f}.fb-mk.no{color:#c9788a}
.fb-manifest code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}
.fb-acts{display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:18px}
.fb-acts button[disabled]{opacity:.42;cursor:not-allowed;filter:none}
.fb-err{margin-right:auto;font-size:12.5px;color:#e8879b;max-width:32ch;line-height:1.45}
.fb-file{display:flex;align-items:center;gap:12px;border:1px solid var(--line);background:var(--bg);
  border-radius:10px;padding:12px 13px;margin:16px 0 0}
.fb-fi{flex:1;min-width:0}
.fb-nm{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;color:var(--fg)}
.fb-loc{font-size:11.5px;color:var(--mut);margin-top:3px;overflow-wrap:anywhere}
.fb-mail{margin:16px 0 0;border:1px solid var(--acc);border-radius:10px;background:var(--card);padding:14px 15px}
.fb-mt{font-size:13px;font-weight:650;margin:0 0 4px}
.fb-steps{margin:9px 0 0;padding:0 0 0 19px;display:flex;flex-direction:column;gap:6px}
.fb-steps li{font-size:12.5px;color:var(--mut);line-height:1.55}
.fb-steps li::marker{color:var(--acc);font-variant-numeric:tabular-nums}
.fb-addr{display:flex;align-items:center;gap:10px;margin:11px 0 0;flex-wrap:wrap}
.fb-a{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);background:var(--bg);
  border:1px solid var(--line);border-radius:8px;padding:7px 11px;flex:1;min-width:180px;user-select:all}
/* Same geometry as .flash, which has no neutral variant of its own. */
.fb-toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:1000;padding:11px 18px;
  border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:13px;
  box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center}
.fb-spin{width:13px;height:13px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--acc);
  animation:fbsp .8s linear infinite;flex:0 0 auto}
@keyframes fbsp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.fb-spin{animation:none}}
`;

// ---------------------------------------------------------------------------- report a problem
//
// The picture is drawn from the LIVE DOM, not re-fetched from the server. That is the whole point:
// a bug report has to show the page the person was actually looking at -- the tab they had open,
// the filter they had set, the row they had expanded, the theme they use -- and none of that
// survives a round trip to "/". So the body is cloned in place, the live form state is written back
// into the clone as attributes (a cloned <input> carries its ORIGINAL value attribute, not what was
// typed into it), and the result is painted through an SVG <foreignObject> onto a canvas.
//
// Nothing outside this page can be reached by any of it. There is no OS screen capture here, which
// is why JobSeeker still needs no Screen Recording permission on macOS -- see docs/PERMISSIONS.md.
const FEEDBACK_JS = `(function(){
  var overlay, done, shot, ack, warn, send, ta, err;

  function $(id){ return document.getElementById(id); }
  function show(el){ el.style.display='flex'; document.body.style.overflow='hidden'; }
  function hide(el){ el.style.display='none'; document.body.style.overflow=''; }

  // "Create the file" needs something to report, and -- if a picture is going in -- an explicit
  // acknowledgement of what a picture of this page can contain.
  function refresh(){
    warn.hidden = !shot.checked;
    if (!shot.checked) ack.checked = false;
    send.disabled = !ta.value.trim() || (shot.checked && !ack.checked);
  }

  function fail(msg){
    err.textContent = msg;
    err.hidden = false;
    send.disabled = false;
    send.textContent = 'Create the file';
  }

  /* ---- the picture -------------------------------------------------------------------------- */

  // A clone carries the markup, not the state: what someone typed lives in .value, which has no
  // attribute behind it, and the same is true of checked, selected and scroll position. Written
  // back here so the picture shows the form as it looked, not as it was served.
  function syncState(live, copy){
    var a = live.querySelectorAll('input,textarea,select');
    var b = copy.querySelectorAll('input,textarea,select');
    for (var i=0; i<a.length && i<b.length; i++){
      var x=a[i], y=b[i];
      if (x.tagName==='TEXTAREA'){ y.textContent = x.value; }
      else if (x.tagName==='SELECT'){
        var opts=y.querySelectorAll('option');
        for (var j=0;j<opts.length;j++){ if(j===x.selectedIndex) opts[j].setAttribute('selected',''); else opts[j].removeAttribute('selected'); }
      } else if (x.type==='checkbox' || x.type==='radio'){
        if (x.checked) y.setAttribute('checked',''); else y.removeAttribute('checked');
      } else {
        y.setAttribute('value', x.value);
      }
    }
  }

  // Every <img> has to become a data: URI -- an SVG rendered into a canvas cannot fetch anything,
  // and an image left as a URL silently paints nothing. Failures drop the image rather than the
  // report; a picture missing a logo is still a useful picture.
  function inlineImages(copy){
    var imgs = Array.prototype.slice.call(copy.querySelectorAll('img'));
    // <source srcset> would win over the <img> we just inlined, and it cannot be inlined itself.
    Array.prototype.slice.call(copy.querySelectorAll('picture source')).forEach(function(n){ n.remove(); });
    return Promise.all(imgs.map(function(img){
      var src = img.getAttribute('src');
      if (!src || src.indexOf('data:')===0) return null;
      return fetch(src).then(function(r){ return r.blob(); }).then(function(b){
        return new Promise(function(res){
          var fr = new FileReader();
          fr.onload = function(){ img.setAttribute('src', fr.result); res(); };
          fr.onerror = function(){ img.remove(); res(); };
          fr.readAsDataURL(b);
        });
      }).catch(function(){ img.remove(); });
    }));
  }

  // Every colour in this stylesheet resolves through a custom property declared on :root -- and the
  // clone has no :root. Read them off the live document and carry them on the wrapper, which also
  // pins the theme: whatever the user is looking at now is what gets drawn, Auto or not.
  var TOKENS = ['--bg','--card','--line','--fg','--mut','--acc','--gut','--maxw',
    '--tbg-l','--tbg-c','--tfg-l','--tfg-c','--ton-bg-l','--ton-bg-c','--ton-fg-l','--ton-fg-c',
    '--tring-l','--tring-c'];
  function tokenStyle(){
    var cs = getComputedStyle(document.documentElement);
    var names = [];
    try { for (var i=0;i<cs.length;i++){ if (cs[i].indexOf('--')===0) names.push(cs[i]); } } catch(e){}
    if (!names.length) names = TOKENS;
    var out = '';
    names.forEach(function(n){ var v = cs.getPropertyValue(n); if (v) out += n + ':' + v.trim() + ';'; });
    return out;
  }

  var MAX_H = 8000; // a very long Activity log is not worth a 40 MB attachment

  function capture(){
    var root = document.documentElement;
    var w = Math.max(root.scrollWidth, document.body.scrollWidth, window.innerWidth || 0, 900);
    var copy = document.body.cloneNode(true);

    // The dialog that asked for this, the tour, and any toast: none of them are the page.
    Array.prototype.slice.call(copy.querySelectorAll(
      '#fbOverlay,#fbDone,.fb-toast,.flash,.tour-veil,.tour-spot,.tour-bub,script,link[rel=stylesheet]'
    )).forEach(function(n){ n.remove(); });

    syncState(document.body, copy);

    return inlineImages(copy).then(function(){
      // The page's own stylesheet, lifted whole. It is already inline in <head>, so there is
      // nothing to fetch and nothing that can go missing.
      var css = Array.prototype.slice.call(document.querySelectorAll('head style'))
        .map(function(n){ return n.textContent; }).join('\\n');

      var wrap = document.createElement('div');
      copy.setAttribute('style','width:' + w + 'px;margin:0;');
      wrap.appendChild(copy);

      // How tall is the picture? Not the live page's scrollHeight -- that is the height of a
      // document with a sticky header, a scrolled viewport and, on a backgrounded tab, no viewport
      // at all (Settings reported 3733px for 935px of content, and the report came back four fifths
      // empty). Ask the clone instead, by laying it out off-screen and measuring what it actually
      // occupies. The page's own stylesheet is already applied to anything in the document, so the
      // <style> below is added only for serialising -- adding it before the measurement would
      // duplicate the whole sheet into the live page for a frame.
      var tokens = tokenStyle();
      wrap.setAttribute('style','position:absolute;left:-99999px;top:0;width:' + w + 'px;' + tokens);
      document.body.appendChild(wrap);
      var h = Math.min(wrap.scrollHeight, MAX_H);
      wrap.remove();

      wrap.setAttribute('style','width:' + w + 'px;height:' + h + 'px;' + tokens +
        'background:' + getComputedStyle(document.body).backgroundColor + ';');
      var st = document.createElement('style');
      st.textContent = css;
      wrap.insertBefore(st, wrap.firstChild);

      // XMLSerializer already stamps the XHTML namespace on the wrapper, which is what makes the
      // markup legal inside <foreignObject>. Adding one here as well produced a duplicate xmlns
      // attribute, and the SVG then failed to parse -- silently, as a picture that never arrived.
      var xml = new XMLSerializer().serializeToString(wrap);
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
        '<foreignObject x="0" y="0" width="100%" height="100%">' + xml + '</foreignObject></svg>';

      var scale = Math.min(2, window.devicePixelRatio || 1);
      return new Promise(function(res, rej){
        var img = new Image();
        img.onload = function(){
          var c = document.createElement('canvas');
          c.width = Math.round(w * scale); c.height = Math.round(h * scale);
          var g = c.getContext('2d');
          g.scale(scale, scale);
          g.drawImage(img, 0, 0);
          try { res(c.toDataURL('image/png')); } catch(e){ rej(new Error('the canvas could not be read')); }
        };
        img.onerror = function(){ rej(new Error('the page could not be drawn')); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
    });
  }

  /* ---- the flow ----------------------------------------------------------------------------- */

  // Which tab is open is part of "where I was", and it lives only in the DOM -- the URL says
  // nothing about it once you have clicked around.
  function whereAmI(){
    // data-tab, not the label: the label carries its count badge with no space in front of it, so
    // reading the text gave "People1".
    var tab = document.querySelector('nav.tabs .tab.on');
    return location.pathname + (tab ? ' — ' + tab.getAttribute('data-tab') + ' tab' : '') +
      (window.scrollY > 40 ? ' — scrolled ' + Math.round(window.scrollY) + 'px' : '');
  }

  function toast(text){
    var t = document.createElement('div');
    t.className = 'fb-toast';
    t.innerHTML = '<span class="fb-spin"></span><span></span>';
    t.lastChild.textContent = text;
    document.body.appendChild(t);
    return t;
  }

  function submit(){
    err.hidden = true;
    send.disabled = true;
    send.textContent = 'Working\\u2026';
    var want = shot.checked;
    var page = whereAmI();

    // The dialog goes first, and only then the shutter -- otherwise every report is a picture of
    // the report dialog. Two frames plus a beat is enough for the browser to have repainted.
    hide(overlay);
    var t = want ? toast('Drawing the page\\u2026') : null;

    // Two frames plus a beat: long enough for the browser to have repainted without the dialog.
    // Raced against a timer because requestAnimationFrame does not fire in a hidden tab -- without
    // the race, reporting from a backgrounded window hung on "Working..." forever.
    new Promise(function(res){
      var settled = false;
      var go = function(){ if (!settled){ settled = true; res(); } };
      requestAnimationFrame(function(){ requestAnimationFrame(function(){ setTimeout(go, 250); }); });
      setTimeout(go, 1200);
    })
      .then(function(){ return want ? capture().catch(function(){ return null; }) : null; })
      .then(function(png){
        if (t) t.remove();
        return fetch('/feedback', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({ message: ta.value, page: page, userAgent: navigator.userAgent, shot: png })
        });
      })
      .then(function(r){ return r.ok ? r.json() : r.text().then(function(m){ throw new Error(m || 'the server refused it'); }); })
      .then(function(d){
        $('fbName').textContent = d.name;
        $('fbLoc').textContent = d.dir + '  \\u00b7  ' + d.size + '  \\u00b7  ' + d.entries.join(', ');
        send.textContent = 'Create the file';
        show(done);
      })
      .catch(function(e){
        if (t) t.remove();
        show(overlay);
        fail('It could not be saved: ' + (e && e.message ? e.message : 'unknown error'));
      });
  }

  document.addEventListener('DOMContentLoaded', function(){
    overlay = $('fbOverlay'); done = $('fbDone');
    if (!overlay) return;
    shot = $('fbShot'); ack = $('fbAck'); warn = $('fbWarn');
    send = $('fbSend'); ta = $('fbText'); err = $('fbErr');

    var btn = $('bugbtn');
    if (btn) btn.addEventListener('click', function(){
      err.hidden = true; refresh(); show(overlay);
      setTimeout(function(){ ta.focus(); }, 40);
    });
    ta.addEventListener('input', refresh);
    shot.addEventListener('change', refresh);
    ack.addEventListener('change', refresh);
    $('fbCancel').addEventListener('click', function(){ hide(overlay); });
    $('fbClose').addEventListener('click', function(){ hide(overlay); });
    $('fbSend').addEventListener('click', submit);
    $('fbDoneOk').addEventListener('click', function(){ hide(done); });
    $('fbDoneClose').addEventListener('click', function(){ hide(done); });
    overlay.addEventListener('click', function(e){ if (e.target === overlay) hide(overlay); });
    done.addEventListener('click', function(e){ if (e.target === done) hide(done); });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape'){ hide(overlay); hide(done); }
    });

    $('fbCopy').addEventListener('click', function(){
      var b = $('fbCopy');
      navigator.clipboard.writeText($('fbAddr').textContent.trim()).then(function(){
        b.textContent = 'Copied';
        setTimeout(function(){ b.textContent = 'Copy the address'; }, 1600);
      }).catch(function(){
        // No clipboard permission: select it instead, so Cmd-C still works.
        var r = document.createRange(); r.selectNodeContents($('fbAddr'));
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      });
    });
  });
})();`;

const JS = `${VIEWPORT_JS}
  /* Refreshing should put you back exactly where you were.
     Two things move you: the scroll position, and the TAB. The tab is the one that bit -- after any
     POST the URL carries ?flash=...&tab=today from the redirect, and a reload re-reads that query
     and pins the tab it names, so refreshing from Pipeline dropped you on Today. So before any
     reload we own, the URL is rewritten to the tab that is actually open and the stale query is
     dropped (a flash re-shown on refresh is a message about something that already happened). The
     Settings sub-pane rides along, because ?sub= is real state, not a leftover. */
  function keepPlace(){
    try { sessionStorage.setItem('js_scroll', JSON.stringify({ p: location.pathname, y: window.scrollY })); } catch(e){}
    try {
      var on = document.querySelector('nav.tabs .tab.on');
      var sub = new URLSearchParams(location.search).get('sub');
      var url = location.pathname + (sub ? '?sub=' + encodeURIComponent(sub) : '') + (on ? '#' + on.getAttribute('data-tab') : location.hash);
      history.replaceState(null, '', url);
    } catch(e){}
  }

  /* The new-version dialog.
     The server renders it whether or not it is due; this decides. Two reasons it lives here rather
     than in the markup: the dismissed-key test is one expression, and a modal that appears during
     the first paint of a page someone is already reading is a modal that gets dismissed blind. */
  (function(){
    var u = window.__UPDATE__;
    var ov = document.getElementById('updateOverlay');
    /* forced is a manual Check for updates -- a standing Not now is not an answer to a question
       the user has just asked again. */
    if (!u || !ov || (u.dismissed && !u.forced)) return;
    /* Not on top of something the user is already doing. */
    function busy(){
      var a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
      if (document.querySelector('.pop:not(.hide)')) return true;
      if (document.querySelector('.tour-bub, .busybub')) return true;
      var c = document.getElementById('confirmOverlay');
      return !!(c && getComputedStyle(c).display !== 'none');
    }
    function show(){
      if (busy() && !u.forced) { setTimeout(show, 4000); return; }
      ov.style.display = 'flex';
      var b = ov.querySelector('.btn-secondary');
      if (b) b.focus();
    }
    /* Escape closes it for this session only. It must NOT write what the Not now button writes:
       a key pressed to get a dialog off the screen is not an answer to the question it asked, and
       the offer has to come back on the next launch. */
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && ov.style.display === 'flex') ov.style.display = 'none';
    });
    if (u.forced) show(); else setTimeout(show, 900);
  })();

  /* Cmd-R.
     In a browser this is free. In the app it is not: JobSeeker.app is a WebView with no menu bar,
     and a WKWebView with no Reload menu item swallows the key -- so the one shortcut everybody
     already knows did nothing in the one place the auto-refresh is most likely to be waiting on a
     quiet moment. Handling it here covers both, and Cmd-Shift-R is left alone for the browser's
     own hard reload. */
  document.addEventListener('keydown', function(e){
    if((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'r' || e.key === 'R')){
      e.preventDefault();
      keepPlace();
      location.reload();
    }
  });

  /* A run that finishes while you are looking at the page.
     Without this the page is a photograph: the badge said "running" until you happened to reload,
     and the roles a curate run had just found were sitting on disk, invisible. Nothing here streams
     -- the dashboard is server-rendered -- so the page asks a tiny endpoint whether the world has
     changed, and reloads itself when it has.
     Polls fast while something is running and slowly when nothing is, because the idle case is only
     watching for a run someone ELSE started: the 08:00 schedule, another tab, the terminal. */
  (function(){
    var seen = null, timer = 0;
    function busyNow(){ return !!document.querySelector('[data-busy]'); }
    /* Never yank the page out from under a hand. A reload mid-sentence loses what was typed, and a
       reload under an open dialog loses the decision being made -- so it waits for a quiet moment,
       which the next poll will find. */
    function occupied(){
      var a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
      if (document.querySelector('.pop:not(.hide)')) return true;
      if (document.querySelector('.tour-bub, .busybub')) return true;
      var ov = document.getElementById('confirmOverlay');
      if (ov && getComputedStyle(ov).display !== 'none') return true;
      var sel = window.getSelection && window.getSelection();
      return !!(sel && String(sel).length > 2);
    }
    function tick(){
      fetch('/run-state', { cache: 'no-store' })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(d){
          if (!d) return;
          /* A version this page has never heard of is a change worth reloading for, the same as a
             run finishing: the reload is what puts the dialog in front of the user. */
          var now = (d.running ? d.running.slug + '@' + d.running.started : '') + '|' + (d.finished || '') +
                    '|' + (d.update || '');
          if (seen === null) { seen = now; return; }      /* first answer is the baseline */
          if (now !== seen && !occupied()) {
            seen = now;
            keepPlace();
            location.reload();
          }
        })
        .catch(function(){ /* server restarting; the next tick tries again */ })
        .then(schedule);
    }
    function schedule(){
      clearTimeout(timer);
      timer = setTimeout(tick, busyNow() ? 5000 : 30000);
    }
    /* A hidden tab costs the user nothing to leave open, and should cost the server nothing either. */
    document.addEventListener('visibilitychange', function(){
      if (!document.hidden) { clearTimeout(timer); timer = setTimeout(tick, 400); }
    });
    schedule();
  })();

  /* Why that button did nothing.
     A gated button keeps its click (see busyAttrs) precisely so there is something to answer with.
     No veil and no dimming: this is an answer to one click, not a tour — it points at the control
     you pressed, says who has the browser, and goes away on the next click, Escape, or eight
     seconds. */
  (function(){
    var bub = null, tid = 0, anchor = null;
    function close(){
      if(tid){ clearTimeout(tid); tid = 0; }
      if(bub && bub.parentNode) bub.parentNode.removeChild(bub);
      bub = null; anchor = null;
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    }
    function place(){
      if(!bub || !anchor) return;
      var r = anchor.getBoundingClientRect(), vw = vpW(), vh = vpH();
      var bh = bub.offsetHeight || 90, bw = bub.offsetWidth || 260;
      var below = r.bottom + 12;
      var goBelow = (below + bh) < (vh - 12);
      bub.className = 'busybub ' + (goBelow ? 'below' : 'above');
      bub.style.top = Math.round(goBelow ? below : Math.max(12, r.top - 12 - bh)) + 'px';
      var left = Math.max(12, Math.min(r.left + r.width / 2 - bw / 2, vw - bw - 12));
      bub.style.left = Math.round(left) + 'px';
      var arrow = bub.querySelector('i');
      if(arrow){
        arrow.style.left = Math.round(Math.min(Math.max(14, r.left + r.width / 2 - left - 6), bw - 26)) + 'px';
      }
    }
    function show(btn, msg){
      close();
      anchor = btn;
      bub = document.createElement('div');
      bub.className = 'busybub below';
      bub.setAttribute('role', 'status');
      bub.innerHTML = '<i></i><p></p>';
      bub.querySelector('p').textContent = msg;
      document.body.appendChild(bub);
      place();
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
      tid = setTimeout(close, 8000);
    }
    /* Capture phase, so the click is answered before any submit handler acts on it. */
    document.addEventListener('click', function(e){
      var t = e.target.closest && e.target.closest('[data-busy]');
      if(!t){ if(bub) close(); return; }
      e.preventDefault();
      e.stopPropagation();
      show(t, t.getAttribute('data-busy'));
    }, true);
    /* Belt and braces: a gated control inside a form must never submit, however it was triggered
       (Enter on a focused button, a stray handler). */
    document.addEventListener('submit', function(e){
      var f = e.target;
      if(f && f.querySelector && f.querySelector('[data-busy]')){
        e.preventDefault();
        e.stopImmediatePropagation();
        var b = f.querySelector('[data-busy]');
        show(b, b.getAttribute('data-busy'));
      }
    }, true);
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') close(); });
  })();

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
      var vw=vpW(), vh=vpH();
      /* CENTRE on the button, then clamp to both edges. Right-aligning a 560px panel under a 150px
         button left it hanging a long way to the left with the arrow out at one corner — on-screen,
         correctly anchored, and still reading as misaligned. Centring puts the arrow near the middle
         where the eye expects it. The outer max keeps a panel wider than the viewport on screen. */
      var left=Math.max(pad, Math.min(b.left + b.width/2 - w/2, vw-w-pad));
      var top=b.bottom+10;
      if(top+h > vh-pad) top=Math.max(pad, b.top-h-10); // flip above if no room below
      el.style.left=Math.round(left)+'px';
      el.style.top=Math.round(top)+'px';
      /* Where the arrow has to sit to actually point at the button. A panel is centred on its
         button and then clamped to the viewport edge, so a fixed arrow offset points at the button
         only in the middle of the screen — the wider the panel, the further out it lies. Panels
         that opt in read this; the rest keep their fixed corner arrow. */
      el.style.setProperty('--arrowx', Math.round(Math.min(Math.max(16, b.left + b.width/2 - left - 6), w-28))+'px');
    }
    /* [data-popfocus] first: a panel whose primary control is an <input> (Add task) has to focus
       that input, and it is the panel, not this function, that knows which control that is. */
    var t=el.querySelector('[data-popfocus]') || el.querySelector('textarea');
    if(t){ t.focus(); if(t.select) t.select(); }
    if(el.id==='addtask') addTaskPreview();
  } else if(popOpener){ popOpener.focus(); popOpener=null; }
}
document.addEventListener('click', function(e){
  /* Any popover opener, not just .dismbtn: without this the document handler closes the popover in
     the same click that popToggle opened it, and the menu never appears. */
  if(e.target.closest && (e.target.closest('.pop') || e.target.closest('[aria-haspopup=dialog]'))) return;
  popCloseAll();
});
document.addEventListener('keydown', function(e){
  if(e.key==='Escape'){
    var open=document.querySelector('.pop:not(.hide)');
    if(open) popClose(open.id);
  }
});

/* ---------- Add task: show what it parsed, before it is written ----------
   The chips have to say exactly what the server will store, so the page runs the SERVER's parser.
   parseNL is injected verbatim below rather than reimplemented for the browser: two copies of a
   heuristic drift, and a preview that disagrees with the row it creates is worse than no preview.
   It is pure and dependency-free, which is what makes shipping the same function to both sides
   possible at all. */
${parseNL.toString()}
/* ISO is what goes in the column; a weekday is what tells you the parse was right. "2026-09-11" and
   "Fri 11 Sep" are the same fact, and only one of them catches "Friday" landing on a Thursday. */
function addTaskDue(iso){
  /* split(), not a regex: this string is inside a server-side template literal, where a lone \\d
     would be eaten as an escape and ship a regex that matches the letter d. */
  var m=String(iso||'').split('-');
  if(m.length!==3 || m[0].length!==4) return iso||'';
  var d=new Date(+m[0], +m[1]-1, +m[2]);
  var DAY=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return DAY[d.getDay()]+' '+d.getDate()+' '+MON[d.getMonth()];
}
function addTaskPreview(){
  var inp=document.getElementById('addtasknl'), out=document.getElementById('addtaskparsed');
  if(!inp||!out) return;
  var raw=inp.value.trim();
  /* Empty field: no chips. "no date · followup · not named" over an empty box is three lines of
     noise saying nothing has been typed yet, which the empty box already says. */
  if(!raw){ out.textContent=''; out.classList.add('hide'); out.dataset.sig=''; return; }
  var p=parseNL(raw);
  /* Most keystrokes change nothing here — a whole word can go by without moving a column. Redrawing
     only on a real change keeps this a live region a screen reader can bear: it speaks when the
     parse moves, not on every letter. */
  var sig=p.due_date+'|'+p.type+'|'+p.who;
  if(out.dataset.sig===sig && !out.classList.contains('hide')) return;
  out.dataset.sig=sig;
  out.textContent='';
  out.classList.remove('hide');
  [['due', p.due_date ? addTaskDue(p.due_date) : 'no date', !p.due_date],
   ['type', p.type, false],
   ['who', p.who || 'not named', !p.who]].forEach(function(c){
    var el=document.createElement('span');
    el.className='pchip'+(c[2]?' pnone':'');
    var k=document.createElement('span'); k.className='pk'; k.textContent=c[0];
    el.appendChild(k);
    /* textContent, never innerHTML: this is whatever was typed into the box. */
    el.appendChild(document.createTextNode(c[1]));
    out.appendChild(el);
  });
}
document.addEventListener('input', function(e){
  if(e.target && e.target.id==='addtasknl') addTaskPreview();
});
/* The panel promises "Enter to add", so it says so out loud rather than leaning on the browser's
   implicit submission — which a single stray keydown handler anywhere above it would silence. */
document.addEventListener('keydown', function(e){
  if(e.key!=='Enter' || !e.target || e.target.id!=='addtasknl') return;
  var f=document.getElementById('addtaskform');
  if(!f || !f.reportValidity()) return;
  e.preventDefault();
  f.requestSubmit ? f.requestSubmit() : f.submit();
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

/* ---------- Confirmations ----------
   Every "are you sure" in this app is an in-app modal. window.confirm() is not used anywhere: the
   browser's own dialog says "localhost:4319 says", cannot be styled or laid out, breaks the visual
   language of the page and reads like a phishing prompt or a bug.

   uiConfirm() returns a Promise<boolean>, so an async caller (the criteria form, which asks the
   server what a change would cost before asking the user) reads the same as a plain one. The modal
   is built once and reused; both pages carry the same markup. */
function uiConfirm(opts){
  opts = opts || {};
  return new Promise(function(resolve){
    var ov = document.getElementById('confirmOverlay');
    if (!ov) { resolve(true); return; }               /* no modal on the page: never block the action */
    var body = document.getElementById('confirmBody');
    var okBtn = document.getElementById('confirmOk');
    var cancelBtn = document.getElementById('confirmCancel');
    document.getElementById('confirmTitle').textContent = opts.title || 'Are you sure?';
    /* Plain text, split on blank lines into paragraphs: callers write prose, never markup. */
    body.textContent = '';
    String(opts.body || '').split(/\\n\\s*\\n/).forEach(function(para){
      if (!para.trim()) return;
      var p = document.createElement('p');
      p.textContent = para.trim();
      body.appendChild(p);
    });
    okBtn.textContent = opts.ok || 'Confirm';
    okBtn.className = opts.danger ? 'btn-danger' : '';
    var prev = document.activeElement;
    function done(v){
      ov.style.display = 'none';
      document.removeEventListener('keydown', onKey, true);
      ov.onclick = null; okBtn.onclick = null; cancelBtn.onclick = null;
      if (prev && prev.focus) prev.focus();
      resolve(v);
    }
    function onKey(e){
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      /* Trap Tab inside the dialog: a confirmation you can tab out of is a confirmation you can
         answer by accident, with the page underneath still fully interactive. */
      if (e.key === 'Tab'){
        var f = [cancelBtn, okBtn];
        var i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
    }
    ov.onclick = function(e){ if (e.target === ov) done(false); };
    okBtn.onclick = function(){ done(true); };
    cancelBtn.onclick = function(){ done(false); };
    document.addEventListener('keydown', onKey, true);
    ov.style.display = 'flex';
    cancelBtn.focus();
  });
}

/* Any form carrying data-confirm asks before it submits.
   Capture phase, so this runs BEFORE the row-action handler further down — otherwise that handler
   would fetch-submit the form while this one was still asking. stopImmediatePropagation is what
   holds the other listeners off; the re-submit after OK goes through requestSubmit so they run
   normally on the second pass. */
document.addEventListener('submit', function(e){
  var f = e.target;
  if (!f || !f.getAttribute || !f.getAttribute('data-confirm')) return;
  if (f.dataset.confirmed === '1') { delete f.dataset.confirmed; return; }
  e.preventDefault();
  e.stopImmediatePropagation();
  uiConfirm({
    title: f.getAttribute('data-confirm-title') || 'Are you sure?',
    body: f.getAttribute('data-confirm'),
    ok: f.getAttribute('data-confirm-ok') || 'Confirm',
    danger: f.hasAttribute('data-confirm-danger')
  }).then(function(go){
    if (!go) return;
    f.dataset.confirmed = '1';
    if (f.requestSubmit) f.requestSubmit(); else f.submit();
  });
}, true);

// Auto-hide the flash toast: keep it visible for 5s, then fade out and remove it.
(function(){
  var f = document.querySelector('.flash');
  if (!f) return;
  setTimeout(function(){
    f.classList.add('hide');
    setTimeout(function(){ f.remove(); }, 550);
  }, 5000);
})();

// Row actions across every list: submit via fetch and collapse just that row, with no page reload.
//
// Previously only proposals did this; a task or lead dismissal was a POST -> 303 -> full reload.
// Saving and restoring scroll made it land in the right place, but you still SAW the round trip —
// the page blanked, snapped to the top and jumped back down. Fixing the symptom made the flicker
// more obvious, not less. Not reloading at all is the actual fix.
//
// Scoped by "is this form inside a table row", not by an endpoint allowlist. That is the honest
// discriminator: bulk actions (Dismiss all N, Remove all N, mark-all-seen) live outside any row, so
// they fall through to a normal submit and get the full reload they need, and any row action added
// later is picked up without being registered anywhere.
(function(){
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ROW_ACTIONS = ['/set-proposal-status','/set-task-status','/set-app-status','/dismiss-board','/dismiss-advance'];

  // Collapse a row to nothing: fade first, then close the gap it leaves. Two phases rather than one
  // so the list does not lurch while the row is still legible.
  function collapseRow(row, after){
    if (REDUCED){ row.style.display='none'; after && after(); return; }
    var tds = Array.prototype.slice.call(row.querySelectorAll('td'));
    tds.forEach(function(td){ td.style.height = td.offsetHeight + 'px'; });
    row.style.transition = 'opacity .15s ease';
    row.style.opacity = '0';
    setTimeout(function(){
      tds.forEach(function(td){
        td.style.transition = 'height .2s ease, padding-top .2s ease, padding-bottom .2s ease';
        td.style.overflow = 'hidden';
        // Text is already invisible at this point, so zeroing these is not seen — it is only what
        // lets the row's height actually reach zero rather than being propped open by its content.
        td.style.lineHeight = '0'; td.style.fontSize = '0';
        td.style.height = '0px'; td.style.paddingTop = '0'; td.style.paddingBottom = '0';
      });
      setTimeout(function(){
        row.style.display = 'none';
        // Undo every inline style once hidden. Leaving height/padding/font-size at zero would mean
        // that switching to the Dismissed filter later showed a real row as an invisible sliver —
        // present in the DOM, counted in the chips, and impossible to see or click.
        tds.forEach(function(td){
          td.style.cssText = '';
        });
        row.style.transition = ''; row.style.opacity = '';
        after && after();
      }, 210);
    }, 150);
  }

  // Keep the filter chips honest. The row stays in the DOM (hidden) with its new status, so counts
  // are recomputed from the same attributes the filters read — no guessing, no drift, and switching
  // to the Dismissed chip still shows what was just dismissed.
  function refreshCounts(scope){
    var rows = Array.prototype.slice.call(scope.querySelectorAll('tbody tr'));
    if (!rows.length) return;
    scope.querySelectorAll('.tf').forEach(function(chip){
      var f = chip.getAttribute('data-f');
      // Strip the trailing "(n)" without a regex, for the same escaping reason as ROW_ACTIONS above.
      var label = chip.textContent;
      var paren = label.lastIndexOf('(');
      if (paren > 0) label = label.slice(0, paren);
      label = label.trim();
      var n = rows.filter(function(tr){
        var st = tr.getAttribute('data-status') || '';
        var kd = tr.getAttribute('data-kind') || '';
        if (f === 'all') return true;
        if (f === 'active') return st !== 'dismissed';
        if (f === 'due') return tr.getAttribute('data-due') === 'yes' && st === 'open';
        if (f === 'stale') return tr.getAttribute('data-stale') === 'yes' && st === 'open';
        if (f === 'new') return tr.getAttribute('data-new') === 'yes';
        if (f === 'lead' || f === 'application') return kd === f && st !== 'dismissed';
        return st === f;
      }).length;
      chip.textContent = label + ' (' + n + ')';
    });
  }

  // Flip a dismiss control into its restore counterpart, so the row is still correct if the user
  // switches to the Dismissed filter instead of reloading.
  function toRestore(form){
    var st = form.querySelector('input[name=status]');
    if (!st) return;
    var action = form.getAttribute('action') || '';
    st.value = action === '/set-proposal-status' ? 'proposed'
             : action === '/set-app-status' ? 'Saved'
             : 'open';
    var btn = form.querySelector('button');
    if (btn){ btn.textContent = '↺'; btn.classList.remove('xbtn'); btn.title = 'Restore'; }
  }

  document.addEventListener('submit', function(e){
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if ((form.getAttribute('method') || '').toLowerCase() !== 'post') return;
    var row = form.closest('tr');
    if (!row) return;                       // bulk action — let it reload normally
    var action = form.getAttribute('action') || '';
    // A plain list, not a regex. This whole script is inside a template literal in dashboard.mjs,
    // so backslashes are eaten as escape sequences before the browser ever sees them: the obvious
    // /^\/(a|b)$/ arrives as /^/(a|b)$/, which is a SyntaxError that kills the ENTIRE script block —
    // every handler on the page, silently, with the only symptom being that things stopped working.
    // Anything needing a backslash here must double it; avoiding the need is safer.
    if (ROW_ACTIONS.indexOf(action) === -1) return;

    e.preventDefault();
    var statusInput = form.querySelector('input[name=status]');
    var newStatus = statusInput ? statusInput.value : 'dismissed';
    var body = new URLSearchParams(new FormData(form)).toString();
    var sec = form.closest('.sec');

    fetch(action, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body })
      .then(function(r){
        if (!r.ok) throw new Error('request failed');
        // Record what the server now holds BEFORE hiding, so the chip counts and any later filter
        // pass agree with reality rather than with what was on screen a moment ago.
        row.setAttribute('data-status', String(newStatus).toLowerCase());
        if (String(newStatus).toLowerCase() === 'dismissed') toRestore(form);
        collapseRow(row, function(){ if (sec) refreshCounts(sec); });
      })
      // Anything unexpected falls back to the ordinary submit, so an action never silently no-ops.
      .catch(function(){ form.submit(); });
  });
})();

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
  var imp = document.getElementById('dismissImpact');
  imp.hidden = true; imp.innerHTML = '';
  document.getElementById('dismissOverlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  setTimeout(function(){ document.getElementById('dismissReason').focus(); }, 40);

  // Say what else goes with it, BEFORE the click. A job is rarely alone — it has follow-ups you
  // promised yourself, messages, people. Dismissing it silently left those follow-ups open against
  // a dead job, which is how a to-do list fills with things that cannot be done.
  //
  // Fetched per-record rather than estimated, and the dialog stays usable if the lookup fails —
  // a preview must never block the action it precedes.
  fetch('/dismiss-impact?id=' + encodeURIComponent(id))
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      if (!d) return;
      var bits = [];
      if (d.tasks) bits.push('<b>' + d.tasks + ' open task' + (d.tasks === 1 ? '' : 's') + '</b> will be dismissed too');
      var kept = [];
      if (d.messages) kept.push(d.messages + ' message' + (d.messages === 1 ? '' : 's'));
      if (d.contacts) kept.push(d.contacts + ' contact' + (d.contacts === 1 ? '' : 's') + ' at this company');
      // Naming what is KEPT matters as much as what is removed: it is a deliberate choice, not an
      // oversight. A message still happened, and a person you met through a role you passed on is
      // still in your network.
      if (kept.length) bits.push(kept.join(' and ') + ' stay, as history');
      if (!bits.length) return;
      imp.innerHTML = bits.join('. ') + '.';
      imp.hidden = false;
    })
    .catch(function(){ /* preview unavailable — the dismissal itself still works */ });
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

/* Setup's sub-panes. Same shape as the tab strip below, one level down and scoped to Settings.
   The server has already chosen the pane from ?sub=, so this only handles clicking — and stamping
   the current pane onto every POST, so a save returns to the pane it was made from. */
(function(){
  var strip=document.querySelector('.subtabs');
  if(!strip) return;
  var pills=Array.prototype.slice.call(strip.querySelectorAll('.subpill'));
  var panes=Array.prototype.slice.call(document.querySelectorAll('.subpane'));
  var blurb=document.querySelector('.subblurb');
  var stamp=document.getElementById('cfg_sub');
  function show(id){
    pills.forEach(function(b){
      var on=b.getAttribute('data-sub')===id;
      b.classList.toggle('on',on); b.setAttribute('aria-selected',on?'true':'false');
      if(on && blurb) blurb.textContent=b.getAttribute('data-blurb')||'';
    });
    panes.forEach(function(p){
      var on=p.getAttribute('data-sub')===id;
      /* The hidden Spend pane must STAY hidden: its inputs still submit, which is the point. */
      if(p.getAttribute('data-sub')==='spend' && !pills.some(function(b){return b.getAttribute('data-sub')==='spend';})) return;
      p.classList.toggle('on',on);
      if(on){ p.removeAttribute('hidden'); } else { p.setAttribute('hidden',''); }
    });
    if(stamp) stamp.value=id;
    var u=new URL(location.href); u.searchParams.set('sub',id); history.replaceState(null,'',u);
  }
  pills.forEach(function(b){
    b.addEventListener('click', function(){ show(b.getAttribute('data-sub')); });
  });
})();

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
    /* The Setup sub-pane, on the same principle: a re-check from System checks must come back to
       System checks, not to Roles. Absent on the work page, where there are no sub-panes. */
    var subOn=document.querySelector('.subpill.on');
    var curSub=subOn ? subOn.getAttribute('data-sub') : '';
    ['_tab','_page','_sub'].forEach(function(n){
      if(n==='_sub' && !curSub) return;
      var ex=f.querySelector('input[name="'+n+'"]');
      if(!ex){ ex=document.createElement('input'); ex.type='hidden'; ex.name=n; f.appendChild(ex); }
      ex.value = n==='_tab' ? cur : (n==='_page' ? PAGE : curSub);
    });
    // Remember where you were reading. Every one of these actions is a POST -> 303 -> full reload,
    // so dismissing the ninth follow-up threw you back to the top of the page and you had to scroll
    // down and find your place again — for an action whose whole point is to work through a list.
    // Same instinct as the _tab stamp above: an action should return you where you were, not to the
    // beginning. sessionStorage rather than a URL param so it survives the redirect without putting
    // scroll state in a shareable link.
    try{ sessionStorage.setItem('js_scroll', JSON.stringify({p:location.pathname, y:window.scrollY})); }catch(err){}
  }, true);

  // Restore it, once. Consumed immediately so an ordinary reload or a fresh visit still starts at
  // the top — this only ever fires on the hop back from a POST.
  try{
    var saved=sessionStorage.getItem('js_scroll');
    if(saved){
      sessionStorage.removeItem('js_scroll');
      var s=JSON.parse(saved);
      // Only on the same page, and only if the row we removed has not made the document shorter
      // than the offset we saved — clamped rather than skipped, so a short page lands at its end.
      if(s && s.p===location.pathname && s.y>0){
        // On 'load', not requestAnimationFrame. rAF fires after the first paint but before tables
        // this size have finished laying out, so scrollHeight was still small and the clamp below
        // collapsed the target to roughly zero — the restore ran and silently did nothing.
        // 'load' waits for layout to settle, and the clamp is then measuring the real page.
        var restore=function(){
          var max=Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          window.scrollTo(0, Math.min(s.y, max));
        };
        if(document.readyState==='complete') restore();
        else window.addEventListener('load', restore);
      }
    }
  }catch(err){}
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

// Chip fields: edit a comma-separated setting as a list of discrete values.
//
// The hidden input is the only thing that posts, and it holds exactly the string the form always
// held — so nothing downstream knows this changed. Everything here is about making the value
// visible and hard to corrupt.
(function(){
  var fields = Array.prototype.slice.call(document.querySelectorAll('.chipfield'));
  if (!fields.length) return;

  // Same normalisation the rest of the app uses to decide two names are the same thing. It is what
  // stops "Fintech" and "fintech" both being added — the exact split this tracker already has in
  // its data, where each spelling accumulated its own proposals.
  function key(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  fields.forEach(function(field){
    var box = field.querySelector('.chipbox');
    var input = field.querySelector('.chipin');
    var hidden = field.querySelector('input[type=hidden]');
    // Per-field, decided server-side from the stored value — see chipsFieldHTML. Locations use
    // semicolons because a single entry ("Dubai, UAE") contains a comma.
    var SEP = field.getAttribute('data-sep') || ',';
    // What may separate a pasted list, which is not always what we write back — see chipsFieldHTML.
    var SPLIT = field.getAttribute('data-split') || SEP;
    // Only , and ; are ever used, and both are literal inside a character class, so this needs no
    // escaping — which matters, because this script lives inside a template literal and a $ here
    // would be interpolated by the page that carries it.
    var SPLIT_RE = new RegExp('[' + SPLIT + ']');

    function values(){
      return Array.prototype.slice.call(box.querySelectorAll('.chip')).map(function(c){
        return c.getAttribute('data-v');
      });
    }
    function sync(){ hidden.value = values().join(SEP + ' '); }

    function add(raw){
      // A pasted "a, b, c" becomes three chips rather than one nonsense value — pasting a list into
      // a list field is the obvious thing to try.
      var parts = String(raw).split(SPLIT_RE).map(function(s){ return s.trim(); }).filter(Boolean);
      var existing = values().map(key);
      parts.forEach(function(p){
        if (existing.indexOf(key(p)) !== -1) return;   // already there, in some spelling
        existing.push(key(p));
        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.setAttribute('data-v', p);
        chip.textContent = p;
        var x = document.createElement('button');
        x.type = 'button'; x.className = 'chipx'; x.textContent = '×';
        x.setAttribute('aria-label', 'Remove ' + p);
        x.tabIndex = -1;
        chip.appendChild(x);
        box.insertBefore(chip, input);
      });
      input.value = '';
      sync();
    }

    input.addEventListener('keydown', function(e){
      if (e.key === 'Enter' || SPLIT.indexOf(e.key) !== -1) { e.preventDefault(); if (input.value.trim()) add(input.value); }
      // Backspace on an empty box removes the last chip — standard for this control, and quicker
      // than aiming for a small ×.
      else if (e.key === 'Backspace' && !input.value) {
        var last = box.querySelectorAll('.chip');
        if (last.length) { last[last.length - 1].remove(); sync(); }
      }
    });
    // Picking from the datalist fires input, not keydown, so commit on that too.
    input.addEventListener('input', function(){
      if (input.value.indexOf(SEP) !== -1) add(input.value);
    });
    input.addEventListener('change', function(){ if (input.value.trim()) add(input.value); });
    // Losing focus with text still typed must not silently discard it.
    input.addEventListener('blur', function(){ if (input.value.trim()) add(input.value); });
    box.addEventListener('click', function(e){
      if (e.target.classList.contains('chipx')) { e.target.parentNode.remove(); sync(); }
      else if (e.target === box) input.focus();
    });
    sync();
  });
})();

// Dropping a target market: confirm, with the count, before it takes anything with it.
//
// Editing criteria used to be silent about the past — it changed what the scout looks for next time
// and left everything already found in place, so dropping a vertical left its roles sitting in the
// dashboard being aged and counted. Now the save says what it will clear, and only clears it if
// you agree. Async because the count is real (fetched for the exact market list being saved), so
// the submit is deferred until the answer is back.
(function(){
  var form = document.getElementById('criteriaform');
  if (!form) return;
  var confirmed = false;
  form.addEventListener('submit', function(e){
    if (confirmed) return;                       // second pass, after the user said yes
    var markets = (form.querySelector('input[name=markets]') || {}).value || '';
    e.preventDefault();
    fetch('/criteria-impact?markets=' + encodeURIComponent(markets))
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        // Nothing being dropped, or nothing to clear: save without interrupting.
        if (!d || !d.removed.length || !d.proposals) return true;
        var per = Object.keys(d.byMarket).map(function(m){ return d.byMarket[m] + ' from ' + m; }).join(', ');
        return uiConfirm({
          title: 'Removing ' + d.removed.join(', ') + ' from your target markets',
          ok: 'Save anyway',
          danger: true,
          body: 'This will also dismiss ' + d.proposals + ' open role' + (d.proposals === 1 ? '' : 's') +
            ' you have not acted on (' + per + ').\\n\\n' +
            'Applications and leads you already acted on are kept, and so is the vendor research for ' +
            'that market. Dismissed roles can be restored from the Dismissed filter.'
        });
      })
      .then(function(go){
        if (go === false) return;                // cancelled: criteria unchanged
        confirmed = true;
        form.submit();
      })
      // If the preview cannot be reached, save anyway rather than trapping the user in a form that
      // will not submit.
      .catch(function(){ confirmed = true; form.submit(); });
  });
})();

// Weight sliders (Settings > Advanced). The sliders are the visible control; the values that
// actually POST are the hidden inputs inside the criteria form, because /save-criteria rewrites the
// whole of criteria.md and would blank any field that was not submitted.
//
// Percentages shown are each weight's SHARE of the total, so the three always read as 100% between
// them. That is what the scorer actually does with them — showing raw 0.4/0.35/0.25 invited people
// to make them sum to 1 by hand, which was never required.
(function(){
  var sliders = Array.prototype.slice.call(document.querySelectorAll('.wslider'));
  if(!sliders.length) return;
  function apply(){
    var total = 0;
    sliders.forEach(function(s){ total += Number(s.value)||0; });
    sliders.forEach(function(s){
      var k = s.getAttribute('data-for');
      var raw = Number(s.value)||0;
      var pct = total > 0 ? Math.round(raw/total*100) : 0;
      var out = document.querySelector('[data-pct="'+k+'"]');
      if(out) out.textContent = total > 0 ? pct+'%' : '—';
      // Store the normalised fraction, so what is saved is independent of where the sliders sit.
      var hidden = document.getElementById('h_'+k);
      if(hidden) hidden.value = total > 0 ? (raw/total).toFixed(3) : '0';
    });
    var note = document.getElementById('wnote');
    if(note && total === 0) note.innerHTML = 'All three at zero would score every role the same — raise at least one.';
  }
  sliders.forEach(function(s){ s.addEventListener('input', apply); });
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

// Tasks: Due/Open/Done/Dismissed/All chips + text search. Lives inside Today now (the standalone
// Tasks tab was this same five-column table filtered differently). "Due" filters on data-due, which
// is stamped server-side, so one table serves every chip instead of rendering two that can drift.
(function(){
  var sec=document.querySelector('.sec[data-id="today"]');
  if(!sec) return;
  // .taskblock, not .tblock — the advances block is also a .tblock and comes first, so selecting on
  // the shared class silently bound the filter to a table with no rows and nothing ever filtered.
  var wrap=sec.querySelector('.taskblock');
  if(!wrap) return;
  var rows=function(){return Array.prototype.slice.call(wrap.querySelectorAll('tbody tr'));};
  var start=wrap.querySelector('.tf.active');
  var filter=start?start.getAttribute('data-f'):'open', q='';
  function apply(){
    rows().forEach(function(tr){
      var st=tr.getAttribute('data-status')||'';
      var okF=(filter==='all')?true
        :(filter==='due')?tr.getAttribute('data-due')==='yes'
        :(filter==='stale')?tr.getAttribute('data-stale')==='yes'
        :st===filter;
      var okQ=!q||(tr.textContent||'').toLowerCase().indexOf(q)>=0;
      tr.style.display=(okF&&okQ)?'':'none';
    });
  }
  wrap.querySelectorAll('.tf').forEach(function(b){
    b.addEventListener('click', function(){
      // Scoped to the tasks block, not the whole Today section — Today also carries the approvals
      // and advances blocks, and clearing .active across all of them would fight those controls.
      wrap.querySelectorAll('.tf').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active'); filter=b.getAttribute('data-f'); apply();
    });
  });
  var s=wrap.querySelector('.tsearch');
  if(s) s.addEventListener('input', function(){ q=s.value.toLowerCase().trim(); apply(); });
  apply();
})();

// People: one search box across the contact cards.
(function(){
  var sec=document.querySelector('.sec[data-id="people"]');
  if(!sec) return;
  var cards=Array.prototype.slice.call(sec.querySelectorAll('details.person'));
  var s=sec.querySelector('.psearch2');
  var out=sec.querySelector('.pmatch');
  if(!s) return;
  s.addEventListener('input', function(){
    var q=s.value.toLowerCase().trim();
    var shown=0;
    cards.forEach(function(c){
      // The orphan block has no data-q; keep it out of search results rather than always showing it.
      var hay=c.getAttribute('data-q');
      var vis=!q||(hay!==null&&hay.indexOf(q)>=0);
      c.hidden=!vis;
      if(vis&&hay!==null) shown++;
      if(q&&vis&&hay!==null) c.open=true;
      if(!q) c.open=false;
    });
    if(out) out.textContent=q?(shown+' matching'):'';
  });
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

// Pipeline section: Active / Leads / Applications / <stages> / Dismissed / All + search.
// Default = Active (hides dismissed). The Leads and Applications chips filter on data-kind rather
// than data-status, because kind and stage are independent — a lead can be at "Screening" too.
(function(){
  var sec=document.querySelector('.sec[data-id="pipeline"]');
  if(!sec) return;
  var rows=function(){return Array.prototype.slice.call(sec.querySelectorAll('tbody tr'));};
  var filter='active', q='';
  function apply(){
    rows().forEach(function(tr){
      var st=tr.getAttribute('data-status')||'';
      var kd=tr.getAttribute('data-kind')||'';
      var okF;
      if(filter==='all') okF=true;
      else if(filter==='active') okF=(st!=='dismissed');
      else if(filter==='lead'||filter==='application') okF=(kd===filter && st!=='dismissed');
      else okF=(st===filter);
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
function redirect(res, flash, extra = "") {
  const parts = [];
  if (flash) {
    parts.push(`flash=${encodeURIComponent(flash.kind)}`, `msg=${encodeURIComponent(flash.msg)}`);
  }
  if (extra) parts.push(extra);
  if (res._returnTab) parts.push(`tab=${encodeURIComponent(res._returnTab)}`);
  // Settings' sub-panes are a second axis: without this, saving from Channels lands you back on
  // Roles and you have to find your way to what you just changed.
  if (res._returnSub) parts.push(`sub=${encodeURIComponent(res._returnSub)}`);
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
    platform.spawnNodeDetached("scripts/discover-board.mjs", [company, market]);
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
  "schedule_days",
  "min_hours_between_runs",
  "dashboard_port",
  "approval_channels",
  "whatsapp_owner_jid",
  "apply_stop_before",
  "whatsapp_web_enabled",
  "linkedin_enabled",
  "linkedin_open_tab",
  "ignored_chats",
  "company_aliases",
  "max_spend_per_run_usd",
  "max_spend_per_month_usd",
];

/**
 * Rewrite config frontmatter IN PLACE, changing only the values whose keys changed.
 *
 * `stringifyFrontmatter` rebuilds the block from a plain object, so every `#` comment vanishes —
 * parseFrontmatter never captured them in the first place. That is fine for `data/` records, which
 * have no comments, but config/job-seeker.config.md is the one file here that is DOCUMENTED in
 * comments: it is seeded from the .example, which explains what each setting does and what it costs
 * (the linkedin_open_tab note about marking a conversation read, for one). Saving once from the
 * dashboard silently deleted all of it — measured: 10 comment lines gone in a single round-trip.
 *
 * So this edits lines rather than regenerating them. Comments, blank lines, key order, the body, and
 * any key the dashboard does not manage all survive byte-for-byte; only the value after `key:`
 * changes, and genuinely new keys are appended just before the closing `---`.
 *
 * Not folded into stringifyFrontmatter itself: that is on record.mjs's write path for every record
 * in data/, and this problem does not exist there.
 */
function rewriteConfigPreservingComments(existing, merged) {
  const src = String(existing ?? "");
  const lines = src.split("\n");
  const open = lines.findIndex((l) => l.trim() === "---");
  const close = open >= 0 ? lines.findIndex((l, i) => i > open && l.trim() === "---") : -1;
  // No usable frontmatter (a fresh or hand-broken file) — fall back to generating it wholesale.
  if (open < 0 || close < 0) return stringifyFrontmatter(merged, "", Object.keys(merged));

  const seen = new Set();
  for (let i = open + 1; i < close; i++) {
    const m = /^([A-Za-z0-9_]+):/.exec(lines[i]);
    if (!m) continue; // comment, blank line, or continuation — leave exactly as it is
    const key = m[1];
    if (!(key in merged)) continue;
    seen.add(key);
    const v = merged[key] ?? "";
    // Preserve the "key:" with no trailing space when the value is blank, matching how the example
    // file writes an unset key.
    lines[i] = String(v).length ? `${key}: ${v}` : `${key}:`;
  }

  const added = Object.keys(merged).filter((k) => !seen.has(k));
  if (added.length) {
    lines.splice(close, 0, ...added.map((k) => (String(merged[k] ?? "").length ? `${k}: ${merged[k]}` : `${k}:`)));
  }
  return lines.join("\n");
}

async function handleSaveConfig(form) {
  const file = path.join(ROOT, "config", "job-seeker.config.md");
  const existing = await safeRead(file);
  const { data, body } = parseFrontmatter(existing);
  const merged = { ...data };
  // Toggles first. `_bools` names the checkbox-backed keys this particular form governs, which is
  // the only way to tell "the user switched it off" (absent) from "this form does not contain that
  // field" (also absent) — and getting that wrong would mean a switch you turn off silently turns
  // itself back on. Only keys that are BOTH declared here and in CONFIG_KEYS are honoured, so a
  // crafted request cannot use `_bools` to write arbitrary config.
  const declaredBools = String(form._bools ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && CONFIG_KEYS.includes(s));
  for (const k of declaredBools) merged[k] = k in form ? "true" : "false";

  for (const k of CONFIG_KEYS) {
    if (declaredBools.includes(k)) continue; // already resolved above
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
  await writeFileAtomic(file, rewriteConfigPreservingComments(existing, merged));
  // Include the toggles even when switched OFF — those are absent from the form by definition, so
  // filtering on `k in form` alone would log every switch-off as if nothing had changed.
  const touched = [...new Set([...CONFIG_KEYS.filter((k) => k in form), ...declaredBools])];
  await logActivity("config-edit", `Updated settings: ${touched.join(", ")}`);
}

// =================================================================================================
// THE WELCOME WIZARD
// =================================================================================================
//
// Everything JobSeeker does used to be behind a terminal: clone, `npm run setup`, `claude`, then a
// slash command. This is the same setup with a face on it — seven steps, three of them skippable,
// each writing the SAME files /onboard writes. It is a face, not a new source of truth: criteria,
// the answer library and the config remain the only record of what you chose, so the wizard and
// /onboard can be used interchangeably and neither can drift from the other.
//
// Deliberately server-rendered, one form POST per step. A client-side wizard would hold your
// answers in memory until a final Save, which means closing the window at step 5 loses steps 1-4.
// Here each step is written the moment you leave it, so a wizard abandoned halfway is simply a
// setup that is halfway done — which is exactly what Settings then offers to finish.

// Every step this wizard can RENDER. `flow: false` means it is reachable on its own
// (/setup-step?step=answers) but is not part of the first-run walk: the wizard asks the few things
// nothing works without, and Settings holds the rest.
//
// Steps are addressed BY KEY, never by index. The flow and the full set deliberately diverge, so an
// index into one is meaningless in the other — which is why the version that passed `ix` everywhere
// could not have had both.
const WELCOME_STEPS = [
  { key: "start",     label: "Start" },
  { key: "cv",        label: "CV",         skippable: true },
  { key: "chrome",    label: "Chrome" },
  { key: "markets",   label: "Industries", skippable: true },
  { key: "roles",     label: "Function" },
  { key: "seniority", label: "Seniority" },
  { key: "locations", label: "Location" },
  { key: "finish",    label: "Finish" },
  { key: "answers",   label: "Answers",  skippable: true, flow: false },
  { key: "channels",  label: "Channels", flow: false },
];
const WIZARD_FLOW = WELCOME_STEPS.filter((x) => x.flow !== false).map((x) => x.key);

// The four questions that fill data/criteria.md, one per screen. Every one is the same control over
// a different field, so the differences live here as data and the renderer stays one block.
//
// `sep` matters on locations: chipsFieldHTML otherwise infers the separator from the STORED value,
// so on a fresh install "Dubai, UAE" typed as one place is stored comma-separated and read back as
// two. Naming the separator is what stops a first-run user's one location becoming two.
const FUNCTION_SUGGESTIONS = [
  "Product Management",
  "Presales / Solutions Engineering",
  "Solution Architecture",
  "Customer Success",
  "Sales",
  "Engineering Leadership",
  "Program / Delivery Management",
  "Consulting",
];
const SENIORITY_SUGGESTIONS = ["Senior", "Principal", "Lead", "Head of", "Director", "VP", "C-level"];

// How often the run fires. One table, because the wizard, the handler and the ladder all have to
// agree on what "twice a week" means, and three copies of that would not stay in step.
//
// `days` is what scripts/set-schedule.sh takes: a comma list of weekdays, 0 = Sunday, empty = every
// day. launchd has no "every N days" field — it schedules by weekday — so "every other day" is the
// daily plist plus `min_hours` , which scripts/job-run.sh checks and skips on before it does
// anything expensive or wakes the display.
const CADENCE = new Map([
  ["daily", { label: "Every day", days: "" }],
  ["alt", { label: "Every other day", days: "", minHours: 40 }],
  ["weekdays", { label: "Weekdays — Monday to Friday", days: "1,2,3,4,5" }],
  ["twice", { label: "Twice a week — Monday and Thursday", days: "1,4" }],
  ["weekly", { label: "Once a week", days: null, pickDay: true }],
  ["custom", { label: "Specific days…", days: null, pickDays: true }],
  ["off", { label: "Only when I ask", days: null, off: true }],
]);

// Read the installed schedule back as a cadence, so the wizard opens on what is actually set rather
// than on a default that silently disagrees with the plist.
function currentCadence(st) {
  if (!st.scheduled) return { key: "off", weekday: "1" };
  const days = String(st.schedDays || "").split(",").filter(Boolean).sort().join(",");
  if (!days) return { key: String(st.cfg.min_hours_between_runs || "").trim() ? "alt" : "daily", weekday: "1" };
  for (const [k, v] of CADENCE) {
    if (v.days && v.days.split(",").sort().join(",") === days) return { key: k, weekday: "1" };
  }
  if (days.split(",").length === 1) return { key: "weekly", weekday: days };
  return { key: "custom", weekday: "1" };
}

const CRITERIA_STEPS = {
  markets: {
    field: "markets",
    label: "Industries",
    cvField: "domains",
    heading: "Which industries should it hunt in?",
    sub: "An industry is a market to research. JobSeeker builds a ranked list of the companies in it worth your time, then watches their careers pages.",
    placeholder: "add an industry…",
    note:
      "Adding one costs nothing. Researching it — ranking the companies in it — is a few minutes of " +
      "work, so JobSeeker asks you about that once you are inside rather than holding up setup.",
    foot: {
      skipLabel: "Skip this for now",
      skipNote:
        "Skipping means no company list yet, so role hunting has nowhere to look — Today stays empty " +
        "until you add one. Settings runs this same step whenever you are ready.",
    },
  },
  roles: {
    field: "roles",
    label: "Function",
    cvField: "titles",
    suggestions: FUNCTION_SUGGESTIONS,
    heading: "What do you actually do?",
    sub: "The function you want to work in — broader than a job title, because titles for the same job differ at every company.",
    subFromCV: true,
    placeholder: "add a function…",
  },
  seniority: {
    field: "seniority",
    label: "Seniority",
    cvField: "seniority",
    suggestions: SENIORITY_SUGGESTIONS,
    heading: "At what level?",
    sub: "Pick every level you would take. Too narrow and good roles are filtered out before you see them.",
    subFromCV: true,
    placeholder: "add a level…",
  },
  locations: {
    field: "locations",
    label: "Location",
    cvField: "locations",
    sep: ";",
    heading: "Where?",
    sub: "Cities, countries, or Remote. Separated by semicolons, because a city and its country are not two places.",
    subFromCV: true,
    placeholder: "add a location…",
    note: "How roles get scored — market 0.40, role 0.35, CV match 0.25. Change the balance in Settings once you have seen a few.",
  },
};
const stepDef = (key) => WELCOME_STEPS.find((x) => x.key === key);
const flowIndex = (key) => WIZARD_FLOW.indexOf(key);

const ANSWERS_FILE = path.join(ROOT, "templates", "answers.md");
const CV_STATUS_FILE = path.join(DATA, ".cv-parse.status.json");

// The lists behind step 5. These questions are asked from a fixed set by every form that asks them
// at all, so they are lists to pick from — typing them invites typos an agent must then interpret.
// Every list ends in an escape hatch: a closed list you cannot get out of is software telling
// someone their situation is invalid.
const ANSWER_FIELDS = [
  {
    key: "visa",
    row: "work authorization / visa",
    label: "Work authorisation",
    opts: [
      "Citizen — no sponsorship needed",
      "Permanent resident",
      "Residence visa — transferable",
      "Residence visa — not transferable",
      "Would need sponsorship",
      "Student or graduate visa",
    ],
  },
  {
    key: "notice",
    row: "notice period",
    label: "Notice period",
    opts: ["Available immediately", "2 weeks", "1 month", "2 months", "3 months", "Longer — negotiable"],
  },
  {
    key: "relocate",
    row: "willing to relocate",
    label: "Willing to relocate",
    opts: ["Yes — anywhere", "Yes — within the region", "Yes, for the right role", "No — remote or local only"],
  },
  {
    key: "heard",
    row: "how did you hear about us",
    label: "How did you hear about us",
    opts: ["LinkedIn", "The company website", "A referral", "A job board", "A recruiter"],
  },
];

// Salary is the one answer nobody else can shape for you: a list of bands would either anchor you
// low or make you commit to a number you have not decided on. It stays a blank line, and so does
// the summary, which goes out in your name.
const ANSWER_FREE = [
  { key: "salary", row: "salary expectation", label: "Salary expectation", placeholder: "open — happy to discuss" },
];

async function readAnswers() {
  const text = await safeRead(ANSWERS_FILE);
  const out = { pitch: "" };
  for (const f of [...ANSWER_FIELDS, ...ANSWER_FREE]) {
    const re = new RegExp(`^\\|\\s*${f.row.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|\\s*(.*?)\\s*\\|`, "im");
    const m = re.exec(text);
    out[f.key] = m ? m[1].trim() : "";
  }
  // The pitch is whatever prose follows the table.
  const after = text.split(/\n\s*\n/).filter((b) => !b.includes("|") && !b.startsWith("#"));
  out.pitch = (after.pop() || "").trim();
  return out;
}

async function writeAnswers(form) {
  const rows = [];
  for (const f of [...ANSWER_FIELDS, ...ANSWER_FREE]) {
    // "Something else" swaps the list for a free field; the typed value is the answer, and which
    // control produced it is not worth recording.
    const raw = String(form[f.key] ?? "").trim();
    const val = raw === "__other" ? String(form[`${f.key}_other`] ?? "").trim() : raw;
    if (val) rows.push(`| ${f.row} | ${sanitizeCell(val)} |`);
  }
  const pitch = String(form.pitch ?? "").trim();
  const text =
    "# Application answer library\n\n" +
    "| question_pattern | answer |\n|------------------|--------|\n" +
    (rows.length ? rows.join("\n") + "\n" : "") +
    (pitch ? `\n${pitch}\n` : "");
  await fs.mkdir(path.dirname(ANSWERS_FILE), { recursive: true });
  await writeFileAtomic(ANSWERS_FILE, text);
  await logActivity("onboard", `Answer library saved (${rows.length} answer${rows.length === 1 ? "" : "s"})`);
}

// Merge a few keys into criteria.md, leaving the rest — and the notes body — exactly as they were.
// handleSaveCriteria rewrites the whole frontmatter from one big form; the wizard fills it in over
// two separate steps, so a whole-file write from either would blank what the other had just saved.
async function mergeCriteria(fields) {
  const file = path.join(DATA, "criteria.md");
  const { data, body } = parseFrontmatter(await safeRead(file));
  const keys = ["markets", "roles", "locations", "seniority", "weight_market", "weight_role", "weight_cv"];
  const merged = { ...data, ...fields };
  // Weights are never asked for during setup — nobody can tune them before seeing a single score —
  // so the documented defaults are seeded once and Settings owns them from then on.
  if (!merged.weight_market) merged.weight_market = "0.4";
  if (!merged.weight_role) merged.weight_role = "0.35";
  if (!merged.weight_cv) merged.weight_cv = "0.25";
  const out = {};
  for (const k of keys) out[k] = String(merged[k] ?? "").trim();
  await fs.mkdir(DATA, { recursive: true });
  await writeFileAtomic(file, stringifyFrontmatter(out, body || "# Notes\n", keys));
  return out;
}

async function readConfigRaw() {
  const file = path.join(ROOT, "config", "job-seeker.config.md");
  const existing = await safeRead(file);
  return { file, existing, data: parseFrontmatter(existing).data || {} };
}

// Write config keys the settings form does not own (the wizard's own bookkeeping), preserving the
// comments that document the file.
async function mergeConfig(fields) {
  const { file, existing, data } = await readConfigRaw();
  const merged = { ...data };
  for (const [k, v] of Object.entries(fields)) merged[k] = sanitizeCell(String(v ?? "").trim());
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, rewriteConfigPreservingComments(existing, merged));
  return merged;
}

// What is actually set up, read from the files themselves rather than from a progress counter.
// A wizard that remembered "you did step 3" would disagree with the files the moment anything was
// edited elsewhere — and /onboard, the dashboard and a text editor can all edit them.
async function welcomeState({ schedule = false } = {}) {
  const { existing: cfgRaw, data: cfg } = await readConfigRaw();
  const criteria = parseFrontmatter(await safeRead(path.join(DATA, "criteria.md"))).data || {};
  const profileText = await safeRead(path.join(DATA, "profile.md"));
  const profile = parseFrontmatter(profileText).data || {};
  let cvFiles = [];
  try {
    cvFiles = (await fs.readdir(CV_DIR)).filter((f) => f.toLowerCase().endsWith(".pdf"));
  } catch {
    /* nothing uploaded yet */
  }
  let cvStatus = null;
  try {
    cvStatus = JSON.parse(await fs.readFile(CV_STATUS_FILE, "utf8"));
  } catch {
    /* never parsed */
  }
  const answers = await readAnswers();
  // Reading the schedule means running the OS scheduler's reader, so it happens only on the step
  // that shows it — not on every dashboard load.
  const schedRaw = schedule ? (await platform.scheduleShow()).trim() : "";
  const [schedTime, schedDays] = schedRaw.split(/\s+/);
  return {
    cfg,
    criteria,
    // The parsed CV itself, not merely whether there is one: welcomeProfileRows renders these
    // fields, and without them here it rendered an empty box on every successful parse — the step
    // said "Read by Claude" and then showed nothing it had read.
    profile,
    profileParsed: Boolean(String(profile.titles || "").trim()) && !/No CV parsed yet/i.test(profileText),
    cvFiles,
    cvStatus,
    answers,
    answered: Boolean(answers.visa || answers.notice || answers.relocate || answers.salary || answers.pitch),
    scheduled: /^\d\d:\d\d$/.test(schedTime || ""),
    schedTime: /^\d\d:\d\d$/.test(schedTime || "") ? schedTime : "08:00",
    schedDays: schedDays || "",
    skipped: String(cfg.welcome_skipped || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    done: Boolean(String(cfg.welcome_done || "").trim()),
    // Whether the config FILE exists at all, as opposed to what is in it. A half-installed machine —
    // criteria filled in, no config written — is a different case from a fresh one, and only the
    // caller routing a first visit needs to tell them apart.
    cfgPresent: Boolean(cfgRaw),
  };
}

// Someone who has never been set up should not land on an empty dashboard and be left to find the
// wizard. Someone who HAS — including every existing install, which predates the wizard entirely —
// must never be redirected away from their own data, so an existing criteria file counts as done.
function needsWelcome(st) {
  if (st.done || String(st.cfg.welcome_left || "").trim()) return false;
  return !String(st.criteria.markets || "").trim() && !String(st.criteria.roles || "").trim();
}

// ---- rendering -----------------------------------------------------------------------------

// How far in you are, as a bar rather than a rail of seven numbered pills. The rail spent a strip of
// the screen restating the whole flow on every screen; the bar answers the only question actually
// being asked — how much is left.
//
// "start" is an introduction, not a question, so it does not count towards the total: a wizard that
// claims you are 12% done before you have answered anything is measuring itself, not your progress.
function welcomeProgress(key) {
  const asked = WIZARD_FLOW.slice(1);
  const pos = asked.indexOf(key);
  const pct = pos < 0 ? 0 : Math.round(((pos + 1) / asked.length) * 100);
  const label = pos < 0 ? "" : `Step ${pos + 1} of ${asked.length} — ${esc((stepDef(key) || {}).label || "")}`;
  return `<div class="wprogress" role="progressbar" aria-label="Setup progress"
      aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
      <div class="wprogress-track"><i style="width:${pct}%"></i></div>
      ${label ? `<p class="wprogress-label">${label}</p>` : ""}
    </div>`;
}

// "I would rather use the terminal" used to be a paragraph saying to run /onboard, which left the
// reader to work out what came after it. These are the commands, in the order they are meant to be
// run, each one copyable — because a command you retype from a screenshot is a command you mistype.
//
// A modal rather than the .pop popover: this is a list to work through with a terminal open beside
// it, not a one-line aside, and a popover closes the moment you click away to the terminal.
const TERMINAL_STEPS = [
  ["/onboard", "The same questions this wizard asks, in chat. Writes the same files."],
  ["/parse-cv", "Reads templates/cv/*.pdf into data/profile.md, so roles are scored against you."],
  ["/markets", "Researches and ranks the companies in each industry you named."],
  ["/curate", "Finds live openings at those companies and scores them."],
  ["/job-run", "The whole daily pipeline, whenever you want it. Queues approvals; sends nothing."],
];

const COPY_GLYPH = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
  stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="5.5" y="5.5" width="8" height="8" rx="1.5"></rect>
  <path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5v5.5a1.5 1.5 0 0 0 1.5 1.5h2"></path>
</svg>`;

function terminalModal() {
  return `<div id="w_term" class="overlay wterm" role="dialog" aria-modal="true" aria-labelledby="w_term_h">
    <div class="modal">
      <button class="mclose" type="button" onclick="termClose()" aria-label="Close">&times;</button>
      <h3 id="w_term_h">Set it up in the terminal instead</h3>
      <p class="muted wterm-sub">Open Claude Code in this folder, then run these in order. They ask the
        same questions and write the same files as the wizard, so you can switch between the two at
        any point.</p>
      <ol class="wterm-list">
        ${TERMINAL_STEPS.map(
          ([cmd, why]) => `<li>
            <div class="wterm-cmd">
              <code>${esc(cmd)}</code>
              <button type="button" class="copybtn" data-copy="${esc(cmd)}"
                aria-label="Copy ${esc(cmd)}" title="Copy">${COPY_GLYPH}<span class="copied">Copied</span></button>
            </div>
            <p class="wterm-why">${esc(why)}</p>
          </li>`
        ).join("")}
      </ol>
      <div class="wterm-all">
        <button type="button" class="btn-small copybtn" data-copy="${esc(TERMINAL_STEPS.map((x) => x[0]).join("\n"))}">
          ${COPY_GLYPH} Copy all five</button>
        <span class="muted tiny">Run them one at a time — each one waits for you.</span>
      </div>
      <div class="pop-acts"><button type="button" class="btn-secondary" onclick="termClose()">Back to the wizard</button></div>
    </div>
  </div>`;
}

// Every step ends the same way, so the way out is always in the same place: continue, back, skip
// where skipping is allowed, and leave. Leaving is never punished and never hidden.
function welcomeFoot(key, { nextLabel = "Continue", disable = "", skipLabel = "", skipNote = "", extra = "" } = {}) {
  const step = stepDef(key) || {};
  const ix = flowIndex(key);
  return `<div class="wacts">
      <button type="submit" name="action" value="next"${disable ? ` disabled title="${esc(disable)}"` : ""}>${esc(nextLabel)}</button>
      ${ix > 0 ? `<button type="submit" name="action" value="back" class="btn-secondary" formnovalidate>Back</button>` : ""}
      ${step.skippable && !extra ? `<button type="submit" name="action" value="skip" class="btn-small" formnovalidate>${esc(skipLabel || "Skip for now")}</button>` : ""}
      ${extra}
      <span class="wspacer"></span>
      <button type="submit" name="action" value="leave" class="btn-small" formnovalidate>Leave setup</button>
    </div>
    ${skipNote ? `<p class="wnote">${skipNote}</p>` : ""}`;
}

function answerPick(f, current) {
  const known = f.opts.includes(current);
  const other = Boolean(current) && !known;
  return `<label class="wfield">
    <span class="lbl">${esc(f.label)}</span>
    <select name="${esc(f.key)}" class="winput" data-other="${esc(f.key)}_other">
      <option value=""${current ? "" : " selected"}>Choose…</option>
      ${f.opts.map((o) => `<option${o === current ? " selected" : ""}>${esc(o)}</option>`).join("")}
      <option value="__other"${other ? " selected" : ""}>Something else…</option>
    </select>
    <input type="text" name="${esc(f.key)}_other" class="winput wother${other ? "" : " hide"}"
           value="${esc(other ? current : "")}" placeholder="In your own words">
  </label>`;
}

// The CV card, which is really three cards: nothing yet, working, and a result. The two phases are
// separated because they cost wildly different things — saving the file is instant and local, and
// understanding it is a Claude call that leaves the machine. Collapsing them into one spinner would
// hide both facts.
// A submit button aimed at /pick-cv, not a nested <form>: this card is rendered inside the
// wizard's own form, and a form inside a form is dropped by every browser. formaction carries the
// step and back fields that are already there, so the panel knows which page to come back to.
const PICK_BTN = `<button type="submit" formaction="/pick-cv" formnovalidate class="linkbtn" name="_pick" value="1">`;

function welcomeCVCard(st) {
  const running = st.cvStatus?.state === "running";
  const parsed = st.profileParsed;
  // A failure stands only while it is still the LATEST thing that happened to the CV. Nothing but
  // scripts/parse-cv.sh writes this status file, so `/parse-cv` run from chat — or any other path
  // that fills data/profile.md — leaves the old "failed" behind untouched. Checking the status
  // first meant a perfectly good profile was reported as unreadable for as long as the stale file
  // survived, and the reader's reasonable conclusion was that the CV step is broken.
  const failedAt = Date.parse(st.cvStatus?.finished || "");
  const parsedAt = Date.parse(st.profile?.parsed_at || "");
  const superseded = parsed && (Number.isNaN(failedAt) || (!Number.isNaN(parsedAt) && parsedAt >= failedAt));
  const failed = st.cvStatus?.state === "failed" && !superseded;
  const newest = st.cvFiles.length ? st.cvFiles[st.cvFiles.length - 1] : "";

  if (!st.cvFiles.length) {
    return `<div class="wdrop" id="wdrop">
        <div class="wdrop-big">Drop your CV here</div>
        <div class="muted">PDF · ${
          platform.IS_WIN
            ? `<button type="button" class="linkbtn" id="wpick">or choose a file</button>`
            : `${PICK_BTN}or choose a file</button>`
        }</div>
        ${platform.IS_WIN ? `<input type="file" id="wfile" accept="application/pdf" class="hide">` : ""}
        <div class="wprog hide" id="wupprog"><i></i></div>
      </div>`;
  }

  if (failed) {
    // The time is on screen for one reason: a second file that fails the same way renders a page
    // identical to this one, and the reader concludes the button is broken rather than that the
    // second file failed too. The stamp is the only thing that changes, so it has to be visible.
    const fin = Date.parse(st.cvStatus.finished || "");
    const at = Number.isNaN(fin) ? "" : new Date(fin).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `<div class="alert bad"><strong>That file could not be read.</strong>
        ${esc(st.cvStatus.detail || "")}</div>
      <div class="wcard">
        <div class="wrow"><span class="wok">✓</span><span>Saved on this Mac<em>templates/cv/${esc(newest)}</em></span></div>
        <div class="wrow"><span class="wbad">!</span><span>Claude could not read it${at ? ` · tried ${esc(at)}` : ""}<em>${esc(st.cvStatus.detail || "")}</em></span></div>
      </div>
      <p class="wnote">${
        platform.IS_WIN
          ? `<button type="button" class="linkbtn" id="wreplace">Try another file</button>`
          : `${PICK_BTN}Try another file</button>`
      }</p>
      <div class="wprog hide" id="wupprog"><i class="anim"></i></div>
      ${platform.IS_WIN ? `<input type="file" id="wfile" accept="application/pdf" class="hide">` : ""}`;
  }

  return `<div class="wcard">
      <div class="wrow"><span class="wok">✓</span><span>Saved on this Mac
        <em>templates/cv/${esc(newest)} — the file itself stays here.</em></span></div>
      <div class="wrow"><span class="${running ? "wwait" : "wok"}">${running ? "…" : "✓"}</span><span>
        ${running ? "Claude is reading it" : "Read by Claude"}
        <em>${running
          ? "Half a minute or so. This is the one step that leaves your Mac — your CV is sent to Claude to be understood, the same way everything else here works."
          : "Read by Claude, stored on this Mac. You can change any of it later."}</em>
        ${parsed ? welcomeProfileRows(st) : running ? `<div class="wprog"><i class="anim"></i></div>` : ""}
      </span></div>
    </div>
    ${running ? `<p class="wnote">Nothing here needs you. Walk on and it will be waiting, already filled in, by the time you reach the questions that use it.</p>` : ""}
    <p class="wnote">${
      platform.IS_WIN
        ? `<button type="button" class="linkbtn" id="wreplace">Use a different file</button>`
        : `${PICK_BTN}Use a different file</button>`
    } — or fix any line of it in Settings later.</p>
    ${platform.IS_WIN ? `<input type="file" id="wfile" accept="application/pdf" class="hide">` : ""}`;
}

function welcomeProfileRows(st) {
  const p = st.profile || {};
  const row = (k, v) => (v ? `<div class="wprow"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>` : "");
  return `<div class="wprofile">
    ${row("Titles", p.titles)}
    ${row("Seniority", p.seniority)}
    ${row("Domains", p.domains)}
    ${row("Skills", String(p.skills || "").split(",").slice(0, 8).join(", "))}
  </div>`;
}

function welcomeStepHTML(key, st, mode = {}) {
  const c = st.criteria;
  const solo = Boolean(mode.standalone);

  if (key === "start") {
    return `<h1 class="wh1">JobSeeker remembers your job search.</h1>
      <p class="wsub">It reads the channels you already use, keeps one honest picture of where
        everything stands, and each morning tells you the few things that need you. Three things it
        will never do:</p>
      <div class="wcard">
        <div class="wrow"><span class="pill">never</span><span>Acts for you. It finds, tracks and reminds — applying is yours, and always will be your decision to make.</span></div>
        <div class="wrow"><span class="pill">never</span><span>Sends a message — email, LinkedIn or WhatsApp — without you approving that exact message.</span></div>
        <div class="wrow"><span class="pill">never</span><span>Opens an unread chat, or logs a conversation that has nothing to do with your job search.</span></div>
      </div>
      <p class="wsub">Everything it learns is kept in plain text files on this Mac — no JobSeeker
        account, no JobSeeker server, delete the folder and it is gone. The reading and the judgement
        are done by Claude, so what it reads — your CV, your job-related mail and messages — goes to
        Claude, and nowhere else.</p>
      <div class="wacts">
        <button type="submit" name="action" value="next">Start — a few more steps</button>
        <span class="popwrap">
          <button type="button" class="btn-small" aria-haspopup="dialog" aria-expanded="false"
            onclick="termOpen()">I would rather use the terminal</button>
          ${terminalModal()}
        </span>
        <span class="wspacer"></span>
        <button type="submit" name="action" value="leave" class="btn-small" formnovalidate>Leave setup</button>
      </div>`;
  }

  if (key === "cv") {
    const have = st.cvFiles.length > 0;
    const running = st.cvStatus?.state === "running";
    // Replacing a CV that already worked is a different act from adding the first one, and the
    // things it quietly invalidates are worth saying BEFORE the upload, not discovering later.
    const replacing = solo && st.profileParsed && !st.cvPrevious;
    if (solo) {
      return `<h1 class="wh1">${replacing ? "Replace your CV" : st.profileParsed ? "Your CV" : "Add your CV"}</h1>
        <p class="wsub">${
          replacing
            ? "The new file is read by Claude and replaces what JobSeeker knows about your experience."
            : "The file is saved on this Mac; Claude reads it to work out what it says."
        }</p>
        ${replacing ? `<div class="wcard" style="margin-bottom:12px">
            <p class="th">What JobSeeker knows now <span class="muted">— from ${esc((st.profile || {}).source_cv || "your CV")}</span></p>
            ${welcomeProfileRows(st)}
            <p class="wnote">Reading a new one overwrites this. Two things it does not do:
              roles already proposed keep the score they were given — only future hunts use the new
              CV${st.answers.pitch ? "; and your two-line summary in the answer library was drafted from the OLD CV, so it may now describe a job you have left" : ""}.</p>
          </div>` : ""}
        ${welcomeCVCard(st)}
        ${cvComparisonHTML(st)}
        ${st.cvPrevious && st.answers.pitch ? `<div class="alert warn" style="margin-top:12px">
            <strong>Your two-line summary still describes the old CV.</strong>
            It is used when a form wants a summary about you —
            <a href="/setup-step?step=answers&back=${esc(mode.back || "settings")}">check it now</a>.</div>` : ""}
        ${standaloneFoot(key, mode.back, {
          saveLabel: "Done",
          // A comparison you have seen is a comparison that should stop appearing. Done is how you
          // say so; without it, "what changed" and the stale-summary warning would greet you on
          // every visit for the rest of the year.
          canSave: Boolean(st.cvPrevious),
        })}`;
    }
    return `<h1 class="wh1">${have && st.profileParsed ? "Is this right?" : "Your CV"}</h1>
      <p class="wsub">${
        have
          ? st.profileParsed
            ? "This drives how every role is scored from now on, so it is worth ten seconds."
            : "Saving it is instant. Understanding it is a Claude call — that is the part worth waiting on."
          : "Everything else here can be filled in from it — so this is the one step worth doing now. The file is saved on this Mac; Claude reads it to work out what it says."
      }</p>
      ${welcomeCVCard(st)}
      ${welcomeFoot(key, {
        nextLabel: st.profileParsed ? "That is right" : running ? "Continue — finish this in the background" : "Continue",
        disable: have ? "" : "Drop a CV in first, or skip this step",
        skipLabel: "Skip — I will add it later",
        // Skipping is the one decision here whose cost lands on screens you have not reached yet, so
        // it is spelled out before the skip rather than discovered later. The app's own dialog, not a
        // browser confirm(): that cannot carry a list and reads like the page is broken.
        extra: `<span class="popwrap">
            <button type="button" class="btn-small" aria-haspopup="dialog" aria-expanded="false"
              onclick="popToggle('w_skipcv', this)">Skip — I will add it later</button>
            <div id="w_skipcv" class="pop pop-wide hide" role="dialog" aria-label="Skip your CV">
              <p class="pop-h">Skip your CV?</p>
              <p class="pop-sub">Without it, here is what I will not be able to do:</p>
              <ul class="impact">
                <li>Judge how well a posting matches your experience. Roles are still found and ranked, but on the job title alone, so the ranking is blunter.</li>
                <li>Tell you why a role fits, or where the gap is — the part worth reading before you spend an evening on it.</li>
                <li>Draft the "two lines about you" that most forms ask for.</li>
                <li>Keep your CV to hand, so it is one click away when you sit down to apply.</li>
              </ul>
              <p class="pop-sub">It takes half a minute, and you can add it later from
                <b>Settings ▸ Your CV</b>.</p>
              <div class="pop-acts">
                <button type="button" class="btn-secondary" onclick="popClose('w_skipcv')">Add my CV</button>
                <button type="submit" name="action" value="skip" formnovalidate>Skip anyway</button>
              </div>
            </div>
          </span>`,
      })}`;
  }

  // Industries, Function, Seniority, Location — one question a screen.
  //
  // These were one card holding three chip boxes, plus a fourth question on its own step: four
  // decisions presented as one wall, and the one thing most people came to change buried in it.
  // They are the SAME control four times, so they are one case driven by a table rather than four
  // near-identical blocks that drift apart the first time one of them is edited.
  if (CRITERIA_STEPS[key]) {
    const q = CRITERIA_STEPS[key];
    const fromCV = String((st.profile || {})[q.cvField] || "");
    const suggestions = [
      ...(q.suggestions || []),
      ...fromCV.split(fromCV.includes(";") ? ";" : ",").map((x) => x.trim()).filter(Boolean),
    ];
    return `<h1 class="wh1">${q.heading}</h1>
      <p class="wsub">${
        q.subFromCV && st.profileParsed
          ? "Suggestions come from your CV. Keep what fits, drop what does not."
          : q.subFromCV && st.cvStatus?.state === "running"
            ? "Your CV is still being read — its suggestions appear here the moment it lands."
            : q.sub
      }</p>
      <div class="wcard">
        ${chipsFieldHTML(q.field, q.label, c[q.field] ?? "", {
          suggestions: [...new Set(suggestions)],
          placeholder: q.placeholder,
          sep: q.sep,
        })}
      </div>
      ${q.note ? `<p class="wnote">${q.note}</p>` : ""}
      ${solo ? standaloneFoot(key, mode.back) : welcomeFoot(key, q.foot || {})}`;
  }

  if (key === "answers") {
    const a = st.answers;
    return `<h1 class="wh1">The questions every application form asks</h1>
      <p class="wsub">Write them down once, and stop looking them up. They are kept with everything
        else on this Mac, and JobSeeker brings them out when you are working on an application.</p>
      <div class="wcard wstack">
        <div class="wtwo">${answerPick(ANSWER_FIELDS[0], a.visa)}${answerPick(ANSWER_FIELDS[1], a.notice)}</div>
        <div class="wtwo">${answerPick(ANSWER_FIELDS[2], a.relocate)}${answerPick(ANSWER_FIELDS[3], a.heard)}</div>
        <label class="wfield"><span class="lbl">Salary expectation</span>
          <input type="text" name="salary" class="winput" value="${esc(a.salary)}" placeholder="open — happy to discuss">
          <span class="wnote">In your own words. Leaving it open is a perfectly good answer, and the one most people give.</span>
        </label>
        <label class="wfield"><span class="lbl">Two lines about you — for when a form wants a summary</span>
          <textarea name="pitch" class="winput" rows="4">${esc(a.pitch)}</textarea>
          <span class="wnote">${
            st.profileParsed
              ? "Your CV is read, so there is something to draft from — write it in your own words; it goes out under your name."
              : "No CV, so nothing to draft from — this one is on you."
          }</span>
        </label>
      </div>
      ${solo ? standaloneFoot(key, mode.back) : welcomeFoot(key, {
        skipLabel: "Skip for now",
        skipNote:
          "Nothing else depends on these — skipping costs you nothing but the looking-up. Settings keeps " +
          "the same list whenever you want to fill it in.",
      })}`;
  }

  if (key === "channels") {
    const cfg = st.cfg;
    const on = (k, dflt = true) => (cfg[k] === undefined ? dflt : String(cfg[k]) !== "false");
    const b = st.browser;
    const canRead = Boolean(b?.capabilities?.read_page_content);
    return `<h1 class="wh1">What may it read?</h1>
      <p class="wsub">Each of these can be turned off again in Settings, at any time.</p>
      <div class="wcard">
        <div class="wrow"><span class="pill ok-pill">always on</span><span><b>Gmail &amp; Calendar</b>
          <em>Recruiter mail, ATS updates, interview invitations. Read-only, through Claude Code's own
          connector — there is nothing to switch on here.</em></span></div>
        <label class="wrow wpick"><input type="checkbox" name="whatsapp_web_enabled" ${on("whatsapp_web_enabled") ? "checked" : ""}>
          <span><b>WhatsApp Web</b>
          <em>Only threads with a job-search signal are recorded. Unread chats are never opened —
          opening one marks it read and destroys your own sense of what still needs you.</em></span></label>
        <div class="wrow"><span class="wsub2">${chipsFieldHTML("ignored_chats", "Never log these chats", cfg.ignored_chats ?? "", {
          placeholder: "chat name…",
          hint: "matched on the start of the chat name",
        })}</span></div>
        <label class="wrow wpick"><input type="checkbox" name="linkedin_enabled" ${on("linkedin_enabled") ? "checked" : ""}>
          <span><b>LinkedIn</b>
          <em>${canRead
            ? "Read from the LinkedIn you are already logged into."
            : "Chrome cannot be read on this Mac yet, so this will do nothing until that is fixed — everything else still works. <a href=\"/settings?tab=setup\">Show me the steps</a>"}</em></span></label>
      </div>
      <div class="wcard wstack" style="margin-top:12px">
        <label class="wfield"><span class="lbl">Where should approvals and the daily digest reach you?</span>
          ${chipsFieldHTML("approval_channels", "", cfg.approval_channels ?? "chat", {
            suggestions: ["chat", "whatsapp"],
            placeholder: "chat, whatsapp…",
          })}
        </label>
        <label class="wfield"><span class="lbl">WhatsApp number for the digest <span class="muted">— optional</span></span>
          <input type="text" name="whatsapp_owner_jid" class="winput" value="${esc(cfg.whatsapp_owner_jid ?? "")}"
                 placeholder="971500000000@s.whatsapp.net">
          <span class="wnote">Blank is fine. Without it the digest waits for you on Today.</span>
        </label>
      </div>
      <input type="hidden" name="_bools" value="whatsapp_web_enabled,linkedin_enabled">
      ${solo ? standaloneFoot(key, mode.back) : welcomeFoot(key)}`;
  }

  // The Chrome step.
  //
  // JobSeeker reads WhatsApp Web and LinkedIn through the Chrome the user is already signed in to,
  // because there is no other way to see those two — and that is a real thing to ask permission for,
  // in plain words, before anything is switched on.
  //
  // It deliberately does NOT run the probe or install the browser agent here. Both are synchronous,
  // both can take up to two minutes, and the agent installer can stop on a macOS permission dialog —
  // a setup step that hangs for two minutes on a system prompt is a setup step people close. The
  // choice is recorded; the work happens on the next run, and Settings shows whether it took.
  if (key === "chrome") {
    const b = st.browser;
    const canRead = Boolean(b?.capabilities?.read_page_content);
    const yes = String(st.cfg.whatsapp_web_enabled ?? "true") !== "false";
    return `<h1 class="wh1">May it read your WhatsApp and LinkedIn?</h1>
      <p class="wsub">Through the Chrome you are already signed in to — JobSeeker never asks for a
        password and never signs in as you.</p>
      <div class="wcard">
        <label class="wrow wpick"><input type="radio" name="chrome" value="yes" ${yes ? "checked" : ""}>
          <span><b>Yes — read them in my Chrome</b>
          <em>Only threads with a job-search signal are recorded. An unread chat is never opened:
          opening one marks it read and destroys your own sense of what still needs you.</em></span></label>
        <label class="wrow wpick"><input type="radio" name="chrome" value="no" ${yes ? "" : "checked"}>
          <span><b>Not now</b>
          <em>Gmail and Calendar still work — they go through Claude Code's own connector, not the
          browser. You would be turning off recruiter messages that arrive on WhatsApp or LinkedIn.</em></span></label>
      </div>
      ${
        platform.IS_WIN
          ? (() => {
              // Same rule as Settings: if it is not connected, the way to fix it is on screen
              // already. Nobody should have to press a button to find out what the steps are.
              const bs = bridge ? bridge.status() : null;
              const done = Boolean(bs && bs.connected);
              return `<div class="wcard" style="margin-top:12px">
              <p class="wnote" style="margin:0 0 8px"><b>Chrome extension</b> ${bridgeStateHTML(bs)}
              ${done ? "" : bridgeConnectHTML(solo ? "setup-step" : "welcome")}</p>
              <p class="wnote" style="margin:0">${bridgeWhyHTML(bs)}</p>
              ${done ? "" : bridgePairingHTML(activePairing()) || bridgeHowToHTML()}
              <p class="wnote" style="margin:8px 0 0">You can also finish this later, from
                <a href="/settings?tab=setup">Settings</a>. Saying yes above is what matters here.</p>
            </div>`;
            })()
          : canRead
          ? `<p class="wnote">Chrome is reachable on this Mac.</p>`
          : `<p class="wnote">macOS has not granted Chrome access yet. Saying yes here records the
             decision; the permission itself is one dialog on the first run, and
             <a href="/settings?tab=setup">Settings</a> shows whether it took.</p>`
      }
      ${solo ? standaloneFoot(key, mode.back) : welcomeFoot(key)}`;
  }

  // Finish: how often, and whether to start one now.
  const cad = currentCadence(st);
  const days = (st.schedDays || "").split(",").filter(Boolean);
  const DAYNAMES = [["Monday", 1], ["Tuesday", 2], ["Wednesday", 3], ["Thursday", 4], ["Friday", 5], ["Saturday", 6], ["Sunday", 0]];
  const HOURS = Array.from({ length: 33 }, (_, i) => {
    const mins = 6 * 60 + i * 30;
    return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  });
  return `<h1 class="wh1">How often should it run?</h1>
    <p class="wsub">A run is a Claude session, so it costs real money — usually a few dollars. It
      reads your channels and writes you a digest; it never applies and never sends.</p>
    <div class="wcard wstack">
      <label class="wfield"><span class="lbl">How often</span>
        <select name="cadence" class="winput" id="w_cadence">
          ${[...CADENCE.entries()]
            .map(([k, v]) => `<option value="${esc(k)}"${k === cad.key ? " selected" : ""}>${esc(v.label)}</option>`)
            .join("")}
        </select>
      </label>
      <label class="wfield hide" id="w_weekday_wrap"><span class="lbl">On</span>
        <select name="weekday" class="winput">
          ${DAYNAMES.map(([label, n]) => `<option value="${n}"${String(n) === cad.weekday ? " selected" : ""}>${esc(label)}</option>`).join("")}
        </select>
      </label>
      <div class="wfield hide" id="w_days_wrap"><span class="lbl">On these days</span>
        <div class="wdays">${DAYNAMES.map(([label, n]) => {
          const chosen = days.length ? days.includes(String(n)) : [1, 2, 3, 4, 5].includes(n);
          return `<label class="wday"><input type="checkbox" name="day" value="${n}" ${chosen ? "checked" : ""}><span>${esc(label.slice(0, 3))}</span></label>`;
        }).join("")}</div>
      </div>
      <label class="wfield" id="w_time_wrap"><span class="lbl">At</span>
        <select name="time" class="winput wtime">
          ${HOURS.map((h) => `<option value="${h}"${h === st.schedTime ? " selected" : ""}>${h}</option>`).join("")}
        </select>
      </label>
    </div>

    <div class="wcard wstack" style="margin-top:12px">
      <span class="lbl">Start one now?</span>
      <label class="wrow wpick"><input type="radio" name="start_now" value="yes" checked>
        <span><b>Yes — run my first search now</b>
        <em>Ten to forty minutes in the background. You can carry on; nothing is applied or sent,
        and anything needing you is queued for your approval.</em></span></label>
      <label class="wrow wpick"><input type="radio" name="start_now" value="no">
        <span><b>Not yet</b><em>Today will show you where to start one.</em></span></label>
    </div>

    <p class="wnote">That is everything JobSeeker cannot work without. The answer library every
      application form asks for, and where approvals reach you, are in
      <b>Settings ▸ Setup</b> whenever you want them.</p>
    ${solo ? standaloneFoot("finish", mode.back) : welcomeFoot(key, { nextLabel: "Finish — take me to Today" })}`;
}

// The same step, outside the flow.
//
// Changing your CV — or your markets, or your answers — months later is MAINTENANCE, not setup, and
// the two want opposite things. Setup is a corridor: finish this, go to the next. Maintenance is an
// errand: change one thing and go back where you came from. Dropping someone into the wizard at
// step 2 gives them a stepper promising five more steps and a Continue that walks them into
// Targets, which is why every entry point outside the wizard lands here instead.
//
// `back` is an allow-list, never a URL from the query string: a page that redirects wherever it is
// told is a redirect anyone can aim.
const BACK_TO = new Map([
  ["settings", { url: "/settings?tab=setup", label: "Settings" }],
  ["cv", { url: "/settings?tab=cv", label: "Settings" }],
  ["today", { url: "/", label: "Today" }],
]);

function standaloneFoot(key, back, { saveLabel = "Save", canSave = true } = {}) {
  const b = BACK_TO.get(back) || BACK_TO.get("settings");
  return `<div class="wacts">
      ${canSave ? `<button type="submit" name="action" value="next">${esc(saveLabel)}</button>` : ""}
      <a class="btn-small linkbtn" href="${esc(b.url)}">${canSave ? "Cancel" : `Back to ${esc(b.label)}`}</a>
    </div>`;
}

function welcomeStandalonePage(st, key, back, flash) {
  const step = stepDef(key);
  const b = BACK_TO.get(back) || BACK_TO.get("settings");
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(step.label)} — JobSeeker</title>
${HEAD_ICONS}
<style>${CSS}${WELCOME_CSS}</style>
</head><body class="wbody">
<header>${BRAND("Job Seeker")}<div class="head-actions">${APPEARANCE_BTN}<a class="gearlink" href="${esc(b.url)}">← ${esc(b.label)}</a>${FEEDBACK_BTN}</div></header>
${flash ? `<div class="flash ${esc(flash.kind)}">${esc(flash.msg)}</div>` : ""}
<main class="wwrap">
  <form method="POST" action="/welcome-step" class="wform">
    <input type="hidden" name="step" value="${esc(step.key)}">
    <input type="hidden" name="return" value="standalone">
    <input type="hidden" name="back" value="${esc(back)}">
    ${welcomeStepHTML(key, st, { standalone: true, back })}
  </form>
</main>
${FEEDBACK_MODAL}
<script>${JS}${FEEDBACK_JS}${WELCOME_JS}</script>
</body></html>`;
}

// What is about to be replaced, next to what the new file says. "Is this better than what I had?"
// is the only question that matters when re-reading a CV, and it cannot be answered from a screen
// that shows one of the two.
function cvComparisonHTML(st) {
  const prev = st.cvPrevious;
  if (!prev || !prev.titles) return "";
  const now = st.profile || {};
  const same = String(prev.titles || "") === String(now.titles || "") && String(prev.seniority || "") === String(now.seniority || "");
  const row = (k, a, bb) =>
    a || bb
      ? `<div class="wprow"><span class="k">${esc(k)}</span>
          <span class="v"><span class="was">${esc(a || "—")}</span>
          <span class="arrow">→</span> ${esc(bb || "—")}</span></div>`
      : "";
  return `<div class="wcard" style="margin-top:12px">
      <p class="th">${same ? "Nothing changed" : "What changed"}
        <span class="muted">— was ${esc(prev.source_cv || "your previous CV")}</span></p>
      <div class="wprofile">
        ${row("Titles", prev.titles, now.titles)}
        ${row("Seniority", prev.seniority, now.seniority)}
        ${row("Domains", prev.domains, now.domains)}
      </div>
      <p class="wnote">Roles already proposed keep the score they were given — only future hunts use
        the new CV.</p>
    </div>`;
}

function welcomePage(st, key, flash) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Welcome to JobSeeker</title>
${HEAD_ICONS}
<style>${CSS}${WELCOME_CSS}</style>
</head><body class="wbody">
<header>${BRAND("Job Seeker")}<div class="head-actions">${APPEARANCE_BTN}${FEEDBACK_BTN}</div></header>
${flash ? `<div class="flash ${esc(flash.kind)}">${esc(flash.msg)}</div>` : ""}
<main class="wwrap">
  ${welcomeProgress(key)}
  ${welcomeRibbon(st, key)}
  <form method="POST" action="/welcome-step" class="wform" enctype="application/x-www-form-urlencoded">
    <input type="hidden" name="step" value="${esc(key)}">
    ${welcomeStepHTML(key, st)}
  </form>
</main>
${FEEDBACK_MODAL}
<script>${JS}${FEEDBACK_JS}${WELCOME_JS}</script>
</body></html>`;
}

// Whether you waited on the CV or walked on, the answer to "did it read my CV?" is on screen. A
// parse that finishes silently two steps later is indistinguishable from one that died.
function welcomeRibbon(st, key) {
  if (key === "cv") return "";
  const s = st.cvStatus?.state;
  if (s === "running") {
    return `<div class="alert">Claude is still reading your CV. The questions further on fill
      themselves in the moment it lands.</div>`;
  }
  if (s === "failed") {
    return `<div class="alert warn"><strong>Your CV could not be read.</strong>
      ${esc(st.cvStatus.detail || "")} Nothing is scored against your experience until it is —
      <a href="/setup-step?step=cv&back=today">try another file</a>.</div>`;
  }
  return "";
}

const WELCOME_CSS = `
.wbody{background:var(--bg)}
.wwrap{max-width:760px;margin:0 auto;padding:26px clamp(16px,4vw,28px) 80px}
.wh1{font-size:23px;font-weight:700;letter-spacing:-.015em;margin:0 0 6px}
.wsub{color:var(--mut);font-size:13.5px;margin:0 0 16px;max-width:64ch}
.wsub2{flex:1;min-width:0}
.wnote{font-size:11.5px;color:var(--mut);margin:9px 0 0;max-width:64ch;line-height:1.6}
.wcard .bridge-pair{margin-top:10px}
.wcard{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.wstack{display:flex;flex-direction:column;gap:14px}
.wtwo{display:flex;gap:13px;flex-wrap:wrap}.wtwo>*{flex:1;min-width:200px}
.wrow{display:flex;align-items:flex-start;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}
.wrow:last-child{border-bottom:0}
.wrow em{font-style:normal;color:var(--mut);font-size:12.5px;display:block;margin-top:3px;line-height:1.55}
.wrow.wpick{cursor:pointer;border-radius:9px;padding:11px 9px;margin:0 -9px}
.wrow.wpick:hover{background:var(--bg)}
.wrow.wpick input{margin-top:3px;flex:0 0 auto;accent-color:var(--acc);width:16px;height:16px}
.wok,.wbad,.wwait{width:21px;height:21px;border-radius:50%;flex:0 0 auto;display:grid;place-items:center;
  font-size:11px;font-weight:700;margin-top:1px}
.wok{background:rgba(46,160,67,.16);color:#3fb950}
.wbad{background:rgba(214,138,0,.16);color:#d68a00}
.wwait{background:var(--line);color:var(--mut)}
.wfield{display:flex;flex-direction:column;gap:5px;min-width:0}
.winput{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;
  color:var(--fg);font:inherit;font-size:13.5px}
.winput:focus{outline:2px solid var(--acc);outline-offset:-1px;border-color:transparent}
textarea.winput{line-height:1.55;resize:vertical}
select.winput{cursor:pointer}
.wother.hide{display:none}
.wtime{max-width:150px}
/* The terminal alternative, as a modal you can work through with a terminal beside it. */
.wterm .modal{max-width:520px;padding:22px 24px 20px}
.wterm h3{margin:0 0 8px;font-size:17px}
.wterm-sub{font-size:12.5px;line-height:1.55;margin:0 0 16px}
.wterm-list{margin:0;padding:0 0 0 20px;display:flex;flex-direction:column;gap:14px}
.wterm-list li::marker{color:var(--mut);font-size:12px}
.wterm-cmd{display:flex;align-items:center;gap:8px}
.wterm-cmd code{font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13px;
  background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:5px 10px}
.wterm-why{margin:4px 0 0;font-size:11.5px;color:var(--mut);line-height:1.5}
.copybtn{display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid transparent;
  color:var(--mut);border-radius:7px;padding:4px 7px;cursor:pointer;font:inherit;font-size:12px}
.copybtn:hover{color:var(--fg);border-color:var(--line)}
.copybtn .copied{display:none;font-size:11px;color:#3fb950;font-weight:650}
.copybtn.ok .copied{display:inline}
.copybtn.ok{color:#3fb950}
.wterm-all{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:18px 0 0;
  padding-top:14px;border-top:1px solid var(--line)}
.wterm-all .copybtn{border-color:var(--line)}
.tiny{font-size:11px}

/* progress — how much is left, in one bar and one line */
.wprogress{margin-bottom:22px}
.wprogress-track{height:5px;border-radius:99px;background:var(--line);overflow:hidden}
.wprogress-track i{display:block;height:100%;background:var(--acc);border-radius:99px;
  transition:width .3s ease}
@media (prefers-reduced-motion:reduce){.wprogress-track i{transition:none}}
.wprogress-label{margin:8px 0 0;font-size:12px;color:var(--mut)}
/* actions */
.wacts{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:18px}
.wspacer{flex:1}
.wacts button[disabled]{opacity:.42;cursor:not-allowed}
.linkbtn{background:transparent;border:0;color:var(--acc);font:inherit;font-size:inherit;cursor:pointer;
  padding:0;text-decoration:none}
a.linkbtn.btn-small{border:1px solid var(--line);color:var(--mut);padding:6px 11px;border-radius:8px}
a.linkbtn.btn-small:hover{color:var(--fg);background:var(--line)}
/* drop zone */
.wdrop{border:1.6px dashed var(--line);border-radius:12px;padding:32px 18px;text-align:center;
  background:var(--card);cursor:pointer}
.wdrop:hover,.wdrop.over{border-color:var(--acc)}
.wdrop-big{font-size:15px;font-weight:600;margin-bottom:5px}
.wprog{height:5px;border-radius:99px;background:var(--line);overflow:hidden;margin-top:11px}
.wprog i{display:block;height:100%;background:var(--acc);border-radius:99px;width:20%;transition:width .3s ease}
.wprog i.anim{width:40%;animation:wslide 1.4s ease-in-out infinite}
@keyframes wslide{0%{margin-left:-40%}100%{margin-left:100%}}
@media (prefers-reduced-motion:reduce){.wprog i.anim{animation:none;width:100%;opacity:.5}}
/* parsed profile */
.wprofile{margin-top:11px;display:flex;flex-direction:column;gap:6px}
.wprow{display:flex;gap:12px;align-items:baseline;font-size:13px}
.wprow .k{width:78px;flex:0 0 auto;color:var(--mut);font-size:12px}
.wprow .v{flex:1;min-width:0}
.wprow .was{color:var(--mut);text-decoration:line-through;text-decoration-color:var(--line)}
.wprow .arrow{color:var(--mut);padding:0 4px}
/* schedule */
.wsched{margin-top:11px;padding-top:11px;border-top:1px solid var(--line)}
.wdays{display:flex;flex-wrap:wrap;gap:6px}
.wday input{position:absolute;opacity:0;pointer-events:none}
.wday span{display:block;border:1px solid var(--line);background:var(--bg);color:var(--mut);border-radius:8px;
  padding:7px 11px;font-size:12.5px;font-weight:600;cursor:pointer;min-width:48px;text-align:center}
.wday input:checked+span{background:var(--acc);border-color:var(--acc);color:#fff}
.wday input:focus-visible+span{outline:2px solid var(--acc);outline-offset:2px}
.wpresets{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
/* the skip dialog's list */
.pop ul.impact{margin:0 0 12px;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.pop ul.impact li{position:relative;padding-left:18px;font-size:12.5px;line-height:1.5}
.pop ul.impact li::before{content:"";position:absolute;left:3px;top:7px;width:5px;height:5px;border-radius:50%;
  background:#d68a00}
.hide{display:none}
`;

const WELCOME_JS = `
(function(){
  // "Something else" swaps the list for a plain field. Done here rather than by reloading the step,
  // because a round-trip to reveal one input would lose everything else typed on the page.
  document.querySelectorAll('select[data-other]').forEach(function(sel){
    sel.addEventListener('change', function(){
      var other = document.getElementsByName(sel.dataset.other)[0];
      if(!other) return;
      var on = sel.value === '__other';
      other.classList.toggle('hide', !on);
      if(on) other.focus();
    });
  });

  // Day presets.
  /* The terminal modal, and copy-to-clipboard.
     navigator.clipboard needs a secure context; the dashboard is plain http on localhost, which
     browsers DO count as secure — but not every one does, so there is a textarea+execCommand
     fallback rather than a button that silently does nothing. */
  window.termOpen = function(){
    var ov = document.getElementById('w_term');
    if(!ov) return;
    ov.style.display = 'flex';
    var first = ov.querySelector('.copybtn');
    if(first) first.focus();
  };
  window.termClose = function(){
    var ov = document.getElementById('w_term');
    if(ov) ov.style.display = 'none';
  };
  (function(){
    var ov = document.getElementById('w_term');
    if(!ov) return;
    ov.addEventListener('click', function(e){ if(e.target === ov) termClose(); });
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape' && ov.style.display === 'flex') termClose();
    });
    function fallback(text){
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch(err){}
      document.body.removeChild(ta);
    }
    ov.addEventListener('click', function(e){
      var b = e.target.closest && e.target.closest('.copybtn');
      if(!b) return;
      var text = b.getAttribute('data-copy') || '';
      var done = function(){
        b.classList.add('ok');
        setTimeout(function(){ b.classList.remove('ok'); }, 1400);
      };
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(done, function(){ fallback(text); done(); });
      } else {
        fallback(text); done();
      }
    });
  })();

  /* The cadence select decides which extra question is even asked: a weekday for "once a week", a
     set of days for "specific days", neither for the rest. Everything stays in the DOM so the
     server sees the same field names whichever branch was on screen. */
  (function(){
    var sel = document.getElementById('w_cadence');
    if(!sel) return;
    var wrapDay = document.getElementById('w_weekday_wrap');
    var wrapDays = document.getElementById('w_days_wrap');
    var wrapTime = document.getElementById('w_time_wrap');
    var PICK_DAY = ['weekly'];
    var PICK_DAYS = ['custom'];
    function apply(){
      var v = sel.value;
      wrapDay.classList.toggle('hide', PICK_DAY.indexOf(v) === -1);
      wrapDays.classList.toggle('hide', PICK_DAYS.indexOf(v) === -1);
      wrapTime.classList.toggle('hide', v === 'off');
    }
    sel.addEventListener('change', apply);
    apply();
  })();

  // The CV upload. Sends the file, starts the parse, then reloads so the page renders from the
  // status file rather than from anything this script believes.
  var drop = document.getElementById('wdrop');
  var file = document.getElementById('wfile');
  var pick = document.getElementById('wpick');
  var replace = document.getElementById('wreplace');
  var prog = document.getElementById('wupprog');

  function upload(f){
    if(!f) return;
    if(f.type !== 'application/pdf' && !/\\.pdf$/i.test(f.name)){
      alertRow('That is not a PDF. Export your CV as a PDF and try again.');
      return;
    }
    if(drop){
      drop.innerHTML = '<div class="wdrop-big">Saving ' + f.name.replace(/[<>&]/g,'') + '…</div>' +
        '<div class="wprog"><i class="anim"></i></div>';
    } else if(prog){
      // The failure card has no drop zone to overwrite. Without this the click that chooses a
      // replacement produces no visible change at all, and the button reads as dead.
      prog.classList.remove('hide');
      if(replace){ replace.textContent = 'Saving ' + f.name.replace(/[<>&]/g,'') + '…'; replace.disabled = true; }
    }
    fetch('/upload-cv?name=' + encodeURIComponent(f.name), { method:'POST', body:f })
      .then(function(r){ if(!r.ok) throw new Error('upload failed'); return fetch('/welcome-parse', {method:'POST', body:''}); })
      .then(function(){ location.reload(); })
      .catch(function(){ alertRow('That file could not be saved. Try again, or copy it into templates/cv/ yourself.'); });
  }
  function alertRow(msg){
    var box = document.createElement('div');
    box.className = 'alert bad';
    box.textContent = msg;
    var form = document.querySelector('.wform');
    if(form) form.insertBefore(box, form.firstChild);
  }

  if(pick && file) pick.addEventListener('click', function(){ file.click(); });
  if(replace && file) replace.addEventListener('click', function(){ file.click(); });
  if(file) file.addEventListener('change', function(){ upload(file.files[0]); });
  // On a Mac there is no hidden file input to click -- the panel is opened by the server, through
  // the submit button in the card -- so the drop zone hands the click to that button instead.
  // Without this the zone would keep its pointer cursor and do nothing, which is the same lie the
  // old picker told.
  var pickSubmit = document.querySelector('button[formaction="/pick-cv"]');
  if(drop){
    drop.addEventListener('click', function(e){
      if(e.target.tagName === 'BUTTON') return;
      if(file) { file.click(); return; }
      if(pickSubmit) pickSubmit.click();
    });
    ['dragenter','dragover'].forEach(function(ev){
      drop.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave','drop'].forEach(function(ev){
      drop.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function(e){
      if(e.dataTransfer && e.dataTransfer.files) upload(e.dataTransfer.files[0]);
    });
  }

  // While a parse is running, come back and look. A reload is enough: this step holds nothing the
  // reader has typed, and rendering from the status file keeps one source of truth for the answer.
  if(document.querySelector('.wprog i.anim') && !drop){
    setTimeout(function(){ location.reload(); }, 4000);
  }
})();
`;

// ---- the POST side ---------------------------------------------------------------------------

// One step at a time, written the moment you leave it. `action` decides where you go; the fields
// decide what is saved. A skip saves nothing and records that you skipped, so Settings can offer
// the step again without nagging about it.
async function handleWelcomeStep(form) {
  const key = String(form.step || "");
  const ix = flowIndex(key);
  if (!stepDef(key)) return { redirect: "/welcome", flash: { kind: "bad", msg: "Unknown step — nothing changed." } };
  const action = String(form.action || "next");
  // Outside the wizard there is no "next": you came from somewhere and you go back to it.
  const solo = String(form.return || "") === "standalone";
  const backKey = BACK_TO.has(String(form.back || "")) ? String(form.back) : "settings";
  const backUrl = BACK_TO.get(backKey).url;
  // Leaving is recorded, not just obeyed. Without that, someone who chose to set up later would be
  // thrown back into the wizard on every single visit — which teaches them the button is a lie.
  if (action === "leave") {
    await mergeConfig({ welcome_left: nowISO() });
    await logActivity("onboard", "Setup left unfinished — Settings will offer to pick it up");
    return { redirect: "/", flash: { kind: "ok", msg: "Setup left as it is. Settings ▸ Finish setup picks up where you stopped." } };
  }
  if (!["next", "back", "skip"].includes(action)) {
    return { redirect: "/welcome?step=" + key, flash: { kind: "bad", msg: "Unknown action — nothing changed." } };
  }

  if (action === "back") return { redirect: `/welcome?step=${WIZARD_FLOW[Math.max(0, ix - 1)]}` };
  if (solo && action === "skip") return { redirect: backUrl };
  // The CV step has nothing to save — the parse already wrote data/profile.md — so its button means
  // "I have read what changed", and clearing the snapshot is what that does.
  if (solo && key === "cv" && action === "next") {
    await fs.rm(CV_PREVIOUS_FILE, { force: true }).catch(() => {});
    return { redirect: backUrl, flash: { kind: "ok", msg: "Your CV is in. Roles found from now on are scored against it." } };
  }

  const st = await welcomeState({ schedule: true });

  if (action === "skip") {
    const skipped = [...new Set([...st.skipped, key])];
    await mergeConfig({ welcome_skipped: skipped.join(", ") });
    await logActivity("onboard", `Setup step skipped: ${key}`);
    return nextWelcome(key, st, { kind: "ok", msg: "Skipped — Settings will offer it again whenever you want it." });
  }

  // Un-skip on the way forward: doing a step you once skipped should stop Settings asking for it.
  if (st.skipped.includes(key)) {
    await mergeConfig({ welcome_skipped: st.skipped.filter((x) => x !== key).join(", ") });
  }

  // One criteria field per step. mergeCriteria (not handleSaveCriteria) because each step must
  // write ONLY its own key — a whole-frontmatter rewrite here would blank the three answered before.
  if (CRITERIA_STEPS[key] && key !== "markets") {
    const field = CRITERIA_STEPS[key].field;
    await mergeCriteria({ [field]: String(form[field] ?? "").trim() });
    await logActivity("onboard", `${CRITERIA_STEPS[key].label} saved: ${field}=[${form[field] ?? ""}]`);
  }

  if (key === "markets") {
    const before = marketList(st.criteria.markets);
    const beforeKeys = new Set(before.map(marketKey));
    const wanted = marketList(form.markets ?? "");
    await mergeCriteria({ markets: String(form.markets ?? "").trim() });
    // A market with no file is a market nothing can research. setUpAddedMarkets is what the
    // Settings form already calls, so a market added here and one added there are identical.
    const added = wanted.filter((m) => !beforeKeys.has(marketKey(m)));
    if (added.length) {
      const setup = await setUpAddedMarkets(added);
      if (setup.created.length) {
        await logActivity("market-add", `Market file created for ${setup.created.join(", ")} — research it from Today`);
      }
    }
  }

  // Chrome. The choice is recorded against the two channels that need a browser; nothing is
  // installed here (see the render side for why).
  if (key === "chrome") {
    const yes = String(form.chrome ?? "yes") !== "no";
    await mergeConfig({ whatsapp_web_enabled: String(yes), linkedin_enabled: String(yes) });
    await logActivity("onboard", `Chrome access ${yes ? "granted" : "declined"} for WhatsApp Web and LinkedIn`);
  }

  if (key === "answers") await writeAnswers(form);

  if (key === "channels") {
    const bools = ["whatsapp_web_enabled", "linkedin_enabled"];
    const fields = {};
    for (const k of bools) fields[k] = k in form ? "true" : "false";
    fields.ignored_chats = String(form.ignored_chats ?? "").trim();
    fields.approval_channels = String(form.approval_channels ?? "").trim() || "chat";
    fields.whatsapp_owner_jid = String(form.whatsapp_owner_jid ?? "").trim();
    await mergeConfig(fields);
    await logActivity("onboard", `Channels saved: whatsapp=${fields.whatsapp_web_enabled} linkedin=${fields.linkedin_enabled}`);
  }

  if (key === "finish") {
    const back = solo ? "/setup-step?step=finish" : "/welcome?step=finish";
    const cadKey = String(form.cadence || "off");
    const cad = CADENCE.get(cadKey);
    if (!cad) return { redirect: back, flash: { kind: "bad", msg: "Unknown schedule — nothing changed." } };

    if (cad.off) {
      if (st.scheduled) await platform.scheduleRemove();
      await mergeConfig({ schedule_days: "off", min_hours_between_runs: "" });
      await logActivity("onboard", "Schedule removed — runs only when asked");
    } else {
      const time = String(form.time || "").trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        return { redirect: back, flash: { kind: "bad", msg: `"${time}" is not a time — nothing was scheduled.` } };
      }
      // parseForm joins repeated fields with commas, so a group of day checkboxes arrives as
      // "1,2,3,4,5" — one string, not a list.
      let days = cad.days ?? "";
      if (cad.pickDay) {
        const d = String(form.weekday || "1").trim();
        if (!/^[0-6]$/.test(d)) return { redirect: back, flash: { kind: "bad", msg: "Pick a day." } };
        days = d;
      } else if (cad.pickDays) {
        const picked = [...new Set(String(form.day ?? "").split(",").map((d) => d.trim()))]
          .filter((d) => /^[0-6]$/.test(d))
          .sort();
        if (!picked.length) {
          return { redirect: back, flash: { kind: "bad", msg: "Pick at least one day, or choose “Only when I ask”." } };
        }
        days = picked.join(",");
      }
      const r = await platform.scheduleSet(time, days);
      if (!r.ok) {
        return { redirect: back, flash: { kind: "err", msg: `The schedule could not be installed: ${r.out || r.err || "see docs/SCHEDULER.md"}` } };
      }
      // The chosen cadence is the BASELINE the ladder steps down from. Without it recorded, the
      // ladder's Restore button would put a twice-a-week user back on daily — a change they never
      // asked for, made by the button that claims to undo one.
      await mergeConfig({ schedule_days: days, min_hours_between_runs: cad.minHours ? String(cad.minHours) : "" });
      await logActivity("onboard", `Scheduled: ${r.out}${cad.minHours ? ` (skips a run inside ${cad.minHours}h)` : ""}`);
    }

    if (solo) return { redirect: backUrl, flash: { kind: "ok", msg: "Schedule saved." } };
    await mergeConfig({ welcome_done: nowISO() });
    await logActivity("onboard", "Setup finished from the wizard");

    // The handoff. handleRunNow is called in-process rather than making the browser POST /run-now:
    // it is a plain async function that already refuses a second run, claims the pending lock and
    // logs, and its {kind, msg} is exactly what the flash serialiser wants — so a refusal reaches
    // the user instead of being swallowed by a redirect they never see.
    if (String(form.start_now || "") === "yes") {
      const r = await handleRunNow({ slug: "job-run" });
      return { redirect: "/?welcome=done", flash: r };
    }
    return {
      redirect: "/?welcome=done&hint=runnow",
      flash: { kind: "ok", msg: "You are set up. Nothing has run yet." },
    };
  }

  if (solo) {
    return { redirect: backUrl, flash: { kind: "ok", msg: `${(stepDef(key) || {}).label || key} saved.` } };
  }
  return nextWelcome(key, st);
}

// Where "next" goes. The CV step is the only one that can be reached with work still in flight, and
// walking on from it is deliberate — so nothing here waits for anything.
function nextWelcome(key, st, flash) {
  const ix = flowIndex(key);
  const next = stepDef(WIZARD_FLOW[Math.min(WIZARD_FLOW.length - 1, ix + 1)]);
  return { redirect: `/welcome?step=${next.key}`, flash };
}

// Which "shall I research this?" asks have been waved away. A dot-file rather than a config key:
// it is transient bookkeeping about one screen, not a setting anybody would want to edit, and it is
// keyed per market so adding a new one next month asks again.
const MARKET_ASK_FILE = path.join(DATA, ".market-ask.json");

// What data/profile.md said BEFORE the parse that is about to overwrite it. Taken at the moment the
// parse starts, because by the time there is anything to compare against, the old values are gone.
const CV_PREVIOUS_FILE = path.join(DATA, ".cv-parse.previous.json");

async function snapshotProfile() {
  const data = parseFrontmatter(await safeRead(path.join(DATA, "profile.md"))).data || {};
  if (!String(data.titles || "").trim()) {
    // Nothing worth comparing against — a first read has no "before", and writing an empty one
    // would make the next screen claim a change that never happened.
    await fs.rm(CV_PREVIOUS_FILE, { force: true }).catch(() => {});
    return;
  }
  await writeFileAtomic(
    CV_PREVIOUS_FILE,
    JSON.stringify(
      { titles: data.titles || "", seniority: data.seniority || "", domains: data.domains || "", source_cv: data.source_cv || "" },
      null,
      2
    )
  );
}

const NOTICES_FILE = path.join(DATA, ".notices-dismissed.json");

async function readCVPrevious() {
  try {
    return JSON.parse(await fs.readFile(CV_PREVIOUS_FILE, "utf8"));
  } catch {
    return null;
  }
}

// Which notices Today has been told to stop showing.
//
// A notice is DERIVED state, not a record: it is recomputed from the run status, the ladder and the
// browser probe on every render, so it cannot be "deleted". What is stored instead is the identity
// of the exact fact that was dismissed — a key carrying the tier, the run timestamp, the board
// count. When the underlying fact changes the key changes and the notice comes back, which is the
// behaviour you want: dismissing "the 4 Sep run was partial" must not also hide "the 5 Sep run
// failed".
//
// The new-version dialog shares this store, and for the same reason. "Not now" is an answer to
// one question -- shall I install 0.7.5 -- and the key carries that version, so the next release
// asks by itself while this one stays answered. The offer is not lost by saying no to it: the
// version row in Settings carries it, with the same Update button.

async function readDismissedNotices() {
  try {
    const j = JSON.parse(await fs.readFile(NOTICES_FILE, "utf8"));
    return j && typeof j.dismissed === "object" && j.dismissed ? j.dismissed : {};
  } catch {
    return {};
  }
}

async function readMarketAskDismissed() {
  try {
    const j = JSON.parse(await fs.readFile(MARKET_ASK_FILE, "utf8"));
    return Array.isArray(j.dismissed) ? j.dismissed : [];
  } catch {
    return [];
  }
}

// Put a Today notice away. The fact itself is untouched — this records that you have seen it, and
// copies its words into the activity log so the Notifications filter can find them later.
//
// The key is checked against the shapes the page actually renders. Same-origin POSTs are already
// enforced (see sameOrigin), but this file is the durable record of what the UI decided, and an
// unconstrained key would let a stray form write arbitrary JSON keys into it.
const NOTICE_KEY_OK = /^(run:(failed|partial)|ladder:(warned|off|tier[0-9]+)|browser:cannot-read|boards:needs-url|digest:undelivered|update(:(done|failed|stalled|ext))?)(:[\w :.+-]{0,80})?$/;

async function handleDismissNotice(form) {
  const key = String(form.key || "").trim();
  if (!NOTICE_KEY_OK.test(key)) return { kind: "bad", msg: "Unknown notice — nothing changed." };
  const summary = sanitizeCell(String(form.summary || "").trim()).slice(0, 300) || key;
  const dismissed = await readDismissedNotices();
  if (!dismissed[key]) {
    dismissed[key] = nowISO();
    await writeFileAtomic(NOTICES_FILE, JSON.stringify({ dismissed }, null, 2));
    await logActivity("notification", summary);
  }
  // An update offer is not a notice you have read. Pointing at Activity would send someone to a
  // log entry when what they want to hear is that the version is still there when they want it.
  const offer = /^update:(\d+\.\d+\.\d+)$/.exec(key);
  if (offer) return { kind: "ok", msg: `Not now. JobSeeker ${offer[1]} stays in Settings whenever you want it.` };
  return { kind: "ok", msg: "Dismissed — it is in Activity under Notifications." };
}

// Bring every dismissed notice back. The escape hatch for the one that mattered.
async function handleRestoreNotices() {
  await writeFileAtomic(NOTICES_FILE, JSON.stringify({ dismissed: {} }, null, 2));
  return { kind: "ok", msg: "Notices restored — anything still true is back on Today." };
}

async function handleDeferMarketAsk(form) {
  const name = String(form.market || "").trim();
  // The value is a market FILE name and is compared against the real list, never trusted as a path.
  const known = (await loadMarkets()).some((m) => m.name === name);
  if (!known) return { kind: "bad", msg: "Unknown market — nothing changed." };
  const dismissed = [...new Set([...(await readMarketAskDismissed()), name])];
  await writeFileAtomic(MARKET_ASK_FILE, JSON.stringify({ dismissed }, null, 2));
  await logActivity("market-ask", `Deferred researching ${name} — it stays on Today as a reminder`);
  return { kind: "ok", msg: "Left for later. It runs on your next scheduled run, or whenever you ask." };
}

// Actions the Setup page may run. An ALLOWLIST of named actions mapped to fixed scripts — never a
// command from the request. This endpoint changes OS state (installs launch agents), so the set of
// things it can do is closed and auditable, exactly as scripts/browser-agent.sh does.
// runner "script" is a bare script name that platform.mjs resolves to scripts/<name>.sh on macOS
// and scripts/win/<name>.ps1 on Windows; runner "node" is a repo-relative .mjs path.
const ACTIONS = new Map([
  ["probe", { script: "scripts/browser-probe.mjs", runner: "node" }],
  ["install-browser-agent", { script: "install-browser-agent", runner: "script", darwinOnly: true }],
  ["set-schedule", { script: "set-schedule", runner: "script", arg: "time" }],
  ["remove-schedule", { script: "set-schedule", runner: "script", fixedArgs: ["--remove"] }],
]);

async function handleRunAction(form) {
  const name = String(form.action_name || "");
  const spec = ACTIONS.get(name);
  if (!spec) throw new Error(`Unknown action: ${JSON.stringify(name).slice(0, 40)}`);
  if (spec.darwinOnly && !platform.IS_MAC) throw new Error("This action only applies on macOS");

  const extraArgs = [...(spec.fixedArgs || [])];
  if (spec.arg === "time") {
    const t = String(form.time || "").trim();
    // Validated here as well as in the script: defence in depth on the boundary that faces the web.
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`Invalid time ${JSON.stringify(t)} — expected HH:MM`);
    extraArgs.push(t);
  }

  const c = spec.runner === "node" ? platform.nodeCommand(spec.script, extraArgs) : platform.scriptCommand(spec.script, extraArgs);
  const r = await platform.run(c.cmd, c.args, { timeout: 120_000 });
  const out = { ok: r.ok, text: r.out || r.err };
  await logActivity("setup-action", `${name}: ${out.ok ? "ok" : "failed"} — ${out.text.slice(0, 120)}`);
  if (!out.ok) throw new Error(out.text.split("\n")[0] || `${name} failed`);
  return out.text.split("\n").filter(Boolean).pop() || `${name} done`;
}

// Commas separate markets, and the settings field now says so. Semicolons are accepted too, because
// for a while it did not: a value containing one flipped the field to semicolon-separated and saved
// it, and every list stored in that window reads as a single market with a punctuated name until
// someone opens Settings and presses Save. Splitting on both is what makes those lists work now
// rather than at the next edit -- and costs nothing, since no market is named with either mark.
const marketList = (s) =>
  String(s || "")
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * What dropping a vertical would clear out.
 *
 * Removing "Fintech" from criteria stopped the SCOUT looking there, but left everything it had
 * already found sitting in the dashboard — measured on this tracker, 5 live Fintech proposals were
 * still being surfaced and aged after the vertical was dropped. Criteria described future
 * behaviour and said nothing about the existing pile.
 *
 * Scope is deliberately narrow, on the same reasoning as dismissImpact():
 *   proposals   — suggestions. Not wanted any more, so they go (dismissed, restorable).
 *   applications/leads — things you actually DID. They are history, and they carry no market field
 *                 anyway; matching them by company would be a guess. Left alone.
 *   market file — data/markets/<x>.md is research, often dozens of companies. Criteria already
 *                 stops it being scouted, so deleting it would destroy work for no gain.
 *   boards      — a careers-board URL is neutral knowledge, useful if the vertical ever returns.
 */
/**
 * Live roles from markets that are NOT in criteria at all.
 *
 * criteriaImpact() only catches a market being removed as it happens. Anything dropped before that
 * existed is already stranded — measured here, 5 live Fintech proposals were still being surfaced,
 * counted and aged weeks after the vertical was dropped, because criteria only ever described what
 * to look for NEXT time. This finds that residue so it can be cleared in one go.
 */
async function orphanedProposals() {
  const wanted = new Set(
    marketList((parseFrontmatter(await safeRead(path.join(DATA, "criteria.md"))).data || {}).markets).map(marketKey)
  );
  if (!wanted.size) return { count: 0, ids: [], byMarket: {} };
  const proposals = await readRecordDir(path.join(DATA, "proposals"));
  const hit = proposals.filter((p) => {
    const m = marketKey(p.data.market);
    // A proposal with no market recorded is not evidence of a dropped vertical — it is just an
    // untagged row, and dismissing it here would be a guess.
    if (!m) return false;
    return !wanted.has(m) && String(p.data.status || "proposed").toLowerCase() !== "dismissed";
  });
  const byMarket = {};
  for (const p of hit) {
    const m = (p.data.market || "").trim();
    byMarket[m] = (byMarket[m] || 0) + 1;
  }
  return { count: hit.length, ids: hit.map((p) => p.data.id), byMarket };
}

async function criteriaImpact(nextMarkets) {
  const current = marketList((parseFrontmatter(await safeRead(path.join(DATA, "criteria.md"))).data || {}).markets);
  const next = marketList(nextMarkets);
  const nextKeys = new Set(next.map(marketKey));
  const removed = current.filter((m) => !nextKeys.has(marketKey(m)));
  const removedKeys = new Set(removed.map(marketKey));
  const proposals = await readRecordDir(path.join(DATA, "proposals"));
  // Case- and punctuation-insensitive: the data carries both "Fintech" and "fintech", and a
  // literal comparison would silently leave half of them behind.
  const hit = proposals.filter(
    (p) =>
      removedKeys.has(marketKey(p.data.market)) &&
      String(p.data.status || "proposed").toLowerCase() !== "dismissed"
  );
  const byMarket = {};
  for (const p of hit) {
    const m = (p.data.market || "").trim() || "(none)";
    byMarket[m] = (byMarket[m] || 0) + 1;
  }
  return { removed, proposals: hit.length, ids: hit.map((p) => p.data.id), byMarket };
}

/**
 * Set a newly-added market up so it is a real thing, not just a word in a list.
 *
 * Adding a market used to append a name and stop there — no file for the prioritization-agent to
 * write into, and nothing to tell you the next step. Two things happen now:
 *
 *   1. data/markets/<slug>.md is created with the header and column layout the agent expects, so
 *      the vertical exists the moment it is named.
 *   2. Roles previously auto-dismissed BECAUSE this market was dropped come back. Only those
 *      carrying the `market` tag — a role you rejected by hand for any other reason stays
 *      rejected, because re-adding a vertical is not a statement about that specific job.
 *
 * Vendor discovery itself is not started here: finding companies for a market is a research pass
 * that costs real money and minutes (`/markets` → prioritization-agent), and silently spending that
 * from a settings save would be a surprising thing for a form to do. The file and the restored
 * roles are the setup; the flash message names the command that fills it.
 */
// `added` is what changed — it decides which auto-dismissed proposals come back. `scaffold` is what
// should EXIST, which is every market currently targeted, not only the new ones. Those came apart
// when the markets field and marketList() disagreed about separators: a list stored as
// "A; B; C" was one market on disk and, once read correctly, three in criteria with two of them
// having no file at all — and a market with no file is invisible to audit.mjs, so the daily run
// would never research it. Scaffolding everything wanted is idempotent (an existing file is left
// exactly as it is) and means one Save in Settings repairs the whole set.
async function setUpAddedMarkets(added, scaffold = added) {
  const created = [];
  const restored = [];
  for (const name of scaffold) {
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) continue;
    const file = path.join(DATA, "markets", `${slug}.md`);
    try {
      await fs.access(file);
    } catch {
      await fs.mkdir(path.join(DATA, "markets"), { recursive: true });
      await writeFileAtomic(
        file,
        `# Market: ${name}\n\n` +
          "Maintained by the prioritization-agent. `tier` 1 = strongest fit. Ranked best-first.\n\n" +
          `Created from the dashboard on ${today()}. Run \`/markets\` in Claude Code to research and rank vendors.\n\n` +
          "| company | tier | hq | why | careers_url | linkedin_url | last_reviewed | notes |\n" +
          "|---------|------|----|-----|-------------|--------------|---------------|-------|\n"
      );
      created.push(name);
    }
  }
  // Undo the auto-dismissals from a previous removal, so dropping and re-adding a vertical is
  // symmetrical rather than one-way.
  if (added.length) {
    const keys = new Set(added.map(marketKey));
    const dir = path.join(DATA, "proposals");
    const recs = await readRecordDir(dir);
    for (const rec of recs) {
      const d = rec.data;
      if (String(d.status || "").toLowerCase() !== "dismissed") continue;
      if (!String(d.dismiss_tags || "").split(/[,\s]+/).includes("market")) continue;
      if (!keys.has(marketKey(d.market))) continue;
      const next = { ...d, status: "proposed", dismiss_tags: "", dismiss_reason: "" };
      await writeFileAtomic(path.join(dir, rec.file), stringifyFrontmatter(next, rec.body, Object.keys(next)));
      restored.push(d.id);
    }
  }
  return { created, restored };
}

// ---- markets saved with the wrong separator (repaired on start, from 0.7.6) ---------------------
// Before 0.7.6 the Markets box inferred its separator from the value, so a pasted semicolon list was
// SAVED as one market: one empty file under data/markets/, headed with all four names. A tester's
// dashboard duly asked "Shall I research Economic Development; Exporting; Trade; Government now?".
// Reading criteria correctly fixes the list going forward; this removes the file the bug left behind
// and creates the separate ones a Save in Settings would — so the person it happened to never needs
// to know it happened, or to delete anything by hand.
//
// It deletes, so it only deletes what cannot be anyone's work:
//   * the heading contains a semicolon — the bug's signature; no market is named with one,
//   * it splits into two or more names,
//   * and its table has NO rows. A researched list is kept whatever it is called.
// Only the names still in criteria.md get a file: someone who has since changed their markets does
// not get old ones back. Idempotent — once nothing matches it does nothing — so it simply runs on
// every start rather than keeping a record of having run.
async function migrateSemicolonMarkets() {
  const dir = path.join(DATA, "markets");
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return { removed: [], created: [] };
  }
  const wanted = marketList((parseFrontmatter(await safeRead(path.join(DATA, "criteria.md"))).data || {}).markets);
  const wantedKeys = new Set(wanted.map(marketKey));
  const removed = [];
  const toCreate = [];
  for (const f of files) {
    if (!f.endsWith(".md") || f.startsWith(".")) continue;
    const p = path.join(dir, f);
    let text = "";
    try {
      text = await fs.readFile(p, "utf8");
    } catch {
      continue;
    }
    const m = /^#\s*Market:\s*(.+)$/m.exec(text);
    if (!m || !m[1].includes(";")) continue;
    const parts = m[1].split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    if ((await readTable(p)).rows.length) continue;
    for (const name of parts) if (wantedKeys.has(marketKey(name))) toCreate.push(name);
    await fs.unlink(p);
    removed.push(m[1].trim());
  }
  // No `added`: nothing was added by the user here, so no auto-dismissed proposal comes back.
  const setup = toCreate.length ? await setUpAddedMarkets([], toCreate) : { created: [] };
  if (removed.length) {
    await logActivity(
      "correction",
      `Split ${removed.map((r) => `'${r}'`).join(", ")} into separate markets` +
        (setup.created.length ? `: ${setup.created.join(", ")}` : "") +
        " — it had been saved as one market with semicolons in its name"
    );
  }
  return { removed, created: setup.created };
}

async function handleSaveCriteria(form) {
  const file = path.join(DATA, "criteria.md");
  const { body } = parseFrontmatter(await safeRead(file));
  const keys = ["markets", "roles", "locations", "seniority", "weight_market", "weight_role", "weight_cv"];
  // Worked out BEFORE the write, while criteria.md still holds the old market list.
  const impact = await criteriaImpact(form.markets ?? "");
  const before = marketList((parseFrontmatter(await safeRead(file)).data || {}).markets);
  const beforeKeys = new Set(before.map(marketKey));
  const added = marketList(form.markets ?? "").filter((m) => !beforeKeys.has(marketKey(m)));
  const data = {};
  for (const k of keys) data[k] = (form[k] ?? "").trim();
  await fs.mkdir(DATA, { recursive: true });
  await writeFileAtomic(file, stringifyFrontmatter(data, body || "# Notes\n", keys));
  await logActivity("criteria-edit", `Updated criteria: markets=[${data.markets}] roles=[${data.roles}]`);

  if (impact.ids.length) {
    const dir = path.join(DATA, "proposals");
    const recs = await readRecordDir(dir);
    for (const id of impact.ids) {
      const rec = recs.find((r) => r.data.id === id);
      if (!rec) continue;
      // `market`, NOT `domain`. dismissalPatterns() mines domain-tagged titles into a
      // do-not-propose list; filing these there would let a dropped vertical suppress unrelated
      // roles that merely share a word with one of its postings.
      const d = { ...rec.data, status: "dismissed", dismiss_tags: "market", dismiss_reason: `${rec.data.market} removed from target markets` };
      await writeFileAtomic(path.join(dir, rec.file), stringifyFrontmatter(d, rec.body, Object.keys(d)));
    }
    await logActivity(
      "proposal-dismissed",
      `${impact.ids.length} proposal(s) dismissed — market(s) removed from criteria: ${impact.removed.join(", ")}`
    );
  }

  const wanted = marketList(form.markets ?? "");
  const setup = wanted.length ? await setUpAddedMarkets(added, wanted) : { created: [], restored: [] };
  if (setup.created.length) {
    await logActivity("market-add", `Market file created for ${setup.created.join(", ")} — run /markets to research vendors`);
  }
  if (setup.restored.length) {
    await logActivity("proposal-proposed", `${setup.restored.length} role(s) restored — market(s) re-added: ${added.join(", ")}`);
  }

  // What the user gets told. Silence after adding a market is what made it feel like nothing had
  // happened, which is why a second "Add market" button existed in the first place.
  const parts = [];
  // Plain text: the flash is rendered through esc(), so markup here would show as literal "<code>".
  if (setup.created.length) parts.push(`${setup.created.join(", ")} added — run /markets in Claude Code to research vendors`);
  if (setup.restored.length) parts.push(`${setup.restored.length} previously dismissed role${setup.restored.length === 1 ? "" : "s"} restored`);
  if (impact.ids.length) parts.push(`${impact.ids.length} role${impact.ids.length === 1 ? "" : "s"} from ${impact.removed.join(", ")} dismissed`);
  return { ...impact, setup, flash: parts.length ? { kind: "ok", msg: `Criteria saved. ${parts.join(" · ")}.` } : null };
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
    // "sday" is what makes TUESDAY parse: every other weekday's tail is covered above, so
  // "call Dana Tuesday" quietly landed with no due date at all — the one day of the week you
  // could not write. The Add task panel shows the parsed date now, which is how it surfaced.
  else if ((m = lc.match(/\b(mon|tue|wed|thu|fri|sat|sun)(?:day|nesday|rsday|urday|sday)?\b/))) {
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

/**
 * What else is attached to a job — used both to warn BEFORE dismissing and to cascade after.
 *
 * The three are treated differently on purpose, because they are different kinds of thing:
 *
 *   tasks     — open commitments. If the job is dead the follow-up is dead, so these cascade.
 *   messages  — a record of what happened. Dismissing the job does not un-send the email, and the
 *               reconciler reads comms as evidence to close OTHER tasks, so deleting them would
 *               damage unrelated bookkeeping. Counted and kept.
 *   contacts  — people. Someone who came up through a role you passed on is still in your network
 *               and may refer you elsewhere; they also have no status column to dismiss into.
 *               Counted and kept.
 *
 * The counts are still surfaced for all three, so "kept" is a visible decision rather than a
 * silent omission.
 */
async function dismissImpact(id) {
  const tasks = await readTable(path.join(DATA, "tasks.md"));
  const comms = await readTable(path.join(DATA, "communications.md"));
  const openTasks = tasks.rows.filter((t) => t.related_id === id && t.status === "open");
  const linkedComms = comms.rows.filter((c) => c.related_application_id === id);
  // Contacts carry no job id, so they are matched by company — the same loose join the People tab
  // uses. Reported as "at this company", never as "belonging to this job".
  let contactsAtCompany = 0;
  let company = "";
  const recs = await readRecordDir(path.join(DATA, "applications"));
  const rec = recs.find((r) => r.data.id === id || r.id === id);
  if (rec) {
    company = rec.data.company || "";
    const key = boardKey(company);
    if (key) {
      const contacts = await readTable(path.join(DATA, "contacts.md"));
      contactsAtCompany = contacts.rows.filter((c) => boardKey(c.company) === key).length;
    }
  }
  return {
    company,
    role: rec?.data.role || "",
    tasks: openTasks.length,
    taskIds: openTasks.map((t) => t.id),
    messages: linkedComms.length,
    contacts: contactsAtCompany,
  };
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

  // Cascade. Leaving a follow-up open against a job you just killed is how the 20-overdue backlog
  // built up in the first place — the task outlives the reason it existed.
  if (status === "Dismissed") {
    const impact = await dismissImpact(id);
    if (impact.taskIds.length) {
      await setTaskStatusFor(impact.taskIds, "dismissed", `job dismissed: ${data.company} — ${data.role}`);
    }
  }
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

/**
 * Set `status` on every task whose id is in `ids`. Returns how many rows changed.
 *
 * Uses md.mjs's splitRow/sanitizeCell rather than a hand-rolled `.split("|")`. The previous version
 * split on raw pipes, so a task detail containing one would shift every later cell one column left
 * on rewrite — the identical corruption that misaligned seven board rows plus communications.md and
 * activity.md before splitRow existed. One row at a time it is easy to miss; a bulk action would
 * have multiplied it.
 */
async function setTaskStatusFor(ids, status, note = "") {
  const wanted = new Set(ids);
  if (!wanted.size || !status) return 0;
  const file = path.join(DATA, "tasks.md");
  const text = await fs.readFile(file, "utf8");
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l));
  if (headerIdx === -1) return 0;
  const headers = splitRow(lines[headerIdx]);
  const idIdx = headers.indexOf("id");
  const stIdx = headers.indexOf("status");
  if (idIdx === -1 || stIdx === -1) return 0;
  let changed = 0;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const cells = splitRow(lines[i]);
    if (!wanted.has(cells[idIdx])) continue;
    cells[stIdx] = status;
    lines[i] = `| ${cells.map((c) => sanitizeCell(c)).join(" | ")} |`;
    changed++;
  }
  if (changed) {
    await writeFileAtomic(file, lines.join("\n"));
    await logActivity("task-" + status, `${changed} task(s) → ${status} (dashboard)${note ? ` — ${note}` : ""}`);
  }
  return changed;
}

// Start one of the job-search commands from the dashboard.
//
// The slug is checked against the same closed list the script knows, not escaped and passed
// through: this value comes from a browser and ends up on a command line, and an allow-list is the
// only check that stays correct when the script grows a new argument.
const RUN_SLUGS = new Map([
  ["apply", "Filling an application"],
  ["track", "Reading your channels"],
  ["curate", "Looking for new roles"],
  ["followup", "Drafting the follow-ups that are due"],
  ["job-run", "Running the full daily pipeline"],
]);

// Is a run live right now? Two files, because neither alone covers the whole run:
//
//   .run-now.lock          scripts/run-now.sh writes it, but only after it has checked for the
//                          claude CLI — several seconds in. Nothing holds the lock before that.
//   .run-now.pending.json  written HERE the moment we spawn, so the gap is covered.
//
// Both are validated the same way: the recorded pid must still exist. A crashed run must not wedge
// the buttons forever, and a finished run leaves a pending file behind that answers "dead" by
// itself. process.kill(pid, 0) sends no signal; it throws ESRCH when there is no such process.
function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readRunLock() {
  try {
    const raw = await fs.readFile(path.join(DATA, ".run-now.lock"), "utf8");
    const [pid, slug, started] = raw.trim().split(/\s+/);
    if (pidAlive(Number(pid))) return { pid: Number(pid), slug, started, starting: false };
  } catch {
    /* no lock yet, or none any more */
  }
  try {
    const pend = JSON.parse(await fs.readFile(path.join(DATA, ".run-now.pending.json"), "utf8"));
    if (pidAlive(Number(pend.pid))) {
      return { pid: Number(pend.pid), slug: pend.slug, started: pend.started, starting: true };
    }
  } catch {
    /* never started from here */
  }
  return null;
}

async function handleRunNow(form) {
  const slug = String(form.slug || "").trim();
  const label = RUN_SLUGS.get(slug);
  if (!label) return { kind: "bad", msg: `Unknown run ${JSON.stringify(slug).slice(0, 30)} — nothing started.` };

  // The buttons are disabled while a run is live, but the page is a snapshot: a second tab, a stale
  // reload, or the back button can all post anyway. Refuse here, where the answer is current —
  // run-now.sh would refuse too, but only after the click has already looked like it worked.
  const live = await readRunLock();
  if (live) {
    const same = live.slug === slug;
    return {
      kind: "bad",
      msg: same
        ? `${label} is already running (started ${String(live.started).slice(0, 16).replace("T", " ")}) — nothing started a second time.`
        : `${RUN_SLUGS.get(live.slug) || live.slug} is already running — only one at a time, so ${label.toLowerCase()} was not started.`,
    };
  }

  // Detached: these take minutes to tens of minutes. The page must come straight back, and the
  // run's own log and status file are how it reports, not this response.
  const child = platform.spawnScriptDetached("run-now", [slug]);
  // Claim the run immediately: run-now.sh takes its own lock seconds later, and until it does this
  // is the only record that something is starting.
  await fs
    .writeFile(
      path.join(DATA, ".run-now.pending.json"),
      JSON.stringify({ pid: child.pid, slug, started: new Date().toISOString().replace(/\.\d+Z$/, "Z") })
    )
    .catch(() => {});
  await logActivity("run-now", `${slug} started from the dashboard`);
  return {
    kind: "ok",
    msg: `${label} — it runs in the background. Reload to see what it found; progress is in data/.run-now.log.`,
  };
}

// Choose a CV through the Mac's own file panel, because the app cannot show the browser's.
//
// JobSeeker.app draws the dashboard in a WKWebView, and WKWebView only opens a file panel if the
// host app implements WKUIDelegate's runOpenPanelWithParameters:. installer/JobSeeker.js does not,
// so inside the app EVERY <input type="file"> click is a silent no-op -- no panel, no error, no
// log line. Someone whose first CV failed could not choose a second one, and the button looked
// broken because from where they sat it was.
//
// The panel is opened by the server instead, with osascript. That is not a workaround aimed at the
// webview: the dashboard listens on 127.0.0.1 only, so the machine running this code is always the
// machine sitting in front of the person clicking, and a panel it opens lands on their screen
// whether they are in the app or in Chrome. One path, working everywhere, beats a hidden input
// that works in one of the two places JobSeeker is normally read.
//
// Windows keeps the ordinary file input: there is no webview wrapper there, so it works.
async function handlePickCV(form) {
  // The button lives inside the wizard's own form and reaches here via formaction, so the fields
  // that say where the reader is are already on the request -- no second source of truth for it.
  const solo = String(form.return || "") === "standalone";
  const backTo = BACK_TO.has(String(form.back || "")) ? String(form.back) : "settings";
  const to = solo ? `/setup-step?step=cv&back=${encodeURIComponent(backTo)}` : "/welcome?step=cv";
  const done = (flash) => ({ redirect: to, flash });

  if (platform.IS_WIN) return done({ kind: "bad", msg: "Use the Choose a file button — nothing changed." });

  // -e per line rather than one embedded newline string: an AppleScript passed as a single
  // argument with literal newlines is the shape that breaks differently on every macOS.
  const script = [
    'set f to choose file with prompt "Choose your CV (a PDF)" of type {"com.adobe.pdf", "pdf"}',
    "POSIX path of f",
  ];
  // Five minutes. The clock is a person deciding, not a computer working, and a panel that closes
  // itself while someone is looking through Documents is worse than no panel.
  const r = await platform.run("osascript", script.flatMap((l) => ["-e", l]), { timeout: 300_000 });

  if (!r.ok) {
    // Cancelling is a decision, not a fault, and must not be reported as one.
    if (/User canceled|-128/.test(r.err || "")) return done(null);
    return done({ kind: "bad", msg: "The file panel could not be opened. Drag your CV onto the page instead." });
  }

  const src = String(r.out || "").trim();
  if (!src) return done(null);
  if (!/\.pdf$/i.test(src)) {
    return done({ kind: "bad", msg: "That is not a PDF. Export your CV as a PDF and choose it again." });
  }

  let buf;
  try {
    buf = await fs.readFile(src);
  } catch (e) {
    return done({ kind: "bad", msg: `That file could not be read (${e.code || e.message}). Nothing changed.` });
  }
  if (!buf.length) return done({ kind: "bad", msg: "That file is empty. Nothing changed." });
  // Same sanitising as the upload route: the name reaches a path, so it never arrives unfiltered.
  const name = path.basename(src).replace(/[^\w.\-]+/g, "_");

  try {
    await fs.mkdir(CV_DIR, { recursive: true });
    await fs.writeFile(path.join(CV_DIR, name), buf);
  } catch (e) {
    return done({ kind: "bad", msg: `The CV could not be saved (${e.code || e.message}). Nothing changed.` });
  }
  await logActivity("cv-upload", `Chose CV: templates/cv/${name} (run /parse-cv)`);

  await snapshotProfile();
  platform.spawnScriptDetached("parse-cv");
  await logActivity("cv-parse", "Reading the chosen CV, started from the wizard");
  return done({ kind: "ok", msg: `Reading ${name} — this takes about half a minute.` });
}

// Ask GitHub now, rather than waiting for the next background check.
//
// The background check runs every six hours, which is right for a courtesy and wrong for the two
// moments a person actually wants an answer: just after a release is announced, and while someone
// is being talked through a problem on the phone. Both end in "check again" — so there has to be
// something to press.
//
// Unlike the update itself this is safe to await: it is one HTTP GET with its own timeout, it
// writes only the cache file, and the answer is the whole point of pressing the button.
async function handleCheckUpdate() {
  const before = await updateState();
  const r = await checkNow({ timeoutMs: 8000 });
  if (r?.error) {
    return { flash: { kind: "bad", msg: `Could not check for updates — ${r.error}. Nothing changed.` } };
  }
  const after = await updateState();
  if (after?.available) {
    // No toast. Someone who presses "Check for updates" is asking to be shown what is there, and
    // being told in a banner to go and find a different button is not an answer — it is the answer
    // pointing at itself. The caller opens the dialog instead.
    return { found: true };
  }
  return { flash: { kind: "ok", msg: `You are up to date — ${after?.current || ""} is the newest release.` } };
}

// Start the update, and get out of the way.
//
// Everything real happens in scripts/self-update.sh (and its Windows twin), spawned DETACHED —
// which matters more here than anywhere else in this file: the thing it is about to stop is this
// process. spawnScriptDetached gives a POSIX child its own session, so nothing that happens to this
// server can reach it.
//
// The refusals live here as well as in the script. A button that cannot be pressed beats an error
// after the fact, and a script that refuses anyway covers the case where the button was pressed
// from a stale page.
async function handleUpdateNow(form) {
  const tag = String(form.tag || "").trim();
  if (!TAG_OK.test(tag)) return { kind: "bad", msg: "Unknown version — nothing was started." };

  // A git checkout is a developer's working copy. Replacing the tree would throw away whatever is
  // uncommitted, so this is never the right thing to do to it.
  try {
    await fs.access(path.join(ROOT, ".git"));
    return {
      kind: "bad",
      msg: "This copy is a git checkout — update it with git pull, not from here. Nothing was changed.",
    };
  } catch {
    /* not a checkout, which is the ordinary case */
  }

  const live = await readRunLock();
  if (live) {
    return {
      kind: "bad",
      msg: `${RUN_SLUGS.get(live.slug) || live.slug} is running — let it finish first, then update.`,
    };
  }

  await fs.mkdir(path.join(DATA, ".setup"), { recursive: true }).catch(() => {});
  await fs
    .writeFile(
      path.join(DATA, ".setup", "update.json"),
      JSON.stringify({ phase: "starting", to: tag.replace(/^v/, ""), tag, pct: 0, startedAt: nowISO() }, null, 2)
    )
    .catch(() => {});
  platform.spawnScriptDetached("self-update", [tag], {
    logFile: path.join(DATA, ".setup", "update.spawn.log"),
  });
  await logActivity("update", `Updating to ${tag}`);
  return { kind: "ok", msg: `Updating to ${tag.replace(/^v/, "")}. JobSeeker will quit and reopen.` };
}

// Fill one application form, then stop.
//
// Same spawn, lock and budget path as handleRunNow — deliberately, because it drives the same
// serial Chrome. The differences are that it takes an argument and that nothing it starts can
// submit anything: /apply-fill leaves a filled form in a tab and adds a task to finish it.
async function handleApplyNow(form) {
  const id = String(form.id || "").trim();
  // Shape first, then existence on disk. This value came from a browser and ends up on a command
  // line; an allow-list is the check that stays correct when the script grows another argument.
  if (!/^prop_[a-z0-9]+$/.test(id)) {
    return { kind: "bad", msg: "Unknown proposal — nothing started." };
  }
  let prop;
  try {
    prop = parseFrontmatter(await fs.readFile(path.join(DATA, "proposals", `${id}.md`), "utf8")).data || {};
  } catch {
    return { kind: "bad", msg: "That role is no longer on file — nothing started." };
  }
  if (!String(prop.job_url || "").trim()) {
    return { kind: "bad", msg: "That role has no link to open, so there is no form to fill." };
  }

  const live = await readRunLock();
  if (live) {
    return {
      kind: "bad",
      msg: `${RUN_SLUGS.get(live.slug) || live.slug} is already running — only one thing can drive Chrome at a time, so nothing was started.`,
    };
  }

  const child = platform.spawnScriptDetached("run-now", ["apply", id]);
  await fs
    .writeFile(
      path.join(DATA, ".run-now.pending.json"),
      JSON.stringify({ pid: child.pid, slug: "apply", started: nowISO() })
    )
    .catch(() => {});
  await logActivity("apply-fill", `Filling the ${prop.company || id} application from the dashboard`);
  return {
    kind: "ok",
    msg: `Opening ${prop.company || "the posting"} in Chrome and filling what it can. It will not submit — review the tab and send it yourself.`,
  };
}

// Decide one approval — and, when the decision is yes, actually send it.
//
// The write happens here rather than through record.mjs for the reason given above
// handleSetProposalStatus: this POST already holds the data/ lock and record.mjs takes the same
// lock, so shelling out would deadlock. The SEND is a different matter — it is minutes of work in
// a `claude` session, so it is spawned detached, exactly like market research, and its result
// comes back into the record as `dispatch:`.
//
// The permission is the record, never this click: scripts/send-approval.sh re-reads the file and
// refuses anything not approved/edited. Two gates on the same fact is deliberate — this one can be
// wrong (a stale page, a double click), and the one next to the send cannot.
const APPROVAL_ID = /^appr_[A-Za-z0-9_-]{1,40}$/;

async function handleDecideApproval(form) {
  const id = String(form.id || "").trim();
  const decision = String(form.decision || "").trim();
  if (!APPROVAL_ID.test(id)) return { kind: "bad", msg: "That is not an approval id — nothing changed." };
  if (!["approve", "edit", "reject", "retry"].includes(decision)) {
    return { kind: "bad", msg: "Unknown decision — nothing changed." };
  }

  const file = path.join(DATA, "approvals", `${id}.md`);
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return { kind: "bad", msg: `Approval ${id} no longer exists.` };
  }
  const { data, body } = parseFrontmatter(text);
  const kind = String(data.kind || "message");
  const sendable = kind !== "apply";

  // Retry is not a decision — it re-runs a send that failed, on a record already approved.
  if (decision === "retry") {
    if (!["approved", "edited"].includes(String(data.status))) {
      return { kind: "bad", msg: `${id} is ${data.status || "undecided"} — there is nothing approved to send.` };
    }
    if (data.dispatch === "sent") return { kind: "bad", msg: `${id} was already sent.` };
    dispatchApproval(id);
    return { kind: "ok", msg: `Trying ${id} again — watch this page, or data/.approvals.log.` };
  }

  // Only a PENDING approval can be decided. Re-deciding is nearly always a stale page or a second
  // click, and silently re-approving would send the same message twice. Deliberately no "cancel"
  // for one already approved: the send is a detached session that may be mid-flight, and a button
  // that promises to call it back when it cannot is worse than no button.
  if (String(data.status) !== "pending") {
    return { kind: "bad", msg: `${id} was already ${data.status} — reload the page to see where it got to.` };
  }

  let newBody = body;
  if (decision === "edit") {
    const edited = String(form.text ?? "").trim();
    if (!edited) return { kind: "bad", msg: "The edited message was empty — nothing changed." };
    newBody = edited.endsWith("\n") ? edited : edited + "\n";
  }
  if (decision === "reject") {
    const note = String(form.note ?? "").trim();
    if (note) newBody = `${body.trimEnd()}\n\n_Rejected from the dashboard: ${sanitizeCell(note)}_\n`;
  }

  data.status = decision === "approve" ? "approved" : decision === "edit" ? "edited" : "rejected";
  data.decided = nowISO();
  if (data.status !== "rejected" && sendable) data.dispatch = "queued";
  // Assigning above already appended any new key in the right place; naming them explicitly here
  // would write `dispatch:` with an empty value onto records that were never dispatched.
  const order = Object.keys(data);
  await writeFileAtomic(file, stringifyFrontmatter(data, newBody, order));
  await logActivity(`approval-${data.status}`, `${kind} ${data.status} from the dashboard: ${data.summary || id} (${id})`);

  if (data.status === "rejected") return { kind: "ok", msg: `Rejected. Nothing was sent.` };
  if (!sendable) {
    return { kind: "ok", msg: `Approved. Applications are submitted by the /apply session that opened this — nothing was sent from here.` };
  }
  dispatchApproval(id);
  return {
    kind: "ok",
    msg: `Approved — sending now. Reload in a minute to see the outcome; the log is data/.approvals.log.`,
  };
}

// Detached on purpose: a send is a whole `claude` session and the dashboard must never block on
// one. Failures land in the record (`dispatch: failed`) and in the log, not in a lost HTTP response.
function dispatchApproval(id) {
  platform.spawnScriptDetached("send-approval", [id]);
}

async function handleSetTaskStatus(form) {
  const id = (form.id ?? "").trim();
  const status = (form.status ?? "").trim();
  if (!id || !status) return;
  await setTaskStatusFor([id], status);
}

// Bulk-clear the stale end of the follow-up backlog.
//
// Measured on this tracker: 20 overdue against 3 due today, 12 of them more than a week past due and
// the oldest three weeks old. That is the failure mode that kills a to-do list — the system creates
// follow-ups faster than anyone closes them, and a Today view opening with three weeks of overdue
// reads as a guilt list rather than a plan, so people stop reading it at all.
//
// Deliberately a DISMISS, not a delete: the rows stay in tasks.md with status "dismissed", the
// Dismissed chip still shows them, each carries a ↺ to restore, and the activity log records the
// sweep. Nothing is destroyed — the point is only to get them out of the daily view.
const STALE_TASK_DAYS = 7;
// Clear the residue: live roles from verticals no longer in criteria. Same treatment as a market
// removed today — dismissed with a reason, restorable, and tagged `market` rather than `domain` so
// they never feed the do-not-propose title learning.
async function handleDismissOrphanedProposals() {
  const orphans = await orphanedProposals();
  if (!orphans.ids.length) return { flash: { kind: "ok", msg: "Nothing to clear — every open role is from a market you target." } };
  const dir = path.join(DATA, "proposals");
  const recs = await readRecordDir(dir);
  for (const id of orphans.ids) {
    const rec = recs.find((r) => r.data.id === id);
    if (!rec) continue;
    const d = { ...rec.data, status: "dismissed", dismiss_tags: "market", dismiss_reason: `${rec.data.market} is no longer a target market` };
    await writeFileAtomic(path.join(dir, rec.file), stringifyFrontmatter(d, rec.body, Object.keys(d)));
  }
  const per = Object.entries(orphans.byMarket).map(([m, n]) => `${n} from ${m}`).join(", ");
  await logActivity("proposal-dismissed", `${orphans.ids.length} proposal(s) dismissed — markets no longer targeted (${per})`);
  return {
    flash: {
      kind: "ok",
      msg: `${orphans.ids.length} role${orphans.ids.length === 1 ? "" : "s"} from untargeted markets dismissed (${per}). Restore any of them from the Dismissed filter.`,
    },
  };
}

async function handleDismissStaleTasks() {
  const t = today();
  const cutoff = addDays(t, -STALE_TASK_DAYS);
  const table = await readTable(path.join(DATA, "tasks.md"));
  const stale = table.rows.filter((r) => r.status === "open" && r.due_date && r.due_date < cutoff);
  const n = await setTaskStatusFor(
    stale.map((r) => r.id),
    "dismissed",
    `overdue more than ${STALE_TASK_DAYS} days as of ${t}`
  );
  return {
    flash: n
      ? { kind: "ok", msg: `${n} follow-up${n === 1 ? "" : "s"} overdue by more than ${STALE_TASK_DAYS} days dismissed. They are still in the Dismissed filter, with ↺ to restore.` }
      : { kind: "ok", msg: "Nothing was more than a week overdue." },
  };
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
    // The Chrome extension's own channel. It authenticates with its pairing token, not with the
    // browser's same-origin labels (an extension origin is never ours), so it is routed before
    // the CSRF check below ever sees it.
    if (bridge && url.pathname.startsWith("/bridge/")) {
      if (bridge.handle(req, res)) return;
    }
    // First run: if there is no config and no targeting, the dashboard is useless and the user has
    // nowhere obvious to start. Send them to Setup once. Any query string (including the flash
    // params a redirect adds) means they have been somewhere deliberately, so this cannot loop.
    // The wizard. A GET renders one step from the files themselves; `leave` is the way out that
    // does not pretend setup finished.
    if (req.method === "GET" && url.pathname === "/welcome") {
      const st = await welcomeState({ schedule: true });
      st.profile = parseFrontmatter(await safeRead(path.join(DATA, "profile.md"))).data || {};
      st.browser = null;
      try {
        st.browser = JSON.parse(await fs.readFile(path.join(DATA, ".browser-status.json"), "utf8"));
      } catch {
        /* the probe has not run here */
      }
      const want = url.searchParams.get("step");
      const key = WIZARD_FLOW.includes(want) ? want : WIZARD_FLOW[0];
      const flash = url.searchParams.get("flash")
        ? { kind: url.searchParams.get("flash"), msg: url.searchParams.get("msg") || "" }
        : null;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(welcomePage(st, key, flash));
    }
    // One step, on its own, for changing something long after setup.
    if (req.method === "GET" && url.pathname === "/setup-step") {
      const want = url.searchParams.get("step");
      if (!stepDef(want)) {
        res.writeHead(303, { Location: "/settings?tab=setup" });
        return res.end();
      }
      const st = await welcomeState({ schedule: want === "finish" || want === "schedule" });
      st.profile = parseFrontmatter(await safeRead(path.join(DATA, "profile.md"))).data || {};
      st.cvPrevious = await readCVPrevious();
      st.browser = null;
      try {
        st.browser = JSON.parse(await fs.readFile(path.join(DATA, ".browser-status.json"), "utf8"));
      } catch {
        /* the probe has not run here */
      }
      const back = BACK_TO.has(url.searchParams.get("back")) ? url.searchParams.get("back") : "settings";
      const flash = url.searchParams.get("flash")
        ? { kind: url.searchParams.get("flash"), msg: url.searchParams.get("msg") || "" }
        : null;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(welcomeStandalonePage(st, want, back, flash));
    }
    // Is anything running, and what finished last? Deliberately tiny and uncached: the page polls
    // it, so it must cost less than the page it might trigger a reload of.
    if (req.method === "GET" && url.pathname === "/run-state") {
      const live = await readRunLock();
      let last = null;
      try {
        last = JSON.parse(await fs.readFile(path.join(DATA, ".run-now.status.json"), "utf8"));
      } catch {
        /* nothing has been run from here yet */
      }
      // The six-hourly check runs in this process, but a page that is already open would not learn
      // about it until someone happened to reload. This poll is already here and already cheap, so
      // it carries the answer: the client reloads once, and the dialog appears on the way back.
      //
      // Only an offer that has not been answered, though. Reporting a dismissed version would
      // reload the page under someone to show them a dialog that then declines to open -- the one
      // way a remembered Not now could still interrupt them.
      const upd = await updateState().catch(() => null);
      const answered = upd?.available ? (await readDismissedNotices())[updateNoticeKey(upd.latest)] : null;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(
        JSON.stringify({
          running: live ? { slug: live.slug, started: live.started } : null,
          finished: last?.finished || "",
          update: upd?.available && !answered ? upd.latest : "",
        })
      );
    }
    if (req.method === "GET" && url.pathname === "/welcome-status") {
      let st = null;
      try {
        st = JSON.parse(await fs.readFile(CV_STATUS_FILE, "utf8"));
      } catch {
        /* never parsed */
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(st || { state: "none" }));
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/settings")) {
      // First run: nobody should have to discover the wizard. Existing installs are never bounced —
      // an already-filled criteria file counts as set up, as does having left setup deliberately.
      //
      // This USED to be two competing redirects, and the older one won: a machine with no
      // config/job-seeker.config.md went to Settings before this check ever ran, so the only person
      // who never saw the wizard was the one it was written for. They are now ordered — the wizard
      // first, Settings only for the half-installed case it was actually meant for.
      const w = await welcomeState();
      if (needsWelcome(w) && !url.searchParams.get("flash")) {
        res.writeHead(303, { Location: "/welcome" });
        return res.end();
      }
      if (url.pathname === "/" && !url.search && !w.cfgPresent) {
        res.writeHead(302, {
          location:
            "/settings?tab=setup&flash=ok&msg=" +
            encodeURIComponent("Welcome — set these up once and JobSeeker can start."),
        });
        return res.end();
      }
      // Settings lists what setup did not finish, so the state it derives that from is loaded here
      // rather than re-read inside a synchronous renderer.
      res._welcome = w;
      const all = await loadAll();
      // The active tab is chosen server-side from ?tab= so there is no flash of the wrong pane, and
      // so a POST redirect can put you back where you were.
      all.tab = url.searchParams.get("tab") || "";
      // Settings' second axis: which sub-pane of Setup. Chosen server-side for the same reason as
      // the tab — no flash of the wrong pane, and a POST redirect can return you to it.
      all.sub = url.searchParams.get("sub") || "";
      // Which coach mark to arm, if any. Looked up in an allow-list — never taken from the query.
      all.hint = PAGE_HINTS.get(url.searchParams.get("hint") || "") || null;
      const flash = url.searchParams.get("flash")
        ? { kind: url.searchParams.get("flash"), msg: url.searchParams.get("msg") || "" }
        : null;
      // Render BEFORE writing headers. Doing it inside res.end() meant a template error left the
      // headers already sent, so the catch below could not send a 500 — it threw
      // ERR_HTTP_HEADERS_SENT and killed the whole process, taking the dashboard down.
      all.welcome = res._welcome;
      // ?upd=1 comes back from the Check for updates button: the user asked the question, so the
      // answer is the dialog itself rather than a toast pointing at a button somewhere else.
      const forceUpdate = url.searchParams.get("upd") === "1";
      const html =
        url.pathname === "/settings" ? settingsPage(all, flash, forceUpdate) : page(all, flash, forceUpdate);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    // What a dismissal would take with it. A GET so the dialog can ask before anything is written,
    // and so it costs nothing if the user backs out.
    // Which install is answering on this port. The setup window uses it to tell "JobSeeker is
    // already running" apart from "a DIFFERENT JobSeeker is squatting the port" -- a stale server
    // from another checkout answers a plain request identically, and the window then hands over to
    // somebody else's build, which looks exactly like the update having failed.
    if (req.method === "GET" && url.pathname === "/update-status") {
      let st = null;
      try {
        st = JSON.parse(await fs.readFile(path.join(DATA, ".setup", "update.json"), "utf8"));
      } catch {
        /* no update has ever been started here */
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(JSON.stringify(st || { phase: "none" }));
    }
    if (req.method === "GET" && url.pathname === "/_whoami") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8",
                           "cache-control": "no-store" });
      return res.end(JSON.stringify({ app: "jobseeker", root: ROOT, version: await currentVersion() }));
    }

    if (req.method === "GET" && url.pathname === "/dismiss-impact") {
      const id = String(url.searchParams.get("id") || "").trim();
      let out = { tasks: 0, messages: 0, contacts: 0 };
      try {
        if (id) out = await dismissImpact(id);
      } catch {
        /* a preview must never block the action it precedes */
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(out));
    }
    // What changing the target markets would clear out. Asked before the form is submitted, so the
    // count is shown while it can still be cancelled.
    if (req.method === "GET" && url.pathname === "/criteria-impact") {
      let out = { removed: [], proposals: 0, byMarket: {} };
      try {
        const { ids, ...rest } = await criteriaImpact(url.searchParams.get("markets") || "");
        out = rest;
      } catch {
        /* preview only — never block the save */
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(out));
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
      //
      // A problem report is the exception. It writes nothing to data/ — it reads the logs and
      // saves a file to Downloads — and the moment you most want to report something is the moment
      // a run has wedged and the lock is held. Making the bug reporter wait on the bug would be a
      // poor joke, so it is handled here, after the CSRF check and before the lock.
      if (url.pathname === "/feedback") return await handleFeedback(req, res);
      return await withLock(() => handlePost(req, res, url));
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Error: " + (e?.message || e));
  }
});

// Build the problem-report bundle and tell the page where it went.
//
// Reads logs, writes one file to Downloads, sends nothing anywhere. The screenshot arrives already
// rendered by the page (FEEDBACK_JS) — this server never looks at the screen.
async function handleFeedback(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("the report could not be read");
  }

  const message = String(body.message || "").slice(0, 20000);
  if (!message.trim()) {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("there was nothing written to report");
  }

  // Only a PNG, and only one the page itself produced. Anything else is dropped rather than
  // refused: a report without the picture still beats no report.
  let png = null;
  const shot = typeof body.shot === "string" ? body.shot : "";
  if (shot.startsWith("data:image/png;base64,")) {
    try {
      png = Buffer.from(shot.slice("data:image/png;base64,".length), "base64");
    } catch {
      png = null;
    }
  }

  try {
    const out = await buildBundle({
      message,
      png,
      meta: {
        version: (await currentVersion()) || "unknown",
        platform: `${process.platform} ${process.arch} ${os.release()}`,
        node: process.version,
        userAgent: String(body.userAgent || "").slice(0, 300),
        page: String(body.page || "").slice(0, 200),
      },
      // The log body comes from scripts/collect-logs.sh, the same collector `npm run logs` runs.
      runScript: platform.runScript,
    });
    await logActivity("feedback", `Problem report written to ${path.basename(out.file)}`);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        name: path.basename(out.file),
        dir: out.dir,
        size: `${Math.max(1, Math.round(out.bytes / 1024))} KB`,
        entries: out.entries,
      })
    );
  } catch (e) {
    console.warn(`[feedback] ${e?.message || e}`);
    res.writeHead(500, { "content-type": "text/plain" });
    return res.end(e?.message || "the file could not be written");
  }
}

async function handlePost(req, res, url) {
  if (url.pathname === "/upload-cv") {
    await handleUploadCV(req, url);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  // Starting the parse takes no fields, and must be handled before the body is parsed as a form.
  if (url.pathname === "/welcome-parse") {
    await snapshotProfile();
    platform.spawnScriptDetached("parse-cv");
    await logActivity("cv-parse", "Reading the uploaded CV, started from the wizard");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("started");
    return;
  }
  const form = parseForm(await readBody(req));
  // Stamped by the client on every POST form so redirect() can return you to the same pane.
  res._returnTab = form._tab || "";
  res._returnSub = form._sub || "";
  res._returnPage = form._page || "";
  // Mint a pairing code for the Chrome extension and come back to the page that asked.
  if (url.pathname === "/bridge-mint") {
    const back = BRIDGE_RETURN.get(String(form._back || "")) || BRIDGE_RETURN.get("settings");
    if (!bridge) {
      res.writeHead(303, { Location: back + "&flash=err&msg=" + encodeURIComponent("The extension bridge is not available in this build.") });
      return res.end();
    }
    pairing = await bridge.mintPairingCode();
    res.writeHead(303, { Location: back });
    return res.end();
  }
  // Windows only: the tray-less desktop launcher has no other way to stop the server. On macOS the
  // app owns the process and kills it itself, so this route does not exist there.
  if (url.pathname === "/quit") {
    if (!platform.IS_WIN) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Bye");
    setTimeout(() => process.exit(0), 200);
    return;
  }
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
    const r = await handleSaveCriteria(form);
    return redirect(res, r?.flash || { kind: "ok", msg: "Criteria saved." });
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
  if (url.pathname === "/run-now") {
    return redirect(res, await handleRunNow(form));
  }
  if (url.pathname === "/welcome-step") {
    const r = await handleWelcomeStep(form);
    const q = r.flash ? `${r.redirect.includes("?") ? "&" : "?"}flash=${encodeURIComponent(r.flash.kind)}&msg=${encodeURIComponent(r.flash.msg)}` : "";
    res.writeHead(303, { Location: r.redirect + q });
    return res.end();
  }
  if (url.pathname === "/restore-schedule") {
    // Recovery is manual by design: the ladder slows itself down, but only a person speeds it back
    // up. Delegates to the same script that stepped it down, so there is one writer of the plist.
    const r = await platform.runScript("schedule-ladder", ["--reset"], { timeout: 20000 });
    await logActivity("schedule-ladder", `Schedule restored to daily from the dashboard: ${r.out || "done"}`);
    return redirect(res, r.ok
      ? { kind: "ok", msg: `Schedule restored — ${r.out || "done"}.` }
      : { kind: "err", msg: `Could not restore the schedule: ${r.out || "see docs/SCHEDULER.md"}` });
  }
  if (url.pathname === "/defer-market-ask") {
    return redirect(res, await handleDeferMarketAsk(form));
  }
  if (url.pathname === "/update-now") {
    return redirect(res, await handleUpdateNow(form));
  }
  if (url.pathname === "/check-update") {
    const r = await handleCheckUpdate();
    return redirect(res, r.flash || null, r.found ? "upd=1" : "");
  }
  if (url.pathname === "/pick-cv") {
    const r = await handlePickCV(form);
    const q = r.flash
      ? `${r.redirect.includes("?") ? "&" : "?"}flash=${encodeURIComponent(r.flash.kind)}&msg=${encodeURIComponent(r.flash.msg)}`
      : "";
    res.writeHead(303, { Location: r.redirect + q });
    return res.end();
  }
  if (url.pathname === "/apply-now") {
    return redirect(res, await handleApplyNow(form));
  }
  if (url.pathname === "/dismiss-notice") {
    return redirect(res, await handleDismissNotice(form));
  }
  if (url.pathname === "/restore-notices") {
    return redirect(res, await handleRestoreNotices());
  }
  if (url.pathname === "/decide-approval") {
    return redirect(res, await handleDecideApproval(form));
  }
  if (url.pathname === "/set-task-status") {
    await handleSetTaskStatus(form);
    return redirect(res, { kind: "ok", msg: form.status === "dismissed" ? "Task dismissed." : "Task updated." });
  }
  if (url.pathname === "/research-market") {
    const market = String(form.market || "").trim();
    // Only a market that actually exists on disk can be researched. This is the boundary that faces
    // the browser and the value reaches a shell script, so it is checked against the real list
    // rather than merely escaped.
    const known = (await loadMarkets()).some((m) => marketKey(m.label) === marketKey(market) || marketKey(m.name) === marketKey(market));
    if (!market || !known) {
      return redirect(res, { kind: "bad", msg: `Unknown market ${JSON.stringify(market).slice(0, 40)} — nothing started.` });
    }
    // Detached, because a research pass runs for minutes and the dashboard must not block on it.
    // Same pattern as the per-company board discovery in handleAddCompany.
    platform.spawnScriptDetached("research-market", [market]);
    await logActivity("markets", `Market research started for ${market} from the dashboard`);
    return redirect(res, {
      kind: "ok",
      msg: `Researching ${market} in the background — takes a few minutes. Reload this page to see the companies appear; progress is in data/.markets-run.log.`,
    });
  }
  if (url.pathname === "/dismiss-orphaned-proposals") {
    const r = await handleDismissOrphanedProposals();
    return redirect(res, r.flash);
  }
  if (url.pathname === "/dismiss-stale-tasks") {
    const r = await handleDismissStaleTasks();
    return redirect(res, r.flash);
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

// A second copy on a port the first one holds is the commonest way this fails to start, and an
// unhandled 'error' event turns that into a Node stack trace about EADDRINUSE -- which tells the
// person reading it nothing about what to do. Say which case it is, and say it in one line.
server.on("error", async (e) => {
  if (e && e.code === "EADDRINUSE") {
    let mine = false;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/_whoami`, { signal: AbortSignal.timeout(2000) });
      mine = r.ok && (await r.json())?.root === ROOT;
    } catch {
      /* whatever is there is not answering as us */
    }
    console.error(
      mine
        ? // Nothing for the user to do, and nothing for them to open: whoever asked for JobSeeker
          // is about to be shown the window that is already running. This line is for a terminal.
          `JobSeeker is already running.`
        : `Another program on this computer is using the connection JobSeeker needs (port ${PORT}). ` +
          `Close it, or set dashboard_port in config/job-seeker.config.md.`
    );
    process.exit(mine ? 0 : 1);
  }
  console.error(`The dashboard could not start: ${e?.message || e}`);
  process.exit(1);
});

// The one-off repair above. Under the same lock every other writer takes, and before the port opens,
// so the first page after an update is already clean. Bounded: record.mjs holds that lock for
// milliseconds at a time, but a start must never hang behind it, so after a few seconds the port
// opens anyway and the repair finishes when the lock comes free. And never fatal — it is tidying,
// not a precondition for anything.
try {
  const repair = withLock(() => migrateSemicolonMarkets()).catch((e) => {
    console.error(`Market repair skipped: ${e?.message || e}`);
    return null;
  });
  const fixed = await Promise.race([repair, new Promise((r) => setTimeout(() => r(null), 4000))]);
  if (fixed?.removed?.length) console.log(`Repaired ${fixed.removed.length} market list(s) saved as one`);
} catch (e) {
  console.error(`Market repair skipped: ${e?.message || e}`);
}

server.listen(PORT, HOST, () => {
  console.log(`Job-seeker dashboard on http://127.0.0.1:${PORT}`);
  // Ask GitHub whether there is a newer release — in the background, on a timer. Never in a request.
  startChecking();
  if (!LOOPBACK.has(HOST)) {
    console.warn(
      `\n!! WARNING: bound to ${HOST}, not loopback. The dashboard has NO authentication, so your\n` +
        `!! job-search data is readable and writable by anyone who can reach this machine on the\n` +
        `!! network. Unset JOBSEEKER_DASHBOARD_HOST to bind 127.0.0.1 only.\n`
    );
  }
});
