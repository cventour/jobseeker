// How much of the Claude plan is used up — the light in the dashboard's bottom-left corner.
//
// Two sources, because neither answers the whole question:
//
//   * Plan limits (5-hour session, weekly) come from the same endpoint Claude Code's own /usage
//     screen reads, authorised with the sign-in Claude Code already holds. It is undocumented and
//     can change under us, so every failure here becomes a grey light with a reason, never a crash
//     and never a guess.
//   * Token counts come from Claude Code's session logs in ~/.claude/projects. The endpoint only
//     reports percentages, and "how much did JobSeeker itself use" is a local question anyway.
//
// The sign-in token is read, used for one request, and dropped. It never leaves this process except
// to api.anthropic.com, and nothing below returns it or logs it. It is never refreshed here either:
// a refresh rotates the token, and doing that behind Claude Code's back can sign it out. An expired
// token is a message ("open Claude Code once"), not something this module fixes.

import { promises as fs, existsSync } from "fs";
import path from "path";
import * as platform from "./platform.mjs";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const LIMITS_TTL = 90 * 1000;          // the page asks every minute; the endpoint is asked at most this often
const LIMITS_BACKOFF = 5 * 60 * 1000;  // after a 429 or a network error
const TOKENS_TTL = 2 * 60 * 1000;

const PLAN_NAMES = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", free: "Free" };

// Test hook: a JSON file standing in for the endpoint and the credential, so the light can be
// exercised without a real sign-in or a network call.
const FIXTURE = process.env.JOBSEEKER_USAGE_FIXTURE || "";

let limitsCache = { at: 0, retryAt: 0, value: null };
let tokensCache = { at: 0, value: null };

/** The Claude Code sign-in, or null. Only the fields this module needs. */
async function readCredential() {
  let raw = "";
  const file = path.join(platform.homeDir(), ".claude", ".credentials.json");
  if (existsSync(file)) raw = await fs.readFile(file, "utf8").catch(() => "");
  if (!raw && platform.IS_MAC) {
    // `security` is the binary Claude Code itself stores the item with, so reading it back through
    // the same binary does not raise a keychain permission dialog.
    const r = await platform.run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 4000 });
    if (r.ok) raw = r.out;
  }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw).claudeAiOauth;
    if (!o?.accessToken) return null;
    return {
      token: o.accessToken,
      expiresAt: Number(o.expiresAt) || 0,
      plan: o.subscriptionType || "",
      tier: o.rateLimitTier || "",
    };
  } catch {
    return null;
  }
}

/** "max" + "default_claude_max_20x" -> "Max 20x". */
export function planLabel(plan, tier) {
  const base = PLAN_NAMES[String(plan).toLowerCase()] || (plan ? String(plan)[0].toUpperCase() + String(plan).slice(1) : "");
  const mult = /(\d+)x\b/i.exec(String(tier || ""));
  return base && mult ? `${base} ${mult[1]}x` : base;
}

const pct = (w) => (w && Number.isFinite(Number(w.utilization)) ? Math.max(0, Math.round(Number(w.utilization))) : null);
const win = (w) => (pct(w) === null ? null : { pct: pct(w), resets: w.resets_at || "" });

/** The endpoint's payload, reduced to what the panel shows. Exported for the test. */
export function shapeLimits(j) {
  const rows = [];
  const add = (key, label, w) => {
    const v = win(w);
    if (v) rows.push({ key, label, ...v });
  };
  add("session", "Current session (5h)", j.five_hour);
  add("week", "This week, all models", j.seven_day);
  add("week_opus", "This week, Opus", j.seven_day_opus);
  add("week_sonnet", "This week, Sonnet", j.seven_day_sonnet);
  const ex = j.extra_usage;
  const extra = ex && ex.is_enabled ? { pct: pct(ex), used: ex.used_credits ?? null, limit: ex.monthly_limit ?? null } : null;
  return { rows, extra };
}

