# Put JobSeeker in the Start Menu and on the Desktop. install.ps1 runs this as its last step
# before opening the app, and it is safe to run again at any time.
#
#   powershell -File scripts\win\make-shortcuts.ps1            create (or refresh) the shortcuts
#   powershell -File scripts\win\make-shortcuts.ps1 --remove    take them away again
#
# Three shortcuts, all pointing at wscript.exe rather than powershell.exe, because a shortcut aimed
# at powershell.exe flashes a console window on every click:
#
#   Start Menu\Programs\JobSeeker\JobSeeker.lnk        installer\win\JobSeeker.vbs -> launch.ps1
#   Start Menu\Programs\JobSeeker\Quit JobSeeker.lnk   run-hidden.vbs stop.ps1
#   Desktop\JobSeeker.lnk                              the same as the first
#
# There is a Quit shortcut here and no equivalent on the Mac for the reason spelled out in
# launch.ps1: on Windows the dashboard outlives its window on purpose, so that scheduled runs keep
# working, which means the user needs a way to say stop.
#
# Nothing outside the user's own Start Menu folder and Desktop is touched -- the Start Menu is the
# per-user one under %APPDATA%, never the all-users one, so this needs no administrator rights.

$ErrorActionPreference = "Stop"
Set-StrictMode -Off
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Err([string]$msg) { [Console]::Error.WriteLine($msg) }

# WScript.Shell is COM, so this script genuinely cannot run anywhere but Windows. Say so in one
# line rather than letting a CreateObject failure surface as a stack trace -- install.ps1 prints
# whatever comes back here straight to the person installing.
if ([System.Environment]::OSVersion.Platform -ne "Win32NT") {
  Write-Err "make-shortcuts.ps1 is Windows only — Start Menu and Desktop shortcuts need the Windows shell."
  exit 1
}

$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$WScriptExe = Join-Path $env:SystemRoot "System32\wscript.exe"
$AppVbs = Join-Path $Repo "installer\win\JobSeeker.vbs"
$RunHidden = Join-Path $Repo "scripts\win\run-hidden.vbs"
$StopPs1 = Join-Path $Repo "scripts\win\stop.ps1"
$Icon = Join-Path $Repo "public\favicon.ico"

$StartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\JobSeeker"
$Desktop = Join-Path $env:USERPROFILE "Desktop"

$Shortcuts = @(
  @{ Path = (Join-Path $StartMenu "JobSeeker.lnk")
     Args = ('"{0}"' -f $AppVbs)
     Desc = "Open JobSeeker" },
  @{ Path = (Join-Path $StartMenu "Quit JobSeeker.lnk")
     Args = ('"{0}" "{1}"' -f $RunHidden, $StopPs1)
     Desc = "Stop the JobSeeker dashboard" },
  @{ Path = (Join-Path $Desktop "JobSeeker.lnk")
     Args = ('"{0}"' -f $AppVbs)
     Desc = "Open JobSeeker" }
)

# ---------------------------------------------------------------- --remove
if ($args.Count -ge 1 -and ([string]$args[0]) -eq "--remove") {
  $gone = 0
  foreach ($s in $Shortcuts) {
    if (Test-Path -LiteralPath $s.Path) {
      Remove-Item -LiteralPath $s.Path -Force
      "removed $($s.Path)"
      $gone++
    }
  }
  # Only if it is ours and empty; a folder the user put something else in stays.
  if ((Test-Path -LiteralPath $StartMenu) -and -not (Get-ChildItem -LiteralPath $StartMenu -Force)) {
    Remove-Item -LiteralPath $StartMenu -Force
    "removed $StartMenu"
  }
  if ($gone -eq 0) { "no JobSeeker shortcuts to remove" }
  exit 0
}

# ---------------------------------------------------------------- create
if (-not (Test-Path -LiteralPath $AppVbs)) { Write-Err "missing launcher: $AppVbs"; exit 66 }
if (-not (Test-Path -LiteralPath $RunHidden)) { Write-Err "missing launcher: $RunHidden"; exit 66 }
if (-not (Test-Path -LiteralPath $StartMenu)) { New-Item -ItemType Directory -Path $StartMenu -Force | Out-Null }

# An install that has not been through `npm run build` (or a stripped copy) may not have the icon.
# A shortcut with no icon is a shortcut that still works; a shortcut pointing at a missing .ico is
# a blank white square, so it is better to leave the default than to set one that is not there.
$HasIcon = Test-Path -LiteralPath $Icon

$shell = New-Object -ComObject WScript.Shell
try {
  foreach ($s in $Shortcuts) {
    $lnk = $shell.CreateShortcut($s.Path)     # existing ones are opened and overwritten -- idempotent
    $lnk.TargetPath = $WScriptExe
    $lnk.Arguments = $s.Args
    $lnk.WorkingDirectory = $Repo
    $lnk.Description = $s.Desc
    if ($HasIcon) { $lnk.IconLocation = "$Icon,0" }
    $lnk.Save()
    "created $($s.Path)"
  }
} finally {
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
}
if (-not $HasIcon) { "no icon at $Icon — the shortcuts use the default one" }
exit 0
