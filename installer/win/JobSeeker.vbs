' What the JobSeeker Start Menu and Desktop shortcuts actually run.
'
' It exists for one reason: a shortcut pointing straight at powershell.exe flashes a black console
' window every single launch. -WindowStyle Hidden does not help -- Windows creates the console
' before PowerShell is running to hide it. wscript.exe creates nothing visible, so clicking
' JobSeeker opens JobSeeker and nothing else. Same trick as scripts\win\run-hidden.vbs, kept
' separate because a shortcut takes no arguments and this one hardcodes its target.
Set fso = CreateObject("Scripting.FileSystemObject")
launch = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "..\..\scripts\win\launch.ps1")
CreateObject("WScript.Shell").Run _
  "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & launch & """", 0, False
