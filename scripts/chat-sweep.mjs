#!/usr/bin/env node
// Read WhatsApp Web (and optionally LinkedIn) message LISTS from the live Chrome, unattended.
//
//   node scripts/chat-sweep.mjs --dry-run      # print what it sees, write nothing
//   node scripts/chat-sweep.mjs                # write comms rows + advance the watermark
//   node scripts/chat-sweep.mjs --linkedin     # also sweep LinkedIn messaging (see the warning)
//
// LIST-ONLY, ON PURPOSE — this is the important design decision here.
//
// It reads the conversation list (name, preview, timestamp, unread badge) and never opens a chat.
// Opening a WhatsApp or LinkedIn thread MARKS IT READ on the user's real account: an unattended
// job that "just reads" would silently clear 11 unread badges overnight and destroy the user's own
// signal about what they still need to look at. AGENT-RULES §4 makes external channels read-only,
// and on a live logged-in session "read-only" has to mean *leaves no trace*, not merely "sends
// nothing". The list carries enough to flag a thread for attention, which is this sweep's job; the
// user (or an interactive run) opens the ones that matter.
//
// LinkedIn is opt-in for the same reason: its desktop messaging view auto-selects the first
// conversation, which marks that one read. Until that is verified harmless it stays behind a flag,
// and by default LinkedIn is swept only if a messaging tab is ALREADY open.

import { execFile } from "child_process";
import { realpathSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { withBrowser, assertCanReadContent } from "./browser.mjs";
import { readTable, readRecordDir } from "../server/md.mjs";
import { ignoredChats } from "../server/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DRY = process.argv.includes("--dry-run");
const DO_LINKEDIN = process.argv.includes("--linkedin");
// Override the watermark window. Two real uses: backfilling after a gap (the sweep was broken for a
// week, so "since last run" would miss everything in between), and testing the selection without
// mutating stored state.
const SINCE_ARG = (() => {
  const i = process.argv.indexOf("--since");
  return i >= 0 ? process.argv[i + 1] : null;
})();

function record(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [path.join(ROOT, "server", "record.mjs"), ...args],
      { cwd: ROOT, timeout: 60_000 },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message))) : resolve(String(stdout).trim()))
    );
  });
}

// Extraction snippets are defensive: WhatsApp/LinkedIn ship DOM changes constantly, so each one
// tries a few selector generations and returns [] rather than throwing. An empty result is
// reported as "extraction found nothing" — never silently as "no messages", which would advance
// the watermark over an unread inbox.
const WHATSAPP_JS = `
(function () {
  try {
    if (document.querySelector('canvas[aria-label*="scan"], canvas[aria-label*="Scan"], [data-ref]')) {
      return JSON.stringify({ logged_out: true });
    }
    var pane = document.querySelector('#pane-side') || document.querySelector('[aria-label="Chat list"]');
    if (!pane) return JSON.stringify({ error: 'chat list not found' });
    /* WhatsApp moved the chat list from role="listitem" to role="row"; accept either, since the */
    /* next redesign will move it again and a hard-coded single selector is how this silently breaks. */
    var items = pane.querySelectorAll('[role="row"], [role="listitem"]');
    var out = [];
    var seen = {};
    for (var i = 0; i < items.length && out.length < 60; i++) {
      var el = items[i];
      var titled = el.querySelector('span[title]');
      var name = titled ? (titled.getAttribute('title') || titled.textContent || '') : '';
      if (!name) continue;
    /* The list virtualises and re-renders, so the same chat can appear twice in one pass. */
      if (seen[name]) continue;
      seen[name] = 1;
      var unread = 0;
      var badge = el.querySelector('[aria-label*="unread"], [aria-label*="Unread"]');
      if (badge) {
        var m = /(\\d+)/.exec(badge.getAttribute('aria-label') || '');
        unread = m ? parseInt(m[1], 10) : 1;
      }
    /* innerText is far more stable than WhatsApp's generated class names: line 1 is the name, */
    /* line 2 the timestamp, and the last line the message preview. */
      var lines = (el.innerText || '').split('\\n').map(function (x) { return x.trim(); }).filter(Boolean);
      var body = lines.filter(function (x) {
        /* Drop the name, the bare unread badge and its aria text — on an unread chat the badge is
           the LAST line, so taking lines[last] naively yields "3" instead of the message. */
        return x !== name && !/^\\d+$/.test(x) && !/^\\d+ unread/i.test(x);
      });
      out.push({
        name: name,
        preview: (body.length ? body[body.length - 1] : '').slice(0, 300),
        unread: unread,
        time: lines.length > 1 ? lines[1] : '',
        muted: !!el.querySelector('[aria-label="Muted chat"]')
      });
    }
    return JSON.stringify({ chats: out });
  } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
})()
`.replace(/\n/g, " ");