async function fetchLimits() {
  if (FIXTURE) {
    const f = JSON.parse(await fs.readFile(FIXTURE, "utf8"));
    if (f.error) return { state: "unknown", signin: !!f.signin, reason: f.error, plan: planLabel(f.plan, f.tier) };
    return { state: "ok", plan: planLabel(f.plan, f.tier), ...shapeLimits(f.usage || {}) };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { state: "api", plan: "API key", reason: "Signed in with an API key, so there are no plan limits to show — only tokens." };
  }
  const cred = await readCredential();
  if (!cred) return { state: "unknown", signin: true, reason: "Claude Code is not signed in to a Claude plan on this computer." };
  const plan = planLabel(cred.plan, cred.tier);
  if (cred.expiresAt && cred.expiresAt < Date.now()) {
    return { state: "unknown", signin: true, plan, reason: "Your Claude sign-in needs refreshing. Open Claude Code once and this light comes back." };
  }
  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${cred.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
        "user-agent": "jobseeker-dashboard",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { state: "unknown", plan, reason: "Could not reach Anthropic to read your usage.", backoff: true };
  }
  if (res.status === 401 || res.status === 403) {
    return { state: "unknown", signin: true, plan, reason: "Your Claude sign-in was not accepted. Open Claude Code once and this light comes back." };
  }
  if (res.status === 429) return { state: "unknown", plan, reason: "Anthropic asked us to slow down; trying again in a few minutes.", backoff: true };
  if (!res.ok) return { state: "unknown", plan, reason: `Anthropic answered ${res.status} when asked for your usage.`, backoff: true };
  let j;
  try {
    j = await res.json();
  } catch {
    return { state: "unknown", plan, reason: "Anthropic's usage answer was not in the shape expected.", backoff: true };
  }
  const shaped = shapeLimits(j);
  if (!shaped.rows.length) return { state: "unknown", plan, reason: "Anthropic's usage answer had no limits in it." };
  return { state: "ok", plan, ...shaped };
}

async function limits(force) {
  const now = Date.now();
  // Refresh is a button, and buttons get hammered: a forced read still waits 15 seconds.
  if (force && limitsCache.value && now - limitsCache.at < 15 * 1000) force = false;
  // A sign-in problem is re-checked every few seconds rather than every 90: the fix happens in a
  // terminal the panel just opened, and coming back to a light still saying "not signed in" after
  // signing in reads as the button not having worked.
  const ttl = limitsCache.value?.signin ? 5 * 1000 : LIMITS_TTL;
  if (!force && limitsCache.value && now - limitsCache.at < ttl) return limitsCache.value;
  if (!force && now < limitsCache.retryAt && limitsCache.value) return limitsCache.value;
  let v;
  try {
    v = await fetchLimits();
  } catch {
    v = { state: "unknown", reason: "Could not read your usage.", backoff: true };
  }
  // A failed refresh keeps the last good numbers on screen, marked stale, rather than blanking a
  // panel that was right a minute ago.
  if (v.backoff) {
    limitsCache.retryAt = now + LIMITS_BACKOFF;
    if (limitsCache.value?.state === "ok") {
      limitsCache.value = { ...limitsCache.value, stale: v.reason };
      return limitsCache.value;
    }
  }
  delete v.backoff;
  limitsCache = { at: now, retryAt: limitsCache.retryAt, value: { ...v, checked: new Date(now).toISOString() } };
  return limitsCache.value;
}

// Claude Code names each project folder after its working directory with every "/" and "." made
// "-". JobSeeker's headless runs start in the repo root; its worktrees live under it.
const projectKey = (dir) => String(dir).replace(/[\\/.:]/g, "-");

/** Tokens used since local midnight, all projects and JobSeeker's own. */
export async function tokensToday({ projectsDir = path.join(platform.homeDir(), ".claude", "projects"), repoRoot, now = new Date() } = {}) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.getTime();
  const mine = repoRoot ? projectKey(repoRoot) : null;
  let total = 0, jobseeker = 0, cached = 0;
  const seen = new Set();
  let dirs = [];
  try {
    dirs = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const ours = mine && (d.name === mine || d.name.startsWith(mine + "-"));
    const dir = path.join(projectsDir, d.name);
    let files = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(dir, f);
      const st = await fs.stat(fp).catch(() => null);
      if (!st || st.mtimeMs < since) continue;
      const text = await fs.readFile(fp, "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        if (!line.includes('"usage"')) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const u = e?.message?.usage;
        if (!u || Date.parse(e.timestamp || "") < since) continue;
        // One reply is written several times as it streams, each copy carrying the same usage.
        const id = e.message.id ? `${e.message.id}:${e.requestId || ""}` : null;
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        const n = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
        total += n;
        cached += u.cache_read_input_tokens || 0;
        if (ours) jobseeker += n;
      }
    }
  }
  return { total, jobseeker, cached };
}

async function tokens(repoRoot, force) {
  const now = Date.now();
  if (!force && tokensCache.value && now - tokensCache.at < TOKENS_TTL) return tokensCache.value;
  const v = await tokensToday({ repoRoot }).catch(() => null);
  tokensCache = { at: now, value: v };
  return v;
}

/** green under 50%, yellow from 50%, red at a limit, grey when unknown. */
export function levelOf(lim) {
  if (!lim || lim.state !== "ok") return "grey";
  const top = Math.max(0, ...lim.rows.map((r) => r.pct));
  return top >= 100 ? "red" : top >= 50 ? "yellow" : "green";
}

export async function usageSnapshot({ repoRoot, force = false } = {}) {
  const [lim, tok] = await Promise.all([limits(force), tokens(repoRoot, force)]);
  return { level: levelOf(lim), limits: lim, tokens: tok };
}
