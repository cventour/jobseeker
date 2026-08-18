// Personal configuration, kept OUT of the repository.
//
// Some behaviour is genuinely specific to one person's job search: which company names are aliases
// of each other, and which group chats must never be logged. Those used to be hardcoded — a real
// WhatsApp community name sat in scripts/chat-sweep.mjs, and a real employer mapping sat in
// record.mjs — which meant preparing this repo for publication would have exposed them, and would
// also have shipped one person's settings to everyone who cloned it.
//
// They now live in config/job-seeker.config.md, which is gitignored. config/job-seeker.config.md.example
// is committed and shows the format with placeholder values.
//
// Every value here is OPTIONAL. With no config file the defaults are empty, which means "no
// aliases, ignore nothing" — correct behaviour for a fresh clone rather than an error.

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseFrontmatter } from "./md.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG = path.join(ROOT, "config", "job-seeker.config.md");

let cached = null;

export async function loadConfig() {
  if (cached) return cached;
  try {
    const { data } = parseFrontmatter(await fs.readFile(CONFIG, "utf8"));
    cached = data || {};
  } catch {
    cached = {};
  }
  return cached;
}

const list = (v) =>
  String(v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Chat names that must never be logged, as lowercased prefixes.
 * Config: `ignored_chats: some-community, another group`
 */
export async function ignoredChats() {
  return list((await loadConfig()).ignored_chats).map((x) => x.toLowerCase());
}

/**
 * Company aliases, so the same employer under two names does not become two records.
 * Config: `company_aliases: oldname=NewName, acquired=Parent`
 * Returns { normalisedKey: "Canonical Name" }.
 */
export async function companyAliases() {
  const out = {};
  for (const pair of list((await loadConfig()).company_aliases)) {
    const [from, to] = pair.split("=").map((x) => (x || "").trim());
    if (!from || !to) continue;
    out[from.toLowerCase().replace(/[^a-z0-9]+/g, "")] = to;
  }
  return out;
}

/**
 * Is a channel switched on? Config: `whatsapp_web_enabled: true`, `linkedin_enabled: true`.
 *
 * Defaults to TRUE for an absent key, because these are opt-OUT switches: a fresh clone with no
 * config file should behave the way the documentation describes, not silently read nothing.
 *
 * This exists because `linkedin_enabled` was a setting the dashboard offered, the config file
 * recorded, and NOTHING read — the sweep gated on a `--linkedin` argv flag no scheduled run ever
 * passes. The user switched LinkedIn on, the switch did nothing, and the digest reported the
 * channel as deliberately skipped. Same shape as the old `schedule_job_run` trap: written by one
 * component, read by none.
 */
export async function channelEnabled(name) {
  const raw = (await loadConfig())[`${name}_enabled`];
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return !/^(false|no|off|0)$/i.test(String(raw).trim());
}
