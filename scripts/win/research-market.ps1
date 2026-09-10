# Research one market: find and rank vendors for it, filling data/markets/<slug>.md.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win\research-market.ps1 "Healthtech"
#
# Twin of scripts/research-market.sh — change both together.
#
# Normally this happens on its own. A market with no `last_reviewed` is reported `stale` by
# server/audit.mjs, and the daily run researches every stale market — so adding a market and
# waiting until tomorrow is the zero-effort path. This script exists for the case where there IS no
# daily run (manual mode), or where waiting is not wanted: the dashboard offers it as a button.
#
# It SPENDS MONEY — a research pass is a Claude call costing roughly a dollar and taking minutes —
# so it carries the same guards as the scheduled run rather than a lighter version of them:
# the monthly ceiling is honoured, the actual cost is recorded to the same ledger, and a run that
# cannot be measured says so instead of quietly counting as free.
#
# Both twins now take the run lock and write data/.markets-run.status.json. Neither did before: the
# dashboard spawns this detached with its output discarded, so a pass that could not start said
# nothing at all while the page promised the companies would appear on reload. The bash side also
# carried its own hand-copied spend snippets and a bare `command -v claude`; it sources the shared
# library now, as this side always has.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location -LiteralPath $Repo

$Market = ""
if ($args.Count -ge 1) { $Market = [string]$args[0] }
if (-not $Market) {
  [Console]::Error.WriteLine("usage: research-market.ps1 <market name>")
  exit 64
}

. "$PSScriptRoot\lib\claude-run.ps1"

$Log = [IO.Path]::Combine($Repo, "data", ".markets-run.log")
$Status = [IO.Path]::Combine($Repo, "data", ".markets-run.status.json")

# The one thing the dashboard can read back. Written at every exit that matters, because the only
# state worse than "failed" on this screen is nothing at all -- which is what it said before.
function Write-Status { # state, detail
  param([string]$State, [string]$Detail)
  $json = @"
{
  "market": "$(ConvertTo-JsonString $Market)",
  "state": "$State",
  "started": "$Started",
  "finished": "$(Get-UtcStamp)",
  "detail": "$(ConvertTo-JsonString $Detail)"
}
"@
  Write-Utf8File $Status ($json + "`n")   # the bash heredoc ends with a newline; match it byte for byte
}

$Started = Get-UtcStamp

New-Item -ItemType Directory -Path ([IO.Path]::Combine($Repo, "data")) -Force | Out-Null
$script:LogFile = $Log
$rc = 1
try {
  Write-RunLog "==================== research-market '$Market' $(Get-LocalStamp) ===================="

  Write-Status "running" "researching $Market"

  # Require-Claude prints where it looked, and puts the directory it found on PATH so anything
  # claude itself shells out to can find its neighbours.
  if (-not (Require-Claude)) {
    Write-Status "failed" "The Claude Code CLI could not be found on this machine."
    exit 127
  }

  # One claude-driven run at a time, whatever started it. This script never took the lock, so the
  # research pass could land on top of a daily run and the two read each other's Chrome tabs
  # (AGENT-RULES §13) -- the exact thing the lock exists to stop.
  if (-not (Take-RunLock "markets")) {
    Write-Status "skipped-busy" "another run was already in progress, so $Market was not researched"
    exit 75
  }

  # Refuse BEFORE spending, exactly as the daily run does. A ceiling that only applies to the
  # scheduled path would be a ceiling with a hole in it.
  if (Test-MonthCeiling) {
    Write-Status "skipped-budget" "monthly spend ceiling reached; $Market was not researched"
    exit 0
  }

  $Budget = Get-RunBudget "5"
  $rc = Invoke-ClaudeRun "/markets $Market" $Budget "market research: $Market"

  [void](Invoke-Record @("log", "markets", "Market research for '$Market' finished (exit $rc), started from the dashboard"))

  if ($rc -eq 0) {
    Write-Status "ok" "$Market researched"
  } else {
    Write-Status "failed" "the research pass exited $rc — see data/.markets-run.log"
  }

  Write-RunLog "==================== done $(Get-LocalStamp) (exit $rc) ===================="
  exit $rc
} catch {
  Write-RunLog "ERROR: $($_.Exception.Message)"
  try { Write-Status "failed" "$($_.Exception.Message)" } catch { }
  exit 1
} finally {
  Release-RunLock
}
