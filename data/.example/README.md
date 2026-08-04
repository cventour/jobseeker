# data/ schema (examples)

Your live job-search state lives in `data/` (gitignored). This `data/.example/` folder is the
committed reference so anyone cloning the repo understands the shape. **Markdown is the source
of truth**. Nothing is mirrored anywhere else.

## Layout

```
data/
  criteria.md             # targeting: markets + roles + weights (dashboard-editable, YAML frontmatter)
  profile.md              # parsed CV context (from /parse-cv), YAML frontmatter + body
  markets/<market>.md     # per-market ranked vendor list (Markdown table)
  applications/<id>.md    # one file per application (YAML frontmatter = fields, body = notes)
  proposals/<id>.md       # one file per curated role awaiting your review
  approvals/<id>.md       # one file per pending approval (submit/send)
  communications.md       # append log (Markdown table)
  contacts.md             # people (Markdown table)
  tasks.md                # manual + agent follow-ups (Markdown table)
  activity.md             # append-only audit log (Markdown table, newest first)
```

## Formats

- **Frontmatter records** (`criteria`, `profile`, `applications/*`, `proposals/*`, `approvals/*`):
  a `---` fenced block of flat `key: value` lines, then a free-text Markdown body. Lists are
  comma-separated on one line (e.g. `roles: Product Management, Solution Architect`).
- **Table logs** (`markets/*`, `communications`, `contacts`, `tasks`, `activity`): a standard
  Markdown table; appending = adding a row. The dashboard server and agents both parse
  these leniently (a row is split on `|`).

Field names for applications/communications/contacts match what `server/record.mjs` writes, so the
dashboard reads these directly.
