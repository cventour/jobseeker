# Gather everything needed to explain a failed run, into one file on the Desktop.
# macOS twin: scripts/collect-logs.sh — change both together. The redaction rules are NOT
# duplicated here: both call server/redact.mjs, so the two cannot drift apart on the one thing
# that must never differ between them.
#
#   npm run logs
#   powershell -ExecutionPolicy Bypass -File scripts\win\collect-logs.ps1
#
# It READS ONLY. It starts nothing, changes nothing, and sends nothing anywhere: the last thing it
# does is open the containing folder so a person decides where the file goes.

$ErrorActionPreference = "Continue"

function Find-Repo {
  $here = Split-Path -Parent $PSCommandPath
  $cands = @($env:JOBSEEKER_HOME, (Join-Path $here "..\.."), (Join-Path $here ".."), $here, $PWD.Path,
             (Join-Path $env:USERPROFILE "JobSeeker"),
             (Join-Path $env:LOCALAPPDATA "Programs\JobSeeker\app"))
  foreach ($c in $cands) {
    if (-not $c) { continue }
    if ((Test-Path (Join-Path $c "package.json")) -and (Test-Path (Join-Path $c "server\dashboard.mjs"))) {
      return (Resolve-Path $c).Path
    }
  }
  return $null
}

$REPO = Find-Repo
if (-not $REPO) {
  Write-Host "Could not find the JobSeeker folder."
  Write-Host "Run this again from inside it:  npm run logs"
  exit 1
}
Set-Location $REPO
$DATA = if ($env:JOBSEEKER_DATA_DIR) { $env:JOBSEEKER_DATA_DIR } else { Join-Path $REPO "data" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host "Node is not installed on this PC, and this script needs it to strip personal details"
  Write-Host "out of the logs. Install Node (https://nodejs.org) and run this again."
  exit 1
}

$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$desk  = [Environment]::GetFolderPath("Desktop")
if (-not $desk) { $desk = $env:USERPROFILE }
$OUT   = Join-Path $desk "jobseeker-logs_$stamp.txt"
Set-Content -Path $OUT -Value "" -Encoding UTF8

$REDACT = Join-Path $REPO "server\redact.mjs"
function Redact([string]$text) {
  if ($null -eq $text -or $text -eq "") { return "" }
  return ($text | & $node $REDACT $env:USERPROFILE) -join "`n"
}
# Home swapped out here, not at each call site -- see the note in the bash twin. One forgotten call
# site puts the tester's real name in a file that promises it is not there.
function Say([string]$s = "") {
  if ($env:USERPROFILE) { $s = $s.Replace($env:USERPROFILE, "~") }
  Add-Content -Path $OUT -Value $s -Encoding UTF8
}
function Head2([string]$s) {
  Say ""; Say ("=" * 78); Say $s; Say ("=" * 78)
}

# Tail a file, redacted, or say plainly that it is not there. "(absent)" is an answer; silence
# is not — a missing log and an empty log mean different things.
function Show([string]$label, [string]$file, [int]$n = 80) {
  Say ""
  Say "--- $label  [$($file.Replace($REPO + '\',''))] ---"
  if (-not (Test-Path $file)) { Say "(absent - this step has never run on this PC)"; return }
  $lines = Get-Content -Path $file -ErrorAction SilentlyContinue
  if ($null -eq $lines) { Say "(present but not readable)"; return }
  Say "($($lines.Count) lines; last $n)"
  Say (Redact (($lines | Select-Object -Last $n) -join "`n"))
}

# The run logs are mostly prose: whole digests, with the names of real recruiters and real
# companies in them. None of that helps diagnose a crash, and all of it is the tester's private
# business. So these logs are reduced to their skeleton and the narrative in between is dropped
# rather than redacted.
function Skeleton([string]$label, [string]$file, [int]$n = 40) {
  Say ""
  Say "--- $label  [$($file.Replace($REPO + '\',''))]  (run banners and errors only - the digests are left out) ---"
  if (-not (Test-Path $file)) { Say "(absent - this step has never run on this PC)"; return }
  $pat = '^=+ |ERROR|Error:|error:|failed|FAILED|not found|NOT FOUND|Unknown command|blocker:|exit \d|refus|timeout|EADDRINUSE|ENOENT|spend'
  $hits = Get-Content -Path $file -ErrorAction SilentlyContinue | Select-String -Pattern $pat | Select-Object -Last $n
  if (-not $hits) { Say "(no banner or error lines)"; return }
  Say (Redact (($hits | ForEach-Object { $_.Line }) -join "`n"))
}

function Cmd([string]$label, [scriptblock]$block) {
  Say ""
  Say "--- $label ---"
  $o = try { & $block 2>&1 | Out-String } catch { "(failed: $($_.Exception.Message))" }
  Say (Redact (($o -split "`n" | Select-Object -First 40) -join "`n"))
}

Head2 "JobSeeker logs - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say "Collected by scripts\win\collect-logs.ps1. Read-only."
Say ""
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
Say "Windows      $($os.Caption) $($os.Version) ($env:PROCESSOR_ARCHITECTURE)"
Say "node         $(& node --version) at $node"
Say "repo         $REPO"
Say "data         $DATA"
Say "version      $(& node -p "require('$($REPO -replace '\\','/')/package.json').version" 2>$null)"
Say "commit       $(& git -C $REPO rev-parse --short HEAD 2>$null)"
Say "branch       $(& git -C $REPO rev-parse --abbrev-ref HEAD 2>$null)"

