# Keep the machine awake for the life of a scheduled run. Twin of the `caffeinate -u` call in
# scripts/job-run.sh — change both together.
#
# Task Scheduler can wake the PC for the run (WakeToRun, set by scripts/win/set-schedule.ps1), but
# nothing stops it dozing off again mid-run while Chrome is being driven. SetThreadExecutionState
# with ES_CONTINUOUS asks Windows to hold the system (and, with ES_DISPLAY_REQUIRED, the display)
# awake until the same thread clears the request — or the process exits, so a crashed run can never
# pin the machine awake the way a forgotten `caffeinate` could.
#
# The request is PER THREAD. Call Start-KeepAwake / Stop-KeepAwake from the main script thread,
# never from Start-Job or a runspace, or the request dies with that thread.
#
# Dot-source it:  . "$PSScriptRoot\lib\keepawake.ps1"
# On a non-Windows host (pwsh on macOS/Linux, used for the smoke tests) both functions are no-ops.

$script:KeepAwakeType = $null

function Initialize-KeepAwake {
  if ($null -ne $script:KeepAwakeType) { return $true }
  if ($env:OS -ne "Windows_NT") { return $false }
  try {
    $src = @'
using System;
using System.Runtime.InteropServices;
public static class JobSeekerKeepAwake {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
  public const uint ES_CONTINUOUS       = 0x80000000;
  public const uint ES_SYSTEM_REQUIRED  = 0x00000001;
  public const uint ES_DISPLAY_REQUIRED = 0x00000002;
}
'@
    if (-not ("JobSeekerKeepAwake" -as [type])) { Add-Type -TypeDefinition $src -ErrorAction Stop }
    $script:KeepAwakeType = ("JobSeekerKeepAwake" -as [type])
    return ($null -ne $script:KeepAwakeType)
  } catch {
    [Console]::Error.WriteLine("keep-awake unavailable: " + $_.Exception.Message)
    return $false
  }
}

# Hold system + display awake until Stop-KeepAwake (or process exit). Returns $true when the
# request was placed, $false when this host cannot (non-Windows, or the P/Invoke failed).
function Start-KeepAwake {
  if (-not (Initialize-KeepAwake)) { return $false }
  try {
    $flags = [uint32]($script:KeepAwakeType::ES_CONTINUOUS -bor $script:KeepAwakeType::ES_SYSTEM_REQUIRED -bor $script:KeepAwakeType::ES_DISPLAY_REQUIRED)
    $prev = $script:KeepAwakeType::SetThreadExecutionState($flags)
    return ($prev -ne 0)
  } catch {
    [Console]::Error.WriteLine("keep-awake request failed: " + $_.Exception.Message)
    return $false
  }
}

# Release the request: ES_CONTINUOUS alone clears the SYSTEM/DISPLAY_REQUIRED bits set earlier.
function Stop-KeepAwake {
  if ($null -eq $script:KeepAwakeType) { return }
  try { [void]$script:KeepAwakeType::SetThreadExecutionState([uint32]$script:KeepAwakeType::ES_CONTINUOUS) }
  catch { [Console]::Error.WriteLine("keep-awake release failed: " + $_.Exception.Message) }
}
