# Job-Search Tracker — Implementation Plan

> **SUPERSEDED — kept for history.**
> This is the original design, built around a Google Sheet as the datastore. That approach was
> retired: local Markdown in `data/` is now the source of truth, and the LinkedIn collector
> described here was replaced by `scripts/chat-sweep.mjs`.
> For what the system does today, see [`REQUIREMENTS.md`](REQUIREMENTS.md).


## Context

You were laid off and need one place to track all job-seeking activity across **Gmail** and **LinkedIn**, sync interviews to **Google Calendar**, and (later) **research cybersecurity jobs in Dubai** matched against your resume. This plan starts with the MVP you asked for — **application tracking + automatic Gmail capture** — while deliberately shaping the architecture so nothing has to be rebuilt when we add LinkedIn, calendar, and research, or when you move it from your Mac to the cloud.

### Your decisions (locked in)
- **1b** — Runs locally on your Mac now, **but architected to move to the cloud later** (hard requirement, drives every choice below).
- **2b** — You run guided copy/paste commands; you don't write code. I build; you run.
- **3b** — **Google Sheet is the database**, kept human-readable so you can read/edit it directly (and view on your phone via the Sheets app).
- **4** — Use the open-source **LinkedIn MCP** deployed locally (evaluated below), plus free LinkedIn-email parsing from Gmail as a bonus, plus manual entry.

## Key architectural insight (why this design)

Two things pull in the same direction and define the whole shape:

1. **Google Sheet = shared cloud datastore.** Because the "database" is already in the cloud, the *local* app and a *future cloud* app read/write the exact same data. Migration becomes "point the new host at the same Sheet + set env vars," not a data migration.
2. **LinkedIn must stay local — permanently.** LinkedIn's User Agreement prohibits automated access and bans accounts; datacenter IPs (Vercel/any cloud) are flagged far harder than a residential IP. So the LinkedIn collector runs on your Mac now **and stays there** even after the web UI moves to the cloud. The Sheet is the hand-off point between the local collector and the cloud app.

```
        LOCAL (your Mac, residential IP)              CLOUD (later, Vercel)
  ┌───────────────────────────────────┐        ┌──────────────────────────┐
  │ LinkedIn MCP (stickerdaniel)      │        │ Next.js dashboard UI     │
  │  → inbox, conversations, jobs     │        │  (same code as local)    │
  │ LinkedIn collector script         │───┐    │                          │
  │ Next.js app (dev mode, MVP)       │   │    └───────────▲──────────────┘
  └───────────────────────────────────┘   │                │
                                           ▼                │
                              ┌──────────────────────────────────┐
                              │  GOOGLE SHEET  (human-readable)   │  ◄─ single source of truth
                              │  Applications · Communications ·  │
                              │  Contacts · Activity · (Jobs)     │
                              └──────────────────────────────────┘
                                           ▲
                    Gmail API ─────────────┘  (job emails → LLM extract → rows)
```

The LinkedIn collector always writes to the Sheet locally; the UI can live anywhere.

## LinkedIn MCP evaluation (answering your explicit ask)

**Chosen:** `stickerdaniel/linkedin-mcp-server` — Apache-2.0, actively maintained, ~2.7k★.
- **Tools (16):** profiles (`get_person_profile`, `get_my_profile`, `search_people`), companies (`get_company_profile`, `search_companies`, `get_company_employees`), **jobs** (`search_jobs`, `get_job_details`), **messaging** (`get_inbox`, `get_conversation`, `search_conversations`, `send_message`), session mgmt. Covers both comms-tracking and Dubai job research.
- **Auth:** imports your LinkedIn session cookie from a locally logged-in browser (Chrome/Brave/Edge/Arc). One-time.
- **Run:** `uvx` (recommended), Docker, or from source with `uv`. Local process; we point our collector at it over stdio/MCP.
- **Constraints:** one active session per cookie; tool calls run sequentially (no parallelism); `send_message` has known open issues (so we **read** from LinkedIn, and you send messages manually for now).
- **Risk (must acknowledge):** automated LinkedIn access violates ToS; accounts can be restricted/banned. We mitigate by: residential IP only, low request volume, read-mostly usage, and making all LinkedIn sync **opt-in / on-demand** rather than aggressive polling.

**Impact on cloud move:** none for the UI — but the LinkedIn collector is pinned to local. This is a feature of the design, not a limitation.

## Tech stack