# ---- the CLI the whole product depends on --------------------------------------------------------
# A parse that never reached Claude fails with exactly the same message as an unreadable PDF. These
# lines are what separates them, so they come before anything else.
Head2 "The Claude CLI"
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if ($claude) {
  Say "claude       $claude"
  Cmd "claude --version" { claude --version }
} else {
  Say "claude       NOT FOUND ON PATH"
  Say ""
  Say "Nothing that costs money can run without it. Note that an app launched from a shortcut"
  Say "inherits a different PATH than a terminal, so 'it works when I type claude' does not"
  Say "settle this."
}
Say ""
Say "--- project commands the CLI needs to find ---"
$cmds = Join-Path $REPO ".claude\commands"
if (Test-Path $cmds) {
  Say ".claude\commands: $((Get-ChildItem $cmds -Name) -join ' ')"
  if (Test-Path (Join-Path $cmds "parse-cv.md")) { Say "parse-cv.md: present" }
  else { Say "parse-cv.md: MISSING - /parse-cv would fail as 'Unknown command'" }
} else {
  Say ".claude\commands: MISSING ENTIRELY."
  Say "Every slash command (/parse-cv, /job-run, /curate) would fail as 'Unknown command', and the"
  Say "CV step would report 'Nothing could be read' no matter how good the PDF is."
}
if (Test-Path (Join-Path $REPO "CLAUDE.md")) { Say "CLAUDE.md: present" } else { Say "CLAUDE.md: missing" }

# ---- the CV step -----------------------------------------------------------------------------
Head2 "The CV step"
Say ""
Say "--- templates\cv (names, sizes and dates only - no file is copied) ---"
$cvdir = Join-Path $REPO "templates\cv"
if (Test-Path $cvdir) {
  Say (Redact ((Get-ChildItem $cvdir | Format-Table Name, Length, LastWriteTime -AutoSize | Out-String)))
} else {
  Say "(the folder does not exist - nothing has ever been uploaded)"
}
Show "parse status" (Join-Path $DATA ".cv-parse.status.json") 40
Show "parse log (this is the one that says why)" (Join-Path $DATA ".cv-parse.log") 200

Say ""
Say (Redact ((& node (Join-Path $REPO "scripts\cv-probe.mjs") 2>&1 | Out-String)))

Say ""
Say "--- data\profile.md (shape only, never its contents) ---"
$prof = Join-Path $DATA "profile.md"
if (Test-Path $prof) {
  $pi = Get-Item $prof
  Say "size $($pi.Length) bytes, modified $($pi.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))"
  $keys = (Select-String -Path $prof -Pattern '^[a-z_]+:' | ForEach-Object { $_.Matches[0].Value.TrimEnd(':') }) -join ' '
  Say "frontmatter keys present: $keys"
  if (Select-String -Path $prof -Pattern 'No CV parsed yet' -Quiet) {
    Say "content: STILL THE PLACEHOLDER - no CV has ever been read into it."
  } else {
    Say "content: looks like a real parsed profile."
  }
} else { Say "(absent)" }

# ---- the dashboard, which is what the tester was actually looking at -----------------------------
Head2 "The dashboard"
$cfg = Join-Path $REPO "config\job-seeker.config.md"
$port = 4319
if (Test-Path $cfg) {
  $m = Select-String -Path $cfg -Pattern '^dashboard_port:\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}
Say "configured port: $port"
foreach ($p in @($port, 4319, 4320) | Select-Object -Unique) {
  $code = try {
    (Invoke-WebRequest -Uri "http://127.0.0.1:$p/_whoami" -TimeoutSec 4 -UseBasicParsing).StatusCode
  } catch { "no answer" }
  Say "127.0.0.1:$p/_whoami -> $code"
}
Cmd "who is listening" { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Format-Table -AutoSize | Out-String }
Show "dashboard log" (Join-Path $DATA ".dashboard.log") 80
Show "dashboard errors" (Join-Path $DATA ".dashboard.err.log") 80
Show "detached jobs" (Join-Path $DATA ".spawn.log") 60

# ---- everything else that fails quietly ----------------------------------------------------------
Head2 "Other logs"
Show     "setup"                    (Join-Path $DATA ".setup\setup.log") 60
Show     "setup step"               (Join-Path $DATA ".setup\step.log") 60
Show     "dashboard start (stdout)" (Join-Path $DATA ".setup\server.log") 40
Show     "dashboard start (stderr)" (Join-Path $DATA ".setup\server.err.log") 40
Skeleton "run now"                  (Join-Path $DATA ".run-now.log") 40
Show     "run now status"           (Join-Path $DATA ".run-now.status.json") 20
Skeleton "job run"                  (Join-Path $DATA ".job-run.log") 40
Show     "job run status"           (Join-Path $DATA ".job-run.status.json") 30
Show     "browser status"           (Join-Path $DATA ".browser-status.json") 40
Skeleton "bridge"                   (Join-Path $DATA ".bridge.log") 40
Show     "installer"                (Join-Path $env:TEMP "jobseeker-install.log") 80

Head2 "Settings (redacted)"
Show "config" $cfg 100

Head2 "End"

$size = "{0:N0} KB" -f ((Get-Item $OUT).Length / 1KB)
Write-Host ""
Write-Host "Wrote $OUT  ($size)"
Write-Host ""
Write-Host "Email or message that one file back. It is plain text - open it first if you want to see"
Write-Host "exactly what it says. Your CV, your profile and your contacts are not in it; email"
Write-Host "addresses, phone numbers, keys and your user folder name are replaced."
Write-Host ""
Start-Process explorer.exe "/select,`"$OUT`""
