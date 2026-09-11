# Read the newest uploaded CV into data/profile.md, by running /jobseeker parse-cv headlessly.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win\parse-cv.ps1
#
# Twin of scripts/parse-cv.sh — change both together.
#
# The welcome wizard starts this the moment a CV is dropped, and then lets you walk on — so this
# writes data/.cv-parse.status.json as it goes, which is the only way the page can tell the
# difference between "still reading" and "died twenty seconds ago". Without that file a failed
# parse is indistinguishable from a slow one, and the wizard would wait forever.
#
# It SPENDS MONEY (a small amount — one PDF read and one file written), and honours the same caps
# as every other path that calls claude.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location -LiteralPath $Repo
. "$PSScriptRoot\lib\claude-run.ps1"

$Log = [IO.Path]::Combine($Repo, "data", ".cv-parse.log")
$Status = [IO.Path]::Combine($Repo, "data", ".cv-parse.status.json")

# Newest PDF, named the way the bash names it (templates/cv/<file>.pdf) so the status file and the
# log read the same on both systems.
$Cv = ""
$CvName = ""
$newest = Get-ChildItem -Path ([IO.Path]::Combine($Repo, "templates", "cv", "*.pdf")) -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest) {
  $CvName = $newest.Name
  $Cv = "templates/cv/$CvName"
}

function Write-Status { # state, detail
  param([string]$State, [string]$Detail)
  New-Item -ItemType Directory -Path ([IO.Path]::Combine($Repo, "data")) -Force | Out-Null
  $json = @"
{
  "state": "$State",
  "file": "$(ConvertTo-JsonString $Cv)",
  "started": "$Started",
  "finished": "$(Get-UtcStamp)",
  "detail": "$(ConvertTo-JsonString $Detail)"
}
"@
  Write-Utf8File $Status ($json + "`n")   # the bash heredoc ends with a newline; match it byte for byte
}

$Started = Get-UtcStamp

if (-not $Cv) {
  Write-Status "failed" "No PDF in templates/cv/ — nothing to read."
  [Console]::Error.WriteLine("no CV to parse")
  exit 66
}

Write-Status "running" "reading $Cv"

$script:LogFile = $Log
$rc = 1
try {
  Write-RunLog "==================== parse-cv '$Cv' $(Get-LocalStamp) ===================="
  if (-not (Require-Claude)) {
    Write-Status "failed" "The Claude Code CLI is not on this machine's PATH."
    Write-Problem "cv-failed" "Reading $CvName could not start: the Claude Code CLI is not on this machine."
    exit 127
  }

  if (Test-MonthCeiling) {
    Write-Status "failed" "The monthly spending limit has been reached, so the CV was not read."
    Write-Problem "cv-failed" "Reading $CvName did not start: the monthly spend ceiling has been reached. Raise it in Settings > Spending."
    exit 0
  }

  # Deliberately NOT under the run lock. Reading a CV touches no browser and no channel, it is the
  # one thing the wizard needs to overlap with everything else, and blocking it behind a 40-minute
  # /jobseeker job-run would strand someone on step 2 with no explanation.
  # How much of the log was already there, so what this run adds can be read back afterwards. The
  # reason a run failed is in what claude said, and the message the wizard shows has to be built
  # from it -- with only the exit code to go on, every failure was reported to the user as "your
  # PDF is probably a scan".
  $before = 0
  if (Test-Path $Log) { $before = @(Get-Content $Log -ErrorAction SilentlyContinue).Count }
  $rc = Invoke-ClaudeRun "/jobseeker parse-cv" (Get-RunBudget "1") "parse CV"
  $runOut = ""
  if (Test-Path $Log) {
    $runOut = (@(Get-Content $Log -ErrorAction SilentlyContinue) | Select-Object -Skip $before) -join "`n"
  }

  # The claim to check is not "claude exited 0" but "data/profile.md now describes a real person".
  # A run that fails halfway can exit clean and leave the placeholder behind, and a wizard that
  # believes the exit code would then pre-fill nothing and explain nothing.
  $parsedSnippet = @'

    const fs=require("fs");
    try{
      const t=fs.readFileSync("data/profile.md","utf8");
      const m=/^titles:[ \t]*(.*)$/m.exec(t);
      process.stdout.write(m && m[1].trim() && !/No CV parsed yet/i.test(t) ? "1" : "0");
    }catch{ process.stdout.write("0"); }
'@
  $p = Invoke-Node -Snippet $parsedSnippet
  $Parsed = $p.Out.Trim()

  if ($rc -eq 0 -and $Parsed -eq "1") {
    Write-Status "ok" "Read $CvName"
  } elseif ($Parsed -eq "1") {
    Write-Status "ok" "Read $CvName (the run reported exit $rc)"
  } else {
    $why = Get-FailureReason $runOut "Nothing could be read from $CvName. If it is a scan rather than a text PDF, export it again from Word, Pages or Google Docs."
    Write-Status "failed" $why
    Write-Problem "cv-failed" "Reading $CvName produced nothing. $why"
  }

  Write-RunLog "==================== done $(Get-LocalStamp) (exit $rc, parsed=$Parsed) ===================="
  exit $rc
} catch {
  Write-RunLog "ERROR: $($_.Exception.Message)"
  try { Write-Status "failed" "The CV could not be read: $($_.Exception.Message)" } catch { }
  exit 1
}
