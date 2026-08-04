// Is this proposal actually a job the user has already applied to?
//
// Three separate mechanisms already catch the easy cases and all three miss reposts:
//   * company+role dedupe fails the moment the title is reworded,
//   * the seen_req_ids index fails because a REPOST GETS A NEW REQUISITION ID — that is what makes
//     it a repost rather than the same listing,
//   * the job_url differs for the same reason.
// So this compares titles fuzzily within a company and reports WHY it matched, with a confidence,
// rather than silently merging anything. Nothing here auto-dismisses: a repost is flagged for the
// user to kill, because "same job" is ultimately a judgement about the employer's intent.
//
// Shared by record.mjs (list-keys), audit.mjs (supervisor report) and dashboard.mjs (the badge), so
// all three agree on what counts as a repost instead of drifting apart.

// Injected from the gitignored personal config (see server/config.mjs) rather than hardcoded: the
// real mapping named a specific employer, which cannot ship in a public repo. Empty by default.
let COMPANY_ALIASES = {};

/** Called once at startup by whichever entry point loaded the config. */
export function setCompanyAliases(map) {
  COMPANY_ALIASES = {};
  for (const [k, v] of Object.entries(map || {})) {
    COMPANY_ALIASES[k] = String(v).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
}

export function normCompany(name) {
  const k = String(name || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|plc|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  return COMPANY_ALIASES[k] || k;
}

// Agency and parent naming drifts ("Hays" vs "Hays (client: …)", "G42" vs "Core42 / G42"), so a
// prefix relationship counts as the same employer.
export function sameCompany(a, b) {
  const x = normCompany(a);
  const y = normCompany(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

// Words that never distinguish one job from another.
const STOP = new Set([
  "the", "and", "of", "for", "a", "an", "at", "in", "to", "with", "on", "or",
  "role", "position", "job", "opening", "vacancy", "career", "careers", "req", "requisition",
  "fulltime", "full", "time", "permanent", "remote", "hybrid", "onsite",
]);
// Seniority and level markers. A repost is frequently re-banded (SE → Senior SE, "2" → "3"), so
// these are stripped for matching — the band is a variation of the same job, not a different job.
const LEVEL = new Set([
  "senior", "sr", "snr", "junior", "jr", "staff", "principal", "associate", "assistant",
  "i", "ii", "iii", "iv", "1", "2", "3", "4",
]);
// Territory markers. NOT stripped for the primary score — "Systems Engineer Jordan" and "Systems
// Engineer UAE" are genuinely different jobs — but removed for a secondary check so a same-role
// different-territory pair can be reported as exactly that, rather than as a repost.
const PLACE = new Set([
  "uae", "dubai", "abu", "dhabi", "emirates", "united", "arab", "ksa", "saudi", "arabia",
  "qatar", "kuwait", "oman", "bahrain", "egypt", "jordan", "lebanon", "turkey", "israel",
  "meta", "mena", "emea", "gulf", "middle", "east", "regional", "region", "international",
  "apac", "amer", "global", "north", "south", "africa",
]);

export function roleTokens(role, { dropPlace = false } = {}) {
  return new Set(
    String(role || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .filter((w) => !STOP.has(w) && !LEVEL.has(w))
      .filter((w) => (dropPlace ? !PLACE.has(w) : true))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

const subsetOf = (a, b) => a.size > 0 && [...a].every((w) => b.has(w));

// A placeholder title ("Cybersecurity role (referral)", "2 roles applied") carries no information,
// so token overlap against it is meaningless and would fire on everything at that company.
export function isVagueRole(role) {
  const s = String(role || "").toLowerCase();
  return !s.trim() || /\btbd\b|\bunknown\b|referral|conversation|\broles? applied\b|open to /.test(s);
}

/**
 * Compare one proposal against the user's applications.
 * Returns the strongest match or null. Never mutates anything.
 */
export function findRepost(proposal, applications, { reqIndex = null } = {}) {
  const pRole = proposal.role || "";
  const pTok = roleTokens(pRole);
  const pTokNoPlace = roleTokens(pRole, { dropPlace: true });
  const pReqs = new Set(reqIndex ? reqIndex(proposal) : []);

  let best = null;
  const consider = (cand) => {
    if (!best || cand.score > best.score) best = cand;
  };

  for (const app of applications) {
    if (String(app.kind || "").toLowerCase() !== "application") continue;
    if (!sameCompany(proposal.company, app.company)) continue;

    const base = {
      id: app.id,
      company: app.company,
      role: app.role,
      status: app.status,
      applied_date: app.applied_date || "",
    };

    // 1. Same requisition — not a repost, the SAME listing. Highest confidence.
    if (pReqs.size && reqIndex) {
      const shared = (reqIndex(app) || []).filter((r) => pReqs.has(r));
      if (shared.length) {
        consider({ ...base, score: 1, confidence: "certain", why: `same requisition id (${shared.join(", ")})` });
        continue;
      }
    }

    // 2. Same posting URL.
    const pUrl = String(proposal.job_url || "").trim();
    if (pUrl && pUrl === String(app.job_url || "").trim()) {
      consider({ ...base, score: 1, confidence: "certain", why: "same posting URL" });
      continue;
    }

    // A vague application title cannot be compared on words — skip rather than match everything.
    if (isVagueRole(app.role)) continue;

    const aTok = roleTokens(app.role);
    const aTokNoPlace = roleTokens(app.role, { dropPlace: true });

    // 3. Identical title once seniority/level is normalised away.
    if (aTok.size && pTok.size && jaccard(pTok, aTok) === 1) {
      consider({ ...base, score: 0.98, confidence: "certain", why: "identical role title" });
      continue;
    }

    const j = jaccard(pTok, aTok);

    // 4a. If the ONLY difference between the two titles is territory wording, this is a different
    //     patch, not a repost — and it must be decided BEFORE the subset rule below, which would
    //     otherwise swallow it ("Sales Engineer Jordan" ⊃ "Sales Engineer" and report a repost).
    const diff = [...new Set([...pTok, ...aTok])].filter((w) => !(pTok.has(w) && aTok.has(w)));
    if (diff.length && diff.every((w) => PLACE.has(w)) && pTokNoPlace.size >= 2) {
      consider({
        ...base,
        score: 0.5,
        confidence: "same role, different location",
        why: `same title apart from territory (${diff.join(", ")}) — check whether it is a different patch`,
      });
      continue;
    }

    // 4b. One title contains the other — "Solutions Consultant" vs "Solutions Consultant (Domain
    //    Consultant — SecOps Transformation)". Needs 2+ shared words so a single common word
    //    like "engineer" cannot trigger it.
    const sub = (subsetOf(pTok, aTok) || subsetOf(aTok, pTok)) && [...pTok].filter((w) => aTok.has(w)).length >= 2;
    if (sub) {
      consider({ ...base, score: Math.max(0.8, j), confidence: "likely", why: "one title contains the other" });
      continue;
    }

    if (j >= 0.6) {
      consider({ ...base, score: j, confidence: "likely", why: `titles ${Math.round(j * 100)}% word-identical` });
      continue;
    }

    // 5. Same role, different territory — a real distinction, so it is reported as its own thing
    //    rather than as a repost.
    if (jaccard(pTokNoPlace, aTokNoPlace) >= 0.75 && pTokNoPlace.size >= 2) {
      consider({
        ...base,
        score: 0.5,
        confidence: "same role, different location",
        why: "same title once the territory is removed — check whether it is a different patch",
      });
      continue;
    }

    if (j >= 0.45) {
      consider({ ...base, score: j, confidence: "possible", why: `titles ${Math.round(j * 100)}% word-identical` });
    }
  }
  return best;
}
