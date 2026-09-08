# Run a child process under a hard timeout. Twin of run_with_timeout() in scripts/job-run.sh —
# change both together.
#
# The bash version backgrounds the child and a sleeping watchdog that sends TERM then KILL. Here
# the child is started with Start-Process, waited on with a deadline, and on expiry the WHOLE
# process tree is killed with `taskkill /T /F` — a wedged `claude` is usually wedged in a grandchild
# (claude -> shell -> node), and killing only the root would orphan the thing that is stuck.
#
# Returns the child's exit code, or 124 when the deadline fired (bash returns 143 = SIGTERM; job-
# run.ps1 treats 124 the way job-run.sh treats 143). Output goes to the -StdoutPath / -StderrPath
# files when given — the caller decides what is payload (the claude JSON) and what is log.
#
# Dot-source it:  . "$PSScriptRoot\lib\timeout.ps1"
#   $rc = Invoke-WithTimeout -Seconds 900 -FilePath $node -ArgumentList @("scripts/board-sweep.mjs","--max","15") `
#           -StdoutPath $out -StderrPath $err -WorkingDirectory $repo
#   -OnStarted { param($proc) ... } runs right after launch with the Process object, so a caller
#   can attach a watcher (job-run.ps1 starts rss-guard.ps1 on the child's PID there).

# Quote one argument the way the Microsoft C runtime (and .NET's argument parser) un-quotes it, so
# a JavaScript snippet with spaces, quotes and backslashes survives `node -e` intact. Start-Process
# joins -ArgumentList with spaces and does NOT quote, on both 5.1 and 7 — so we do it ourselves.
function ConvertTo-CmdArg([string]$Arg) {
  if ($null -eq $Arg -or $Arg -eq "") { return '""' }
  if ($Arg -notmatch '[\s"]') { return $Arg }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  $bs = 0
  foreach ($ch in $Arg.ToCharArray()) {
    if ($ch -eq '\') { $bs++ }
    elseif ($ch -eq '"') { [void]$sb.Append('\' * ($bs * 2 + 1)); [void]$sb.Append('"'); $bs = 0 }
    else { if ($bs -gt 0) { [void]$sb.Append('\' * $bs); $bs = 0 }; [void]$sb.Append($ch) }
  }
  if ($bs -gt 0) { [void]$sb.Append('\' * ($bs * 2)) }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function ConvertTo-CmdLine([string[]]$Arguments) {
  $parts = @()
  foreach ($a in $Arguments) { $parts += (ConvertTo-CmdArg $a) }
  return ($parts -join " ")
}

# Kill a process and everything under it. taskkill /T walks the tree on Windows; elsewhere (pwsh on
# macOS/Linux, smoke tests) .NET's Kill(entireProcessTree) does the same where available.
function Stop-ProcessTree([System.Diagnostics.Process]$Process) {
  try {
    if ($Process.HasExited) { return }
    if ($env:OS -eq "Windows_NT") {
      $tk = Join-Path $env:SystemRoot "System32\taskkill.exe"
      if (-not (Test-Path $tk)) { $tk = "taskkill" }
      # One pre-quoted string, never an array: Start-Process joins an array with spaces and does not
      # quote, so every native launch here goes through ConvertTo-CmdLine even when, as with a PID,
      # the arguments cannot carry a quote today.
      $null = Start-Process -FilePath $tk -ArgumentList (ConvertTo-CmdLine @("/T", "/F", "/PID", "$($Process.Id)")) -NoNewWindow -Wait -PassThru
    } else {
      try { $Process.Kill($true) } catch { $Process.Kill() }
    }
  } catch {
    try { $Process.Kill() } catch { }
  }
}

function Invoke-WithTimeout {
  param(
    [Parameter(Mandatory = $true)][int]$Seconds,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $false)][string[]]$ArgumentList = @(),
    [Parameter(Mandatory = $false)][string]$StdoutPath,
    [Parameter(Mandatory = $false)][string]$StderrPath,
    [Parameter(Mandatory = $false)][string]$WorkingDirectory,
    [Parameter(Mandatory = $false)][scriptblock]$OnStarted
  )
  $sp = @{ FilePath = $FilePath; PassThru = $true; NoNewWindow = $true }
  if ($ArgumentList.Count -gt 0) { $sp["ArgumentList"] = (ConvertTo-CmdLine $ArgumentList) }
  if ($StdoutPath) { $sp["RedirectStandardOutput"] = $StdoutPath }
  if ($StderrPath) { $sp["RedirectStandardError"] = $StderrPath }
  if ($WorkingDirectory) { $sp["WorkingDirectory"] = $WorkingDirectory }

  $proc = Start-Process @sp
  # Touching .Handle before the child exits is what makes .ExitCode readable afterwards on 5.1.
  $null = $proc.Handle
  if ($OnStarted) { try { & $OnStarted $proc } catch { [Console]::Error.WriteLine("timeout: OnStarted hook failed: " + $_.Exception.Message) } }

  $finished = $proc.WaitForExit([int]([Math]::Min([long]$Seconds * 1000, [int]::MaxValue)))
  if (-not $finished) {
    Stop-ProcessTree $proc
    try { $null = $proc.WaitForExit(15000) } catch { }
    return 124
  }
  # WaitForExit(ms) returning true can race the exit-code write; the no-arg overload settles it.
  $proc.WaitForExit()
  if ($null -eq $proc.ExitCode) { return 1 }
  return [int]$proc.ExitCode
}
