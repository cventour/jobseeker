---
description: Find live openings at your prioritized companies and write ranked proposals (runs role-scout, fanned out per market).
argument-hint: "[market name]"
---

Find roles I can apply to. Arguments: `$ARGUMENTS`

Search strategy (role-scout follows this): **LinkedIn first**, using my Chrome + my saved LinkedIn
job **preferences/recommendations**; then **vendor careers sites via stateless web (WebFetch/WebSearch)
or Playwright — NOT my Chrome session**. Do the vendor-site pass **whenever I ask manually** (or say
"also check the vendor sites"), and to fill gaps for tier-1 vendors.

Steps:
1. `cat data/criteria.md` and `ls data/markets/*.md`.
   - If `$ARGUMENTS` names a market, scope to that one.
   - If `data/profile.md` is still the placeholder, warn me CV-match will be 0 until `/parse-cv`, but proceed.
2. **LinkedIn-first pass — ONE agent, run serially** (interactive): a single `role-scout` reads my
   LinkedIn recommended/for-you jobs and searches my target roles/locations in Chrome (read-only).
   Do **not** fan this pass out per market — Chrome is a serial resource (AGENT-RULES §13), and one
   pass over my recommendations covers every market at once anyway.
3. **Vendor careers-site pass — fan out, max 3 at a time.** If I asked for a manual/thorough run,
   run one `role-scout` **per market** over `data/markets/*.md`. This pass is stateless
   (WebFetch/WebSearch, no Chrome), so the agents don't contend; `server/record.mjs` locks and
   dedupes, so their concurrent writes are safe. But **never launch more than 3 subagents at once**
   (AGENT-RULES §13 — a 7-way fan-out crashed the machine on 2026-07-29); with more markets than
   that, run them in waves and start the next as one finishes.
   Give the scouts the dedupe set once — `node server/record.mjs list-keys` — instead of each of
   them reading every proposal and application file. Remind them to open with
   `node server/record.mjs list-boards` (AGENT-RULES §14) so they use the known ATS endpoints
   instead of re-hunting careers sites, and skip the companies already recorded as
   `browser`/`blocked`/`none`. Anything marked `skip: true` (dismissed by me,
   or already applied) must not be re-proposed.
4. When they finish, show me the **top proposals ranked by priority** (company · role · location ·
   priority) and the total count, and note that they're on the dashboard (Curated proposals) for
   me to review and approve. Say explicitly if any market was skipped or a scout bailed.

Do not apply to anything — this only proposes. Applying happens later via `/apply` with my approval.