const LINKEDIN_JS = `
(function () {
  try {
    var items = document.querySelectorAll('li.msg-conversation-listitem, li[class*="conversation-listitem"]');
    var out = [];
    for (var i = 0; i < items.length && out.length < 40; i++) {
      var el = items[i];
      var nameEl = el.querySelector('.msg-conversation-listitem__participant-names, [class*="participant-names"]');
      var snipEl = el.querySelector('.msg-conversation-card__message-snippet, [class*="message-snippet"]');
      var timeEl = el.querySelector('time, [class*="time-stamp"]');
      var name = nameEl ? (nameEl.textContent || '').trim() : '';
      if (!name) continue;
      var unread = /unread/i.test(el.className) || !!el.querySelector('[class*="unread"]');
      out.push({ name: name, preview: snipEl ? (snipEl.textContent || '').trim().slice(0, 300) : '', unread: unread ? 1 : 0, time: timeEl ? (timeEl.textContent || '').trim() : '' });
    }
    return JSON.stringify({ chats: out });
  } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
})()
`.replace(/\n/g, " ");

// Turn a chat-list timestamp into an absolute time.
//
// This is what makes the sweep watermark-driven rather than unread-driven, and that distinction is
// the whole point: a recruiter message you READ on your phone but never actioned is exactly the
// lead this system exists to surface, and it carries no unread badge. Filtering on unread would
// silently skip every already-seen thread, so follow-ups never get closed and leads go missing.
//
// Both sites show relative labels ("10:54", "Yesterday", "Saturday", "2h", "Jul 28"), so they are
// resolved against now. Anything unparseable returns null and is treated as RECENT — surfacing a
// thread that turns out to be old is cheap; missing a live lead is not.
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function parseListTime(raw, now = new Date()) {
  const t = String(raw || "").trim();
  if (!t) return null;

  // "10:54" / "10:54 PM" -> today
  let m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(t);
  if (m) {
    let h = Number(m[1]);
    if (m[3]) {
      const pm = m[3].toLowerCase() === "pm";
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
    }
    const d = new Date(now);
    d.setHours(h, Number(m[2]), 0, 0);
    // A time later than now must belong to yesterday, not the future.
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }

  if (/^yesterday$/i.test(t)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d;
  }
  if (/^today$/i.test(t)) return new Date(now);

  // A bare weekday means the most recent one within the last 7 days.
  const wd = WEEKDAYS.indexOf(t.toLowerCase());
  if (wd >= 0) {
    const d = new Date(now);
    const delta = (d.getDay() - wd + 7) % 7 || 7;
    d.setDate(d.getDate() - delta);
    return d;
  }

  // LinkedIn relative spans: 30m, 2h, 3d, 1w, 2mo
  m = /^(\d+)\s*(m|h|d|w|mo)$/i.exec(t);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = { m: 60e3, h: 3600e3, d: 864e5, w: 6048e5, mo: 2592e6 }[unit];
    return new Date(now.getTime() - n * ms);
  }

  // Explicit slash dates. Day/month order is genuinely ambiguous and getting it wrong is not
  // cosmetic: reading 7/27/2026 as D/M rolls month 27 over into 2028, so a chat from last month
  // looks NEWER than the watermark and every stale thread gets resurfaced. Disambiguate on the
  // component that cannot be a month, and fall back to the page's own en-US rendering.
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const yr = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    if (b > 12 && a <= 12) return new Date(yr, a - 1, b); // M/D/Y
    if (a > 12 && b <= 12) return new Date(yr, b - 1, a); // D/M/Y
    const guess = Date.parse(t); // both plausible — V8 reads it as M/D/Y, matching the page
    return Number.isNaN(guess) ? null : new Date(guess);
  }
  const parsed = Date.parse(`${t} ${now.getFullYear()}`);
  if (!Number.isNaN(parsed)) return new Date(parsed);

  return null;
}

