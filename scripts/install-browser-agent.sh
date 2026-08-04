#!/bin/bash
# Install the browser broker LaunchAgent. Run once. See scripts/browser-agent.sh for why.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.jobseeker.browser"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/scripts/browser-agent.sh</string>
  </array>
  <!-- On demand only: started by launchctl kickstart, never at login, never on a schedule. -->
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$REPO/data/.browser-agent.out.log</string>
  <key>StandardErrorPath</key><string>$REPO/data/.browser-agent.err.log</string>
</dict>
</plist>
PLISTEOF

chmod +x "$REPO/scripts/browser-agent.sh"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL"
echo
echo "macOS will ask ONCE for Automation permission to control Google Chrome, attributed to a"
echo "stable path rather than to a Claude Code version. Click Allow and it will not ask again."
