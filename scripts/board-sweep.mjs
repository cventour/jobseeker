#!/usr/bin/env node
// Work the browser queue: open each unreadable careers board in the user's real Chrome, read it,
// and reclassify it honestly.
//
//   node scripts/board-sweep.mjs --dry-run        # print what it would do, write nothing
//   node scripts/board-sweep.mjs                  # sweep up to --max boards, oldest first
//   node scripts/board-sweep.mjs --max 5
//   node scripts/browser-do.mjs board-sweep       # routed through the LaunchAgent — preferred
//
// WHY THIS EXISTS
//
// 45 boards sit at access `blocked` or `browser`. That is not "no board": an HTTP 401/403/429/5xx or
// a TLS failure PROVES a board is there and is refusing a script. role-scout is told to "switch to
// Chrome and open it" — but its only browser tools are `mcp__claude-in-chrome__*`, which an
// interactive Claude Code session injects and the scheduled `claude -p` run simply does not have. So
// every morning the queue was read and then skipped, and the digest reported the gap rather than
// closing it. This closes it, using the same Apple Events path the chat sweep already runs on.
//
// MECHANICAL, NOT JUDGEMENT. This fetches and classifies; it never decides whether a role fits. The
// page text is cached to data/.board-cache/ so role-scout can score listings against the CV without
// re-fetching — the same split as everywhere else here: scripts do the retrieval, agents do the
// reasoning.
//
// CAPPED ON PURPOSE. Chrome is a serial resource (AGENT-RULES §13) and a 45-board pass would eat
// most of a run's budget, starving the chat sweep and curation. 15 per run, oldest first, drains the
// queue over a few days. Whatever is left is printed — never silently truncated.

import { execFile } from "child_process";
import { promises as fs, realpathSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { withBrowser, assertCanReadContent } from "./browser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CACHE = path.join(ROOT, "data", ".board-cache");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const numArg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const MAX = numArg("--max", 15);
const WAIT_S = numArg("--wait", 6);
const ONLY = (() => {
  const i = argv.indexOf("--company");
  return i >= 0 ? argv[i + 1] : null;
})();

function record(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [path.join(ROOT, "server", "record.mjs"), ...args],
      { cwd: ROOT, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message))) : resolve(String(stdout).trim()))
    );
  });
}

const today = () => new Date().toISOString().slice(0, 10);
const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

// Endpoints in the registry are a mix of full URLs, bare hosts+paths ("spiresolutions.com/careers/"),
// API paths, and prose ("unknown - cyberark.wd1 and cyberark.wd12 ... return HTTP 422"). Only the
// first two are openable; the rest are notes to a human and must not be turned into a navigation.
function toUrl(endpoint) {
  const raw = String(endpoint || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  // A host must be a single token with a dot and no spaces. This is what rejects the prose rows.
  if (/\s/.test(raw)) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(raw)) return null;
  return "https://" + raw;
}

const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return "";
  }
};