// Chats that must never be logged — group communities, family threads, anything out of scope.
// This list is PERSONAL: it previously hardcoded a real WhatsApp community name, which cannot ship
// in a public repo. It now comes from the gitignored config/job-seeker.config.md
// (`ignored_chats: name-one, name two`) and is empty by default.
const IGNORED = await ignoredChats();
const isIgnored = (name) => {
  const n = String(name || "").trim().toLowerCase();
  return IGNORED.some((x) => n.startsWith(x));
};

// This sweep runs over the user's PERSONAL WhatsApp, where most threads are family and friends.
// Copying every unread preview into data/communications.md would turn a job-search tracker into a
// log of private conversations — so message TEXT is recorded only when it carries a job-search
// signal. The fact that a thread is unread is still recorded either way, because "someone is
// waiting on you" is the useful part and it costs no privacy.
// English terms alone are not enough here: the user's job-search conversations run in Greek and
// greeklish too, and a real thread reading "Eixes kanena update apo tis sunenteuxeis?" ("any update
// from the interviews?") was being classified as personal and skipped.
const JOB_SIGNAL_EL =
  /(συνέντευξ|δουλει|εργασ|βιογραφικ|προσληψ|θεση|μισθ|αιτηση|sunenteux|synenteux|douleia|douleias|ergasia|viografiko|viografiko|misth|proslips|thesi)/i;

const JOB_SIGNAL =
  /\b(cv|resume|role|job|jobs|vacancy|position|opening|interview|recruit\w*|hiring|hire|candidate|application|applied|apply|referral|refer|offer|salary|package|opportunit\w+|linkedin|hr\b|talent|manager|presales|sales engineer|soc|siem|cyber\w*|security)\b/i;
// Keywords alone are not enough, and the gap is not hypothetical: in testing, a thread from a
// contact already logged in communications.md, and another whose chat name contained an employer
// with a live application, were both classified as personal — because neither recent message
// happened to contain a job word. Relevance therefore also asks: do we already KNOW this person or
// company?
// That is what turns the sweep from an unread-scanner into something that can close the loop on
// follow-ups, which is its actual job.
const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function knownEntities() {
  const names = new Set();
  const add = (v, min = 4) => {
    const n = norm(v);
    if (n.length >= min) names.add(n);
  };
  try {
    for (const row of (await readTable(path.join(ROOT, "data", "communications.md"))).rows) add(row.from);
  } catch {}
  try {
    for (const row of (await readTable(path.join(ROOT, "data", "tasks.md"))).rows) add(row.who);
  } catch {}
  for (const dir of ["applications", "proposals"]) {
    try {
      for (const rec of await readRecordDir(path.join(ROOT, "data", dir))) {
        add(rec.data.company);
        add(rec.data.contact);
        add(rec.data.referrer);
      }
    } catch {}
  }
  return [...names];
}

// Substring either way: a WhatsApp label is rarely exactly the stored name — people save contacts
// as "FirstName CompanyName", or with the employer abbreviated or misspelled.
// Platform words appear as contact labels AND all over the tracker, so they match everything.
const GENERIC = new Set(["whatsapp", "linkedin", "gmail", "email", "google", "meta", "team", "group"]);

const matchesKnown = (name, known) => {
  const n = norm(name);
  // 5 characters minimum, in BOTH directions. A short label matched by substring is how a partner
  // named "Aslı" (normalising to "asl") gets classified as a job contact and has her private
  // messages copied into the tracker. Specificity here is a privacy control, not a tuning knob.
  if (n.length < 5 || GENERIC.has(n)) return false;
  return known.some((k) => k.length >= 5 && !GENERIC.has(k) && (n.includes(k) || k.includes(n)));
};

