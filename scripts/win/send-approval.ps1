# Send one message you have already approved, from the dashboard.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win\send-approval.ps1 appr_ab12cd
#
# Twin of scripts/send-approval.sh — change both together.
#
# This is the last step of the approval loop, and the ONLY thing in the repo that acts on your
# behalf. It refuses unless the record already says approved/edited — the permission is the
# record, never the click that started this script, so an approval that was rejected, still
# pending, or already sent can never be sent by rerunning this.
#
# Email is not actually sent by anything here: the comms-agent prepares a Gmail draft and you
# press send. LinkedIn is copy/paste. Only WhatsApp goes out directly.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location -LiteralPath $Repo
. "$PSScriptRoot\lib\claude-run.ps1"

$Id = ""
if ($args.Count -ge 1) { $Id = [string]$args[0] }
$Log = [IO.Path]::Combine($Repo, "data", ".approvals.log")

# The id becomes a filename and reaches a slash command, so it is validated against the same shape
# record.mjs enforces rather than merely quoted.
if ($Id -notmatch '^appr_[A-Za-z0-9_-]{1,40}$') {
  [Console]::Error.WriteLine("usage: send-approval.ps1 <appr_id>")
  exit 64
}

New-Item -ItemType Directory -Path ([IO.Path]::Combine($Repo, "data")) -Force | Out-Null
$script:LogFile = $Log
$rc = 1
try {
  Write-RunLog "==================== send-approval '$Id' $(Get-LocalStamp) ===================="

  if (-not (Require-Claude)) {
    [void](Invoke-Record @("approval-dispatch", $Id, "failed", "claude CLI not on PATH"))
    exit 127
  }

  # Re-read the record here, in the process that is about to act. The dashboard checked it too, but
  # between the click and this line the file may have been edited by hand or by an agent, and the
  # check that matters is the one closest to the send.
  $gateSnippet = @'

    const fs=require("fs");
    let t;
    try { t=fs.readFileSync("data/approvals/"+process.argv[1]+".md","utf8"); }
    catch { process.stdout.write("refuse no-such-approval"); process.exit(0); }
    const m=/^---\n([\s\S]*?)\n---/.exec(t) || [];
    const f=(k)=>{ const x=new RegExp("^"+k+":[ \t]*(.*)$","m").exec(m[1]||""); return x?x[1].trim():""; };
    const status=f("status"), dispatch=f("dispatch"), kind=f("kind");
    if(!["approved","edited"].includes(status)) process.stdout.write("refuse status="+(status||"unset"));
    else if(["sent","running"].includes(dispatch)) process.stdout.write("refuse dispatch="+dispatch);
    else if(kind==="apply") process.stdout.write("refuse kind=apply");
    else process.stdout.write("ok");
  
'@
  $g = Invoke-Node -Snippet $gateSnippet -ArgumentList @($Id)
  $Gate = ($g.Out + $g.Err).Trim()   # the bash captures 2>&1

  if ($Gate -ne "ok") {
    Write-RunLog "NOT SENDING $Id — $Gate"
    exit 65
  }

  if (-not (Take-RunLock "send-approval")) { exit 75 }

  [void](Invoke-Record @("approval-dispatch", $Id, "running", "sending from the dashboard"))

  $Budget = Get-RunBudget "1"
  $rc = Invoke-ClaudeRun "/send-approval $Id" $Budget "send approval $Id"

  if ($rc -eq 0) {
    [void](Invoke-Record @("approval-dispatch", $Id, "sent", "sent from the dashboard"))
  } else {
    # `failed` is deliberately re-dispatchable: the send did not happen, so refusing to try again
    # would strand the message with no way forward but hand-editing a file.
    if ($script:RunClaudeDenied) {
      $why = "JobSeeker was not allowed to use the tools it needs (" + $script:RunClaudeDenied + "), so nothing was sent. Update JobSeeker — older copies could not grant them."
    } else {
      $why = "exit $rc — see data/.approvals.log"
    }
    [void](Invoke-Record @("approval-dispatch", $Id, "failed", $why))
    # An approval that silently fails to send is the worst failure in the product: the user believes
    # the message went out. Say so in the activity log too.
    Write-Problem "send-failed" "Approval $Id was not sent. $why"
  }

  Write-RunLog "==================== done $(Get-LocalStamp) (exit $rc) ===================="
  exit $rc
} catch {
  Write-RunLog "ERROR: $($_.Exception.Message)"
  try { [void](Invoke-Record @("approval-dispatch", $Id, "failed", "error: $($_.Exception.Message) — see data/.approvals.log")) } catch { }
  exit 1
} finally {
  Release-RunLock
}