// A wall is a page that loaded fine and told us to prove who we are. It is NOT a failed read, and it
// must not be recorded as one — "Cloudflare challenge" and "board does not exist" are different
// facts and lead to different next actions.
const WALL = [
  [/just a moment|checking your browser|cf-browser-verification|attention required/i, "Cloudflare challenge"],
  [/verify (you are|you're) (a )?human|are you a robot|captcha/i, "CAPTCHA / bot check"],
  [/access denied|403 forbidden|permission denied|you (do not|don't) have access/i, "access denied page"],
  [/sign in|log ?in to continue|please log in|create an account to/i, "login wall"],
  [/accept (all )?cookies|we use cookies|consent (manager|preferences)/i, "consent gate"],
];

// Chrome's own interstitial is a page, with a title and thousands of characters of text, and it
// renders in place of the site. Reading it as content is a FALSE SUCCESS of the worst kind: the
// first live sweep filed Microsoft as "readable — 7123 chars" when those chars were Chrome saying
// "Your connection is not private". A failed load must be recorded as a failed load.
const CHROME_ERROR = [
  [/^chrome-error:|^about:|^data:/i, "the page never loaded (Chrome error page)"],
  [/your connection is not private|NET::ERR_|certificate/i, "TLS / certificate failure"],
  [/this site can.?t be reached|ERR_NAME_NOT_RESOLVED|DNS_PROBE/i, "host not resolvable"],
  [/ERR_CONNECTION_|took too long to respond|ERR_TIMED_OUT/i, "connection refused or timed out"],
  [/HTTP ERROR 4\d\d|HTTP ERROR 5\d\d|is currently unable to handle this request/i, "HTTP error page"],
];

function chromeError(text, finalUrl) {
  if (!/^https?:/i.test(String(finalUrl || ""))) return CHROME_ERROR[0][1];
  for (const [re, label] of CHROME_ERROR.slice(1)) if (re.test(String(text).slice(0, 1500))) return label;
  return null;
}

function classifyWall(text, finalUrl) {
  if (/\/(login|signin|sign-in|auth|sso)(\/|\?|$)/i.test(finalUrl)) return "redirected to a login URL";
  // Only treat wall wording as a wall on a THIN page. A real careers board that happens to carry a
  // cookie banner would otherwise be written off, and cookie banners are on nearly all of them.
  if (String(text).length > 1200) return null;
  for (const [re, label] of WALL) if (re.test(text)) return label;
  return null;
}

// "The page loaded" and "we captured the job listings" are different claims, and conflating them is
// the same silent-success failure one level up: Tarabut, Temenos and Pyypl all returned a perfectly
// good careers LANDING page whose openings sit behind a "View Openings" click or a lazy load. A
// scout reading that cache would find no roles and could reasonably conclude there are none.
//
// browser.mjs deliberately exposes no clicking — that is a security property, not an oversight — so
// the honest move is to measure and say so, not to start driving the page.
const ROLE_WORD =
  /\b(engineer|developer|architect|manager|analyst|director|specialist|consultant|designer|scientist|administrator|technician|lead|officer|executive|associate|intern|principal|head of)\b/gi;

function listingSignal(text) {
  // A job title is a SHORT, Title-Case line on its own. Prose mentioning "our engineers" is long;
  // testimonial bylines ("- COO, EVENT DRIVEN FUND MANAGER") are shouty. Both were false positives
  // on the first pass, so the test is the shape of the line, not merely the presence of a keyword.
  const titles = new Set();
  for (const raw of String(text || "").split("\n")) {
    const l = raw.trim();
    if (l.length < 6 || l.length > 70) continue;
    if (l === l.toUpperCase()) continue;
    ROLE_WORD.lastIndex = 0;
    if (ROLE_WORD.test(l)) titles.add(l.toLowerCase());
  }
  // A HINT, not a verdict — role-scout reads the cache and decides. The threshold is calibrated
  // against the first six real sweeps (Tarabut listed 3 openings; Temenos, Pyypl, Moro Hub and
  // Cloud Box were landing or marketing pages at 0–2), and it errs toward "landing page": a false
  // negative just means re-reading, while a false positive risks a scout concluding the company has
  // no roles when it never saw the list.
  return { titleLines: titles.size, hasListings: titles.size >= 3 };
}

const EXTRACT = (max) =>
  `
(function () {
  try {
    var kill = document.querySelectorAll('script,style,noscript,svg,iframe');
    for (var i = 0; i < kill.length; i++) kill[i].remove();
    var main = document.querySelector('main,[role="main"],#content,.careers,.jobs') || document.body;
    var t = (main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
    return JSON.stringify({ title: document.title || '', href: location.href, text: t.slice(0, ${max}), length: t.length });
  } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
})()
`.replace(/\n/g, " ");

async function main() {
  const queue = JSON.parse(await record(["list-boards", "needs-browser"])).boards || [];

  const skipped = [];
  const work = [];
  for (const b of queue) {
    if (ONLY && b.company !== ONLY) continue;
    const url = toUrl(b.endpoint);
    if (!url) {
      // No openable URL is a HUMAN problem, not a browser one — the Settings page asks for it.
      skipped.push({ ...b, why: b.endpoint ? "endpoint is a note, not a URL" : "no endpoint recorded" });
      continue;
    }
    // A LinkedIn job-view URL is one posting, already verified when it was written. Re-opening
    // dozens of them teaches us nothing about the company's board and is exactly the kind of
    // volume LinkedIn rate-limits.
    if (/linkedin\.com\/jobs\/view/i.test(url)) {
      skipped.push({ ...b, why: "single LinkedIn posting, not a board" });
      continue;
    }
    work.push({ ...b, url });
  }

  // Oldest verification first, so the queue drains fairly instead of re-reading the same head.
  work.sort((a, b) => String(a.last_verified || "").localeCompare(String(b.last_verified || "")));
  const batch = work.slice(0, MAX);
  const deferred = work.length - batch.length;

  process.stdout.write(
    `board-sweep: ${queue.length} in the browser queue · ${batch.length} to read now` +
      (deferred ? ` · ${deferred} deferred to a later run` : "") +
      (skipped.length ? ` · ${skipped.length} not browser-fixable` : "") +
      (DRY ? " · DRY RUN\n" : "\n")
  );
  for (const s of skipped) process.stdout.write(`  skip  ${s.company} — ${s.why}\n`);
  if (!batch.length) return;
  if (DRY) {
    for (const b of batch) process.stdout.write(`  would read  ${b.company}  ${b.url}  (last ${b.last_verified || "never"})\n`);
    process.stdout.write("\n(dry run — nothing written)\n");
    return;
  }

  await fs.mkdir(CACHE, { recursive: true });
  const results = [];

  await withBrowser(async (ctx) => {
    // Probe only to turn a permission denial into a precise error up front. We open our own tabs,
    // so "nothing scriptable is open right now" is not a reason to refuse the whole sweep.
    await assertCanReadContent(ctx.tabs).catch((e) => {
      if (/no http\(s\) tab to probe/.test(String(e?.message))) return;
      throw e;
    });

    for (const b of batch) {
      let out = null;
      let err = null;
      try {
        out = await ctx.withOwnedTab(b.url, async (tab) => {
          // Careers pages are JS-rendered — that is why they are in this queue at all — so a
          // settling wait is not optional.
          await new Promise((r) => setTimeout(r, WAIT_S * 1000));
          return ctx.evalJson(tab, EXTRACT(60_000));
        });
      } catch (e) {
        err = String(e?.message || e);
      }
      results.push({ board: b, out, err });
      process.stdout.write(
        `  read  ${b.company} — ${err ? "FAILED: " + err.slice(0, 90) : `${out?.length ?? 0} chars`}\n`
      );
      // Human-paced, one page per board, read-only (AGENT-RULES §7).
      await new Promise((r) => setTimeout(r, 1500));
    }
  });

  let readable = 0;
  let walled = 0;
  let dead = 0;

  for (const { board: b, out, err } of results) {
    const stamp = today();
    if (err || !out || out.error) {
      // Failed in a browser too. Only NOW is it fair to call it blocked, and the note has to carry
      // both failures so the next run does not re-litigate it from scratch.
      dead++;
      await record([
        "upsert-board",
        JSON.stringify({
          company: b.company,
          access: "blocked",
          last_verified: stamp,
          notes: `${stamp} board-sweep: failed in the browser too (${String(err || out?.error).slice(0, 160)}). Previously ${b.access}. Genuinely uncovered.`,
        }),
      ]);
      continue;
    }

    const failed = chromeError(out.text, out.href);
    if (failed) {
      dead++;
      await record([
        "upsert-board",
        JSON.stringify({
          company: b.company,
          access: "blocked",
          last_verified: stamp,
          notes: `${stamp} board-sweep: Chrome could not load ${b.url} — ${failed}. Fails to a script AND to a browser, so this is genuinely uncovered.`,
        }),
      ]);
      continue;
    }

    // A page that loaded but carries almost nothing is not a readable board. Several queue entries
    // are API paths rather than careers pages, and an API answering `{}` would otherwise be filed as
    // "readable" — the silent-success failure this project keeps fighting.
    if (String(out.text || "").trim().length < 200) {
      dead++;
      await record([
        "upsert-board",
        JSON.stringify({
          company: b.company,
          access: "blocked",
          last_verified: stamp,
          notes: `${stamp} board-sweep: opened at ${out.href} in Chrome and got only ${out.length} chars — no readable listing. Previously ${b.access}.`,
        }),
      ]);
      continue;
    }

    const wall = classifyWall(out.text, out.href);
    if (wall) {
      // Stays in the queue, deliberately. Naming the wall is the useful output — "Cloudflare
      // challenge" is a different problem from "we could not reach it".
      walled++;
      await record([
        "upsert-board",
        JSON.stringify({
          company: b.company,
          access: b.access === "blocked" ? "blocked" : "browser",
          last_verified: stamp,
          notes: `${stamp} board-sweep: opened in Chrome and hit a ${wall} at ${out.href}. Board exists; still queued.`,
        }),
      ]);
      continue;
    }

    readable++;
    // Only a HOST change is worth rewriting the endpoint for — that is a real move (cynerio.com now
    // serves Axonius). A same-host redirect is usually a careers path bouncing to the site root, and
    // adopting it would replace a specific /careers URL with a homepage, quietly losing the better
    // address. Record where we landed in the note instead, and keep the stored path.
    const movedHost = hostOf(out.href) && hostOf(out.href) !== hostOf(b.url);
    const landedElsewhere = !movedHost && out.href.replace(/\/$/, "") !== b.url.replace(/\/$/, "");
    const file = path.join(CACHE, `${slug(b.company)}.txt`);
    const sig = listingSignal(out.text);
    // Stamp the cache. role-scout must be able to tell a fresh listing from a stale one — proposing
    // a role that closed last week is worse than proposing nothing — and a landing page from a real
    // list of openings, so "no roles in the cache" is never mistaken for "no roles at the company".
    await fs.writeFile(
      file,
      `# company: ${b.company}\n# url: ${out.href}\n# fetched: ${new Date().toISOString()}\n` +
        `# chars: ${out.length}\n# job-title-shaped lines: ${sig.titleLines}` +
        (sig.hasListings
          ? " (openings look present)"
          : " — LOOKS LIKE A LANDING PAGE, not a list of openings. They are probably behind a click or lazy-loaded. Do NOT read this as 'the company has no roles'.") +
        "\n\n" +
        `${out.text}\n`
    );
    await record([
      "upsert-board",
      JSON.stringify({
        company: b.company,
        access: "browser",
        endpoint: movedHost ? out.href : b.endpoint,
        last_verified: stamp,
        notes:
          `${stamp} board-sweep: READ IN CHROME — ${out.length} chars cached at data/.board-cache/${slug(b.company)}.txt. ` +
          (sig.hasListings
            ? `${sig.titleLines} job-title-shaped lines, so openings look present.`
            : `LOOKS LIKE A LANDING PAGE — only ${sig.titleLines} job-title-shaped lines; openings are probably behind a click or a lazy load, so an empty cache here does NOT mean the company has no roles.`) +
          (movedHost ? ` MOVED: ${hostOf(b.url)} now redirects to ${hostOf(out.href)} — endpoint updated to ${out.href}.` : "") +
          (landedElsewhere ? ` NOTE: redirected to ${out.href}; stored endpoint left unchanged.` : ""),
      }),
    ]);
  }

  await record([
    "log",
    "curate",
    `board-sweep: ${readable} boards read in Chrome, ${walled} behind a wall, ${dead} failed in-browser, ${deferred} deferred, ${skipped.length} need a URL from the user`,
  ]).catch(() => {});

  process.stdout.write(
    `\nboard-sweep: ${readable} now readable · ${walled} behind a wall (still queued) · ${dead} confirmed blocked · ${deferred} left for the next run\n`
  );
}

// Real-path comparison, not path.resolve: Node resolves module specifiers through symlinks, so on
// macOS (/var -> /private/var) a resolve-based guard silently never matches and main() never runs.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1] || "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((e) => {
    process.stderr.write("board-sweep: " + (e?.message || e) + "\n");
    process.exit(1);
  });
}
