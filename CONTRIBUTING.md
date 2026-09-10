# Contributing

Thanks for looking. A few things to know before you spend time on a change.

## Expectations, honestly

This is a personal project that solves one person's problem well. It is maintained **as time
allows** — if an issue sits unanswered for a while, that is bandwidth, not indifference. Bug reports
with a reproduction are always welcome; large features may not be merged if they widen the project
beyond what one person can maintain.

It runs on **macOS and Windows 10/11**, and needs [Claude Code](https://claude.com/claude-code) on
both — the agents are Claude Code agents. Chrome is driven through Apple Events on macOS and through
the JobSeeker Bridge extension (`extension/`, `server/bridge.mjs`) on Windows.

`server/platform.mjs` is the **only** module that branches on the operating system. Every shell
script has a PowerShell twin under `scripts/win/`, and a change to one is a change to both — the
twins' headers say so. Run scripts by name (`npm run <script>`, or `node scripts/run.mjs <name>`)
rather than naming a shell, and check both mappings with `npm run test:platform`, which asserts them
from either OS.

## Cutting a release

`CHANGELOG.md` is the single source for what a release contains. Write the bullets there, in plain
language — what a user gains, not how it was built. "Improved scheduling to reduce the cost of
usage", never "coverage-derived partial state in write_status".

Then generate rather than retype, because a release is precisely the moment nobody re-words the same
list carefully in a second place, and the second place is where the drift begins:

**Start each bullet with the verb that says what kind of change it is.** The dashboard's
"what's new" dialog sorts them into New / Changed / Fixed by that first word — `Added…` and
`You can now…` become New, `Fixed…`, `Stopped…` and `No longer…` become Fixed, and everything else
becomes Changed. Nothing is stored to say which is which, so the sentence has to. A bullet phrased
"Refreshing keeps your tab" lands under Changed; "Fixed refreshing so it keeps your tab" lands under
Fixed, which is where the reader expects it.

Then tag it. `.github/workflows/release.yml` publishes the release from the tag, using the same
`npm run notes` output, after checking that the tag, `package.json` and `CHANGELOG.md` agree:

```bash
npm run notes:site            # regenerates whats-new.html in ../jobseeker-site
git tag v0.7.0 && git push --tags
```

There are no build artifacts to attach — GitHub serves a source tarball for every tag, and that is
what `install.sh` and the updater both download. **A release that is never tagged is an update
nobody is offered**: the dashboard checks `/releases/latest`, so skipping this step silently strands
every install on the version before it.

`whats-new.html` is generated. Editing it directly is safe only until the next release overwrites it.

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
