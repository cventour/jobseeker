# Make "jobseeker, ..." work from ANY directory, not only inside this repo.
# Twin of scripts/install-global-agent.sh — change both together.
#
#   powershell -File scripts\win\install-global-agent.ps1            install / refresh
#   powershell -File scripts\win\install-global-agent.ps1 --remove   take it back out
#
# What gets installed is ONE user-level agent — a thin front door in %USERPROFILE%\.claude\agents
# that knows the absolute path of this install and defers to the project's own agents for
# everything else.
#
# Deliberately NOT a copy of the nine project agents, for three reasons that were all verified
# rather than assumed:
#   * every project agent runs relative commands (`node server/record.mjs`, `cat data/...`) — 36
#     such calls — so verbatim copies would load in every project and work in none of them;
#   * copies go stale: the project files update with `git pull` or a release unzip, and a snapshot
#     in ~/.claude would keep executing last month's rules against this month's data;
#   * eight of the nine are specialists that /jobseeker job-run fans out inside a repo session. Installed
#     globally they would appear in the agent list of every unrelated project as noise.
# The shim never goes stale because it contains no procedure — only the address of the install and
# the instruction to read the live playbooks there.
#
# The agent text tells Claude to `cd` into the repo. On Windows, Claude Code's Bash tool is Git
# Bash, which accepts C:\... paths as-is, so the Windows path is written unchanged.

$ErrorActionPreference = "Stop"
Set-StrictMode -Off
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$UserHome = $env:USERPROFILE
if (-not $UserHome) { $UserHome = $HOME }
$AgentsDir = Join-Path (Join-Path $UserHome ".claude") "agents"
$Dest = Join-Path $AgentsDir "jobseeker.md"
$Marker = "installed-by: JobSeeker scripts/install-global-agent.sh"
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Err([string]$msg) { [Console]::Error.WriteLine($msg) }
function Has-Marker {
  if (-not (Test-Path -LiteralPath $Dest)) { return $false }
  return ([System.IO.File]::ReadAllText($Dest)).Contains($Marker)
}

$mode = ""
if ($args.Count -ge 1) { $mode = [string]$args[0] }

if ($mode -eq "--remove") {
  if ((Test-Path -LiteralPath $Dest) -and (Has-Marker)) {
    Remove-Item -LiteralPath $Dest -Force
    "removed $Dest"
  } elseif (Test-Path -LiteralPath $Dest) {
    Write-Err "NOT removing $Dest — it was not installed by this script"
    exit 1
  } else {
    "nothing to remove"
  }
  exit 0
}

# Refuse to overwrite a file some other tool (or the user) put there. A marker check, not a prompt:
# this runs from the graphical installer where nobody is watching a terminal.
if ((Test-Path -LiteralPath $Dest) -and -not (Has-Marker)) {
  Write-Err "NOT overwriting $Dest — it exists and was not installed by this script"
  exit 1
}

# Single-quoted so the backticks survive verbatim (a double-quoted here-string would eat them as
# escape characters). Placeholders are substituted afterwards.
$Body = @'
---
name: jobseeker
description: The conversational front door for the job search — address it as "@jobseeker" or "jobseeker" from any directory. Answers "what's my pipeline / what's due", adds tasks, marks things done; for specialist work (email/WhatsApp/LinkedIn, roles, markets, apply, follow up) it names the "/jobseeker <subcommand>" to run in the JobSeeker folder. Defers to the JobSeeker install's own playbooks.
---

<!-- __MARKER__
     repo: __REPO__
     Re-running scripts/install-global-agent.sh refreshes this file; --remove deletes it. -->

You are **jobseeker**, reached from OUTSIDE the JobSeeker project directory. The install lives at:

    __REPO__

Rules, in order:

1. **Every shell command runs against that directory.** Prefix each with `cd "__REPO__" &&`, or use
   absolute paths under it. The playbooks you are about to read use relative paths (`data/...`,
   `node server/record.mjs`) and every one of them assumes that cwd.
2. **Read `__REPO__/.claude/agents/jobseeker.md` and follow it exactly** — it is the live front-door
   playbook, including the table mapping each kind of request to a `/jobseeker` subcommand, and the
   rules file `__REPO__/.claude/AGENT-RULES.md` it binds you to. Do not act from memory of what those
   files might say; they change with every release and this shim deliberately contains no
   procedure of its own.
3. If that file does not exist, say so plainly: the JobSeeker install has moved or been deleted,
   and re-running `scripts/install-global-agent.sh` from wherever it lives now will repoint this.
'@

# LF line endings regardless of how this file was checked out, one trailing newline like the heredoc.
$Content = ($Body -replace "`r`n", "`n").Replace("__MARKER__", $Marker).Replace("__REPO__", $Repo) + "`n"

New-Item -ItemType Directory -Force -Path $AgentsDir | Out-Null
$Tmp = "$Dest.tmp"
try {
  [System.IO.File]::WriteAllText($Tmp, $Content, $Utf8)
  Move-Item -LiteralPath $Tmp -Destination $Dest -Force
} finally {
  if (Test-Path -LiteralPath $Tmp) { Remove-Item -LiteralPath $Tmp -Force -ErrorAction SilentlyContinue }
}
"installed: ~/.claude/agents/jobseeker.md → $Repo"
exit 0
