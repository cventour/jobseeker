# Contributing

Thanks for looking. A few things to know before you spend time on a change.

## Expectations, honestly

This is a personal project that solves one person's problem well. It is maintained **as time
allows** — if an issue sits unanswered for a while, that is bandwidth, not indifference. Bug reports
with a reproduction are always welcome; large features may not be merged if they widen the project
beyond what one person can maintain.

It is **macOS only** and needs [Claude Code](https://claude.com/claude-code). That is not an
oversight: it drives Chrome through Apple Events, and the agents are Claude Code agents.

## Rules that are not negotiable

These exist because breaking them has already caused real damage here.

**Zero dependencies.** `package.json` declares no `dependencies` and no `devDependencies`, and it
stays that way. Everything runs on Node built-ins and shell. A pull request that adds a package will
be declined unless it removes more than it adds. CI fails if an install step becomes necessary.

**All writes go through `server/record.mjs`.** It holds a cross-process lock and writes atomically.
Writing to `data/` directly races the agents — before the lock existed this was measured at *2 of 24
rows surviving*, with no error raised anywhere.

**Record ids are validated.** Ids become filenames, so they go through `assertSafeId`. Do not bypass
it; a crafted id was demonstrably able to write outside `data/`.

**Never hardcode personal values.** Company aliases and ignored chats belong in
`config/job-seeker.config.md`, which is gitignored. Anything personal in the tree will eventually be
published.

**Fail loudly.** A quiet success is worse than a failure here — a run that reports `ok` having read
nothing is the bug this project keeps fighting. If a step cannot do its job, say which step and why,
in a form the digest can report.

## Before you open a pull request

```bash
npm run test:concurrency   # writer safety
npm run test:sweep         # a drifted selector must not fake success
npm run test:security      # path traversal, loopback binding, CSRF
```

All three must pass. There is nothing to install first.

If your change touches agent behaviour, read [`.claude/AGENT-RULES.md`](.claude/AGENT-RULES.md) —
particularly **§0**, which is the trust boundary everything else depends on.

## Where things live

| Path | What |
|---|---|
| `server/` | `record.mjs` (the only writer), `dashboard.mjs`, `audit.mjs`, `lock.mjs`, `md.mjs` |
| `scripts/` | setup, the browser layer, the daily run, the test suites |
| `.claude/` | agents, slash commands, and the normative rules |
| `site/` | the static website published to GitHub Pages |
| `docs/` | architecture, requirements, permissions, scheduler |

Design rationale is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Most of the defensive design
exists because something went wrong first, and the reasoning is kept next to the decision — please
keep that habit in anything you add.
