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
# The bash carries its own copies of the config reader and the spend snippets rather than sourcing
# lib/claude-run.sh. This twin dot-sources the library for that plumbing (the snippets are the same
# bytes either way) but keeps the bash's own messages, its own exit codes, and — like the bash — no
# run lock.
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

# Same reader as job-run: config is the source of truth so the dashboard can change the caps.
$Budget = Read-Cfg max_spend_per_run_usd
if (-not $Budget) { $Budget = "5" }
$MonthCap = Read-Cfg max_spend_per_month_usd

New-Item -ItemType Directory -Path ([IO.Path]::Combine($Repo, "data")) -Force | Out-Null
$script:LogFile = $Log
$rc = 1
try {
  Write-RunLog "==================== research-market '$Market' $(Get-LocalStamp) ===================="

  $script:ClaudeBin = Resolve-ClaudeBin
  if (-not $script:ClaudeBin) {
    Write-RunLog "ERROR: 'claude' CLI not found on PATH — cannot research a market without it."
    exit 127
  }

  # Refuse BEFORE spending, exactly as the daily run does. A ceiling that only applies to the
  # scheduled path would be a ceiling with a hole in it.
  if ($MonthCap) {
    $Spent = Get-MonthSpent
    $Over = Test-SpendOver $Spent $MonthCap
    if ($Over -eq "1") {
      Write-RunLog "MONTHLY CEILING REACHED: `$$Spent of `$$MonthCap — not researching '$Market'."
      exit 0
    }
  }

  $Started = Get-UtcStamp
  # stdout only — stderr into this file would break the JSON parse and lose the cost, which is
  # exactly how the daily run's ledger stayed empty for five runs.
  $run = Invoke-Claude "/markets $Market" $Budget
  $Resp = $run.ResponseFile
  $rc = [int]$run.ExitCode
  try {
    if ($run.StderrText) { Write-RunLog $run.StderrText.TrimEnd("`n", "`r") }
    Read-ClaudeResponse $Resp

    $costFile = "$Resp.cost"
    if ((Test-Path -LiteralPath $costFile) -and (Get-Item -LiteralPath $costFile).Length -gt 0) {
      $Cost = [IO.File]::ReadAllText($costFile, $Utf8NoBom).Trim()
      if ($rc -eq 0) { $outcome = "ok" } else { $outcome = "failed" }
      $json = '{"started":"' + $Started + '","cost_usd":' + $Cost + ',"outcome":"' + $outcome + '","detail":"market research: ' + $Market + '"}'
      if (Invoke-Record @("add-spend", $json)) { Write-RunLog "spend recorded: `$$Cost" }
    } else {
      Write-RunLog "spend NOT recorded — no cost returned"
    }
  } finally {
    Remove-Item -LiteralPath $Resp, "$Resp.cost" -Force -ErrorAction SilentlyContinue
  }

  [void](Invoke-Record @("log", "markets", "Market research for '$Market' finished (exit $rc), started from the dashboard"))

  Write-RunLog "==================== done $(Get-LocalStamp) (exit $rc) ===================="
  exit $rc
} catch {
  Write-RunLog "ERROR: $($_.Exception.Message)"
  exit 1
}