const looksJobRelated = (c, known = []) => {
  const hay = `${c.name} ${c.preview}`;
  return JOB_SIGNAL.test(hay) || JOB_SIGNAL_EL.test(hay) || matchesKnown(c.name, known);
};

// A stable dedupe key. Deliberately day-grained: re-running the sweep twice in one day must not
// duplicate a row, but a genuinely new message tomorrow must still land.
const threadKey = (source, name, day) =>
  `${source}:${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}:${day}`;

export async function sweepChannel({ ctx, source, host, js, tab }) {
  if (!tab) return { source, swept: false, reason: `no ${host} tab open`, chats: [] };
  const data = await ctx.evalJson(tab, js).catch((e) => ({ error: e.message }));
  if (data?.logged_out) {
    // The session is gone. Do NOT interact — never attempt to scan or re-link, and stop touching
    // this channel for the run, because repeatedly loading a logged-out WhatsApp is how you get
    // rate-limited. This is a "tell the user" event, not a "recover automatically" one.
    return { source, swept: false, reason: "SESSION LOST — showing a QR code. Not touched; re-link it yourself.", chats: [], logged_out: true };
  }
  if (!data || data.error) {
    return { source, swept: false, reason: data?.error || "extraction returned nothing", chats: [] };
  }
  if (!Array.isArray(data.chats) || data.chats.length === 0) {
    // Never advance a watermark on an empty extraction — that is how a broken selector turns into
    // "nothing to report" and stays invisible for weeks.
    return { source, swept: false, reason: "extraction found 0 conversations (selectors may have drifted)", chats: [] };
  }
  return { source, swept: true, reason: "", chats: data.chats, tab_unread: tab.unread ?? null };
}