- **App:** Next.js (App Router, TypeScript) — runs locally via `npm run dev` now, deploys to Vercel unchanged later. Vercel tooling is already available in this environment.
- **Datastore:** Google Sheet via the Sheets API, behind a thin typed data-access layer (`lib/store/`) so the UI never touches Sheets directly — lets us swap to Postgres later without touching the UI if you ever outgrow Sheets.
- **Google access:** one Google OAuth "Desktop app" credential (guided setup). Scopes: `gmail.readonly`, `calendar`, `spreadsheets`, `drive.readonly` (resume, later). Token cached locally now; moves to a secret store on cloud migration.
- **Email → structured data:** Claude API (Anthropic) extracts company/role/status/dates/next-action from job emails. One `ANTHROPIC_API_KEY` env var. (Alternative for MVP: run the extraction pass through Claude Code on demand using the already-connected Gmail — but the in-app path is what ports to cloud, so we build that.)
- **LinkedIn:** `stickerdaniel/linkedin-mcp-server` via `uvx`, called by a local collector script.

## Data model — Google Sheet tabs (human-readable)

- **Applications** — `id · company · role · location · status · source · applied_date · last_update · next_action · next_action_date · contact · job_url · notes`. `status` ∈ {Saved, Applied, Screening, Interview, Offer, Rejected, Withdrawn}.
- **Communications** — `id · date · source (Gmail/LinkedIn) · from · subject · summary · related_application_id · thread_url`.
- **Contacts** — `id · name · company · role · email · linkedin_url · notes`.
- **Activity** — append-only log `timestamp · type · detail` (what the sync did — your audit trail).
- **Jobs** (Phase 4) — researched Dubai roles + resume match score.

Header row frozen, dropdowns for `status`, conditional-color by status — so the Sheet is genuinely usable on its own.

## Phased build

**Phase 1 — MVP: Applications + Gmail capture** (first deliverable)
1. Scaffold Next.js app; `lib/store/sheets.ts` data-access layer; create/seed the Sheet with the tabs above.
2. Google OAuth flow (guided one-time credential creation) → cached token.
3. Gmail sync: query job-related mail (recruiters, ATS senders like greenhouse/lever/workday, LinkedIn job emails) → Claude extraction → dedupe → upsert into **Applications** + **Communications**; log to **Activity**.
4. Dashboard UI: applications table + status board, filters/search, manual add/edit, activity feed. Runs at `localhost:3000`.

**Phase 2 — LinkedIn (local collector)**
- Stand up `stickerdaniel/linkedin-mcp-server` via `uvx`; one-time cookie import.
- Collector pulls `get_inbox` / `search_conversations` (job-related) → **Communications**, and links to **Applications**. On-demand button + optional local schedule.

**Phase 3 — Google Calendar sync**
- Detect interview dates from emails/LinkedIn → create/update Calendar events; two-way status reflection into **Applications.next_action**.

**Phase 4 — Resume-matched Dubai cybersecurity research**
- Upload resume (PDF/DOCX) → parse strengths/skills → use LinkedIn `search_jobs` (+ optional web sources) for Dubai cybersecurity roles → score relevance against resume → write ranked results to **Jobs** tab with match rationale.

**Phase 5 — Cloud migration (when you want it)**
- Deploy Next.js to Vercel; move OAuth token + `ANTHROPIC_API_KEY` to Vercel env/secret store; Sheet unchanged. LinkedIn collector **stays on your Mac**, still writing to the same Sheet. Optional: add auth (Clerk) so only you can open the hosted dashboard.

## What you'll run (copy/paste, no coding)

Phase 1 setup, in order (I'll give exact commands/screenshots when we build):
1. Create a Google Cloud project + OAuth "Desktop app" credential; download `credentials.json` (one-time, ~5 min, guided).
2. `npm install` in the project; `npm run setup` (I provide) → opens browser once to authorize Google → creates your Sheet, prints its URL.
3. Paste your `ANTHROPIC_API_KEY` into `.env.local` (I show where to get it).
4. `npm run dev` → open `localhost:3000`; click **Sync Gmail**.

## Verification (end-to-end)

- **Sheet created:** `npm run setup` prints a Sheet URL with the 4 tabs, headers, and dropdowns present.
- **Gmail capture:** click **Sync Gmail** → new rows appear in **Applications**/**Communications** matching real job emails; re-running does **not** duplicate (dedupe check); **Activity** logs the run.
- **UI:** applications render in the table/board; manual add/edit writes back to the Sheet (edit a cell in Sheets → refresh app → change shows — proves both directions).
- **LinkedIn (Phase 2):** `uvx` server starts; after cookie import, collector returns your real inbox threads and writes job-related ones to **Communications**.
- Each phase ships runnable and independently verifiable before moving on.

## Risks & notes
- **LinkedIn ToS:** automated access can get an account restricted/banned. Kept read-mostly, low-volume, residential-IP-only, opt-in. You accept this risk to use Phase 2; the app is fully useful (Gmail + manual) without it.
- **Gmail extraction accuracy:** LLM parsing isn't perfect; every auto-added row is reviewable/editable in the Sheet, and the Activity log shows provenance.
- **Google OAuth verification screen:** as an unverified personal app you'll click through an "unverified app" warning for your own account — expected and safe for personal use.
