---
description: Build or refresh ranked vendor/company lists for your target markets. Usage — "/markets" (refresh all), "/markets Fintech" (one market), "/markets add Fintech" (add then build).
argument-hint: "[add] [market name]"
---

Build/refresh my market vendor lists. Arguments: `$ARGUMENTS`

Interpret the arguments:
- **empty** → refresh **every** market listed in `data/criteria.md` (`markets:` line).
- **`add <name>`** → first append `<name>` to the `markets:` list in `data/criteria.md` (if not
  already present, comma-separated), then build that one market.
- **`<name>`** → build/refresh just that market.

Steps:
1. `cat data/criteria.md` to read the current `markets:` list (and to append for `add`).
2. Determine the list of markets to process.
3. **Launch one `prioritization-agent` per market, in parallel — at most 3 at a time** (multiple
   Agent tool calls in a single message). Tell each agent exactly which market it owns. They write
   to distinct `data/markets/<slug>.md` files, so parallel runs don't collide. **Never exceed 3
   concurrent subagents** (AGENT-RULES §13 — a 7-way fan-out crashed the laptop on 2026-07-29); if
   there are more markets than that, run them in waves, starting the next as one returns.
4. When they return, give me a short combined summary: per market, how many companies were ranked
   and the top few, plus any coverage gaps they flagged.

Then remind me I can run `/curate` to find live openings at these prioritized companies, and that
the lists are visible on the dashboard (Markets & vendors).
