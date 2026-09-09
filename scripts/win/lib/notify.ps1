# Best-effort desktop notification. Twin of notify() in scripts/job-run.sh (osascript
# "display notification") — change both together.
#
# A WinRT toast, posted under the PowerShell AUMID so no app registration is needed. It never
# throws: an unattended run must not die because the notification stack was unavailable (non-
# Windows host, Server Core, a session with no interactive desktop). Failure is written to stderr.
#
# Dot-source it:  . "$PSScriptRoot\lib\notify.ps1"
#   Show-Toast -Title "JobSeeker run failed" -Body "Exit 1 after 2 attempt(s)."

function ConvertTo-XmlText([string]$s) {
  if ($null -eq $s) { return "" }
  return $s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;").Replace("'", "&apos;")
}

function Show-Toast {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $false)][string]$Body = ""
  )
  try {
    if ($env:OS -ne "Windows_NT") { throw "not a Windows host" }
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    $xml = "<toast><visual><binding template=""ToastGeneric""><text>" + (ConvertTo-XmlText $Title) +
           "</text><text>" + (ConvertTo-XmlText $Body) + "</text></binding></visual></toast>"
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification -ArgumentList $doc
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
  } catch {
    [Console]::Error.WriteLine("notify: could not show toast (" + $_.Exception.Message + "): " + $Title + " - " + $Body)
  }
}