async function main() {
  const day = new Date().toISOString().slice(0, 10);

  // The previous successful sweep per channel. Everything newer than this is "changed since last
  // run" and gets surfaced, read or unread. A channel with no watermark is a first run: fall back
  // to a week so the first sweep produces a useful picture instead of the entire history.
  const sinceFor = {};
  for (const ch of ["whatsapp", "linkedin"]) {
    let ts = null;
    try {
      ts = JSON.parse(await record(["get-watermark", ch])).timestamp;
    } catch {
      /* no watermark yet */
    }
    sinceFor[ch] = SINCE_ARG || ts || new Date(Date.now() - 7 * 864e5).toISOString();
  }
  const results = await withBrowser(async (ctx) => {
    await assertCanReadContent(ctx.tabs);

    const waTab = ctx.findTab("web.whatsapp.com");
    const liTab = ctx.findTab("linkedin.com/messaging");

    const out = [];
    if (waTab) {
      // Reuse the user's own tab and never close it: WhatsApp Web is single-session, so a second
      // tab shows "WhatsApp is open in another window" and steals the session from them.
      out.push(await sweepChannel({ ctx, source: "WhatsApp", host: "web.whatsapp.com", js: WHATSAPP_JS, tab: waTab }));
    } else {
      // No tab open — typical right after we launched Chrome ourselves, since it starts on the New
      // Tab Page. Safe to open one here precisely BECAUSE none exists, so there is no session to
      // steal. We opened it, so we close it.
      out.push(
        await ctx.withOwnedTab("https://web.whatsapp.com/", async (tab) => {
          await ctx.waitForSelector(tab, '#pane-side, canvas[aria-label*="scan"]', { timeoutMs: 90_000 });
          return sweepChannel({ ctx, source: "WhatsApp", host: "web.whatsapp.com", js: WHATSAPP_JS, tab });
        })
      );
    }

    if (liTab) {
      out.push(await sweepChannel({ ctx, source: "LinkedIn", host: "linkedin.com/messaging", js: LINKEDIN_JS, tab: liTab }));
    } else if (DO_LINKEDIN) {
      const res = await ctx.withOwnedTab("https://www.linkedin.com/messaging/", async (tab) => {
        await ctx.waitForSelector(tab, 'li[class*="conversation-listitem"]', { timeoutMs: 45_000 });
        return sweepChannel({ ctx, source: "LinkedIn", host: "linkedin.com/messaging", js: LINKEDIN_JS, tab });
      });
      out.push(res);
    } else {
      out.push({
        source: "LinkedIn",
        swept: false,
        reason: "no messaging tab open; pass --linkedin to open one (note: LinkedIn auto-opens the first thread, marking it read)",
        chats: [],
      });
    }
    return out;
  });

  for (const r of results) r.since = sinceFor[r.source.toLowerCase()] || null;
  const known = await knownEntities();

  for (const r of results) {
    const since = r.since ? new Date(r.since) : null;
    const unread = r.chats.filter((c) => {
      if (isIgnored(c.name)) return c.unread > 0;
      if (c.unread > 0) return true;
      const at = parseListTime(c.time);
      return !since || !at || at >= since;
    });
    process.stdout.write(
      `\n${r.source}: ${
        r.swept
          ? `${r.chats.length} conversations, ${unread.length} active since ${String(r.since).slice(0, 16)}`
          : `NOT SWEPT — ${r.reason}`
      }\n`
    );
    // A dry run has to show what a LIVE run would do, filtering included — otherwise it previews
    // something the real thing never does, and the preview is worse than useless.
    for (const c of unread.slice(0, 15)) {
      const verdict = isIgnored(c.name)
        ? "IGNORED by rule"
        : looksJobRelated(c, known)
          ? "LOG (job-related)"
          : "skip — not job-related, counted only";
      const tag = c.unread > 0 ? `${c.unread} unread` : `read, active ${c.time || "?"}`;
      process.stdout.write(`  [${tag}] ${c.name} — ${verdict}\n        ${c.preview.slice(0, 80)}\n`);
    }
  }

  if (DRY) {
    process.stdout.write("\n(dry run — nothing written)\n");
    return;
  }

  for (const r of results) {
    if (!r.swept) {
      process.stdout.write(`\n${r.source}: watermark NOT advanced (${r.reason})\n`);
      continue;
    }
    let written = 0;
    let redacted = 0;
    const since = r.since ? new Date(r.since) : null;
    const active = r.chats.filter((c) => {
      if (isIgnored(c.name)) return false;
      if (c.unread > 0) return true;
      const at = parseListTime(c.time);
      // Unparseable -> treat as recent rather than dropping it silently.
      return !since || !at || at >= since;
    });
    const ignored = r.chats.filter((x) => isIgnored(x.name)).length;
    for (const c of active) {
      // Non-job threads are COUNTED, never recorded. On a personal WhatsApp most unread chats are
      // family, friends and spam; writing a row per plumber advert would both pollute the tracker
      // and quietly turn it into a log of private conversations. The count still reaches the digest,
      // so nothing is hidden — only the contents of chats that are none of this system's business.
      if (!looksJobRelated(c, known)) {
        redacted++;
        continue;
      }
      await record([
        "add-communication",
        JSON.stringify({
          date: new Date().toISOString(),
          source: r.source,
          // Never guess a person's name from a handle (AGENT-RULES §1) — store the list label raw.
          // Many WhatsApp entries are bare phone numbers; that IS the identifier, leave it alone.
          from: c.name,
          subject: `${r.source}: ${c.name}`,
          summary: `${c.unread} unread. Latest preview: ${c.preview}`.slice(0, 500),
          thread_url: threadKey(r.source.toLowerCase(), c.name, day),
        }),
      ]);
      written++;
    }
    process.stdout.write(
      `${r.source}: ${written} active thread(s) logged` +
        (redacted ? `, ${redacted} active but not job-related (counted, not recorded)` : "") +
        (ignored ? `, ${ignored} ignored by rule` : "") +
        "\n"
    );
    await record([
      "set-watermark",
      r.source.toLowerCase(),
      new Date().toISOString(),
      `chat-sweep: ${r.chats.length} conversations, ${written} job-related active since last run, ${redacted} unrelated`,
    ]);
    process.stdout.write(`${r.source}: watermark advanced\n`);
  }
}

// Real-path comparison, not path.resolve: Node resolves module specifiers through symlinks, so on
// macOS (/var -> /private/var) a resolve-based guard silently never matches and main() never runs.
// That exact bug made server/record.mjs exit 0 having written nothing.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1] || "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((e) => {
    process.stderr.write("chat-sweep: " + (e?.message || e) + "\n");
    process.exit(1);
  });
}
