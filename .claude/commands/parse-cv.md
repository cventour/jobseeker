---
description: Parse your uploaded CV (templates/cv/*.pdf) into structured context at data/profile.md, used by prioritization, curation, and applying.
---

Parse my CV into `data/profile.md`.

Steps:

1. Find the CV to parse:
   - `ls -t templates/cv/*.pdf 2>/dev/null | head -1` — the newest uploaded PDF.
   - If none exists, tell me to upload my CV on the dashboard (CV section) first, and stop.
2. **Read** that PDF with the Read tool (it renders PDFs). Extract:
   - `titles` — roles I've held / target-adjacent titles (comma list)
   - `seniority` — e.g. Senior, Principal, Director
   - `skills` — top technical + domain skills (comma list, ~10–15)
   - `domains` — industries/domains (e.g. Cybersecurity, Cloud, Fintech)
   - `locations` — where I'm based / can work
   - a 2–3 sentence **Summary**, a bullet list of **Achievements** (quantified where possible),
     and a compact **Experience** list (company · title · dates · one line).
3. **Write** `data/profile.md` with the Write tool in exactly this shape:

```
---
source_cv: templates/cv/<filename>.pdf
parsed_at: <today's date, YYYY-MM-DD from `date +%F`>
titles: <comma list>
seniority: <comma list>
skills: <comma list>
domains: <comma list>
locations: <comma list>
---

# Summary

<2–3 sentences>

# Achievements

- <bullet>
- <bullet>

# Experience

- <Company> · <Title> · <dates> · <one line>
```

4. Log it: `node server/record.mjs log cv-parse "Parsed CV: <filename> → data/profile.md"`.
5. Give me a 3-line confirmation: which file, the top skills/domains you captured, and a note that
   curation/prioritization/applying will now use this.

Notes:
- `data/profile.md` is gitignored (personal) — safe to write real details.
- Overwrite the whole file (it's a single-record file, not an append). Keep the exact key order above.
- Do not invent experience — only what's in the CV. If a field is unclear, leave it brief.
