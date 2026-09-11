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
    Write-Problem "markets-failed" "Researching '$Market' could not start: the Claude Code CLI is not on this machine."
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
    Write-Problem "markets-failed" "Researching '$Market' did not start: the monthly spend ceiling has been reached. Raise it in Settings > Spending."
    exit 0
  }

  $Budget = Get-RunBudget "5"
  # How much of the log was already there, so what this run adds can be read back afterwards -- the
  # reason a run failed is in what claude said, and the message the dashboard shows is built from it.
  $before = 0
  if (Test-Path $Log) { $before = @(Get-Content $Log -ErrorAction SilentlyContinue).Count }
  $rc = Invoke-ClaudeRun "/jobseeker markets $Market" $Budget "market research: $Market"
  $runOut = ""
  if (Test-Path $Log) {
    $runOut = (@(Get-Content $Log -ErrorAction SilentlyContinue) | Select-Object -Skip $before) -join "`n"
  }

  # The claim to check is not "claude exited 0" but "the list has companies in it that were not
  # there before". Those came apart completely: four consecutive runs were refused every tool they
  # needed, wrote nothing, exited 0, and were each recorded as "<market> researched" while the
  # market file sat at its empty scaffold. Both halves matter -- rows alone would call a stale list
  # from last week a success.
  $checkSnippet = @'

    const fs=require("fs"), path=require("path");
    const name=process.argv[1], since=Date.parse(process.argv[2])||0;
    const slug=(s)=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
    const dir="data/markets";
    let file=path.join(dir, slug(name)+".md");
    // The agent chooses the filename, so a market whose slug does not match falls back to the file
    // that names this market in its own heading.
    try{
      if(!fs.existsSync(file)){
        for(const f of fs.readdirSync(dir).filter(f=>f.endsWith(".md"))){
          const m=/^#\s*Market:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir,f),"utf8"));
          if(m && slug(m[1])===slug(name)){ file=path.join(dir,f); break; }
        }
      }
    }catch{}
    let rows=0, fresh=0;
    try{
      const t=fs.readFileSync(file,"utf8");
      rows=t.split("\n").filter((l)=>{ const s=l.trim();
        return s.startsWith("|") && !/^\|\s*-+/.test(s) && !/^\|\s*company\s*\|/i.test(s); }).length;
      fresh=fs.statSync(file).mtimeMs>=since-1000 ? 1 : 0;
    }catch{}
    process.stdout.write(rows+" "+fresh);

'@
  $rows = 0; $fresh = 0
  $chk = Invoke-Node -Snippet $checkSnippet -ArgumentList @($Market, $Started)
  if ($chk.ExitCode -eq 0) {
    $parts = ($chk.Out.Trim() -split '\s+')
    if ($parts.Count -ge 2) { $rows = [int]$parts[0]; $fresh = [int]$parts[1] }
  }

  if ($rc -eq 0 -and $rows -gt 0 -and $fresh -eq 1) {
    Write-Status "ok" "$Market researched — $rows companies"
    [void](Invoke-Record @("log", "markets", "Market research for '$Market' finished: $rows companies ranked"))
  } else {
    if ($rc -ne 0) {
      $fallback = "The research pass exited $rc — the full output is in data/.markets-run.log."
    } elseif ($rows -gt 0) {
      $fallback = "The run finished but did not update the list — data/markets/ still holds what was there before."
    } else {
      $fallback = "The run finished but wrote no companies, so nothing was saved."
    }
    $why = Get-FailureReason $runOut $fallback
    Write-Status "failed" $why
    # In the activity log, not only in a file under data\ that nobody opens.
    Write-Problem "markets-failed" "Researching '$Market' produced nothing. $why"
    $rc = 1
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
