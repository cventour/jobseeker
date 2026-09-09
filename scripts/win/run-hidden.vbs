' Runs a PowerShell script with NO console window. Task Scheduler and desktop shortcuts launch this instead of
' powershell.exe directly, so a scheduled or clicked run never flashes a black window. Usage: wscript run-hidden.vbs <script.ps1> [args...]
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & WScript.Arguments(0) & """"
For i = 1 To WScript.Arguments.Count - 1 : cmd = cmd & " """ & WScript.Arguments(i) & """" : Next
sh.Run cmd, 0, False
