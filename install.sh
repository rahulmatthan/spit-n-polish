#!/usr/bin/env bash
# Install Spit n Polish as a background service that starts at login and
# restarts if it stops — macOS (launchd) or Linux (systemd user service).
#
#   ./install.sh                         # documents in ~/Documents/Spit n Polish, port 4848
#   ./install.sh --folder ~/Writing --port 5050
#   ./install.sh --uninstall
#
# Re-run it after moving this folder or changing the options.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FOLDER="$HOME/Documents/Spit n Polish"
PORT=4848
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --folder) FOLDER="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "Python 3 is needed: https://www.python.org/downloads/" >&2; exit 1; }
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 9))' || { echo "Python 3.9 or newer is needed" >&2; exit 1; }

# The service gets this shell's PATH, so it finds `claude` the same way you do.
SVC_PATH="$PATH"
URL="http://127.0.0.1:$PORT/"

case "$(uname -s)" in
Darwin)
  PLIST="$HOME/Library/LaunchAgents/com.spitnpolish.server.plist"
  launchctl bootout "gui/$(id -u)/com.spitnpolish.server" 2>/dev/null || true
  if [ "$UNINSTALL" = 1 ]; then rm -f "$PLIST"; echo "Removed. Your documents are untouched."; exit 0; fi
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.spitnpolish.server</string>
  <key>ProgramArguments</key><array>
    <string>$(xml "$PY")</string><string>$(xml "$HERE/server.py")</string>
    <string>--folder</string><string>$(xml "$FOLDER")</string>
    <string>--port</string><string>$PORT</string><string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(xml "$SVC_PATH")</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$HOME/Library/Logs/spitnpolish.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$HOME/Library/Logs/spitnpolish.log")</string>
</dict></plist>
PL
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  LOGS="~/Library/Logs/spitnpolish.log"
  RESTART="launchctl kickstart -k gui/\$(id -u)/com.spitnpolish.server"
  OPEN="open"
  ;;
Linux)
  UNIT="$HOME/.config/systemd/user/spitnpolish.service"
  systemctl --user disable --now spitnpolish 2>/dev/null || true
  if [ "$UNINSTALL" = 1 ]; then rm -f "$UNIT"; systemctl --user daemon-reload; echo "Removed. Your documents are untouched."; exit 0; fi
  mkdir -p "$(dirname "$UNIT")"
  q() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"; }
  cat > "$UNIT" <<UN
[Unit]
Description=Spit n Polish — drafting editor

[Service]
ExecStart=$(q "$PY") $(q "$HERE/server.py") --folder $(q "$FOLDER") --port $PORT --no-open
Environment=$(q "PATH=$SVC_PATH")
Restart=on-failure

[Install]
WantedBy=default.target
UN
  systemctl --user daemon-reload
  systemctl --user enable --now spitnpolish
  LOGS="journalctl --user -u spitnpolish"
  RESTART="systemctl --user restart spitnpolish"
  OPEN="xdg-open"
  ;;
*)
  echo "This script covers macOS and Linux. On Windows run:  python server.py" >&2; exit 1 ;;
esac

for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fs -o /dev/null "$URL" 2>/dev/null && break
  sleep 0.5
done
echo "Spit n Polish is running at $URL — it will start at every login."
echo "  documents: $FOLDER"
echo "  logs:      $LOGS"
echo "  restart:   $RESTART"
echo "  remove:    ./install.sh --uninstall"
"$OPEN" "$URL" >/dev/null 2>&1 || true
