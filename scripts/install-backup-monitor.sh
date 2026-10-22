#!/usr/bin/env bash
# Install the host-side Homeasy backup watchdog as a per-user macOS LaunchAgent.
# Schedule: every 30 minutes and immediately on login. No network messages.
set -euo pipefail

if [[ $# -ne 1 || "$1" != '--install' ]]; then
  echo "Usage: bash $0 --install" >&2
  exit 2
fi

if [[ "$(uname -s)" != 'Darwin' ]]; then
  echo 'This installer is for macOS LaunchAgents only.' >&2
  exit 2
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
monitor_js="$repo_dir/dist/database/backup-monitor.js"
node_bin="$(command -v node)"
docker_bin="$(command -v docker)"
agent_path="$HOME/Library/LaunchAgents/com.homeasy.backup-monitor.plist"
staged_path="$agent_path.pending.$$"

if [[ ! -f "$monitor_js" ]]; then
  echo 'Build first: npm run build' >&2
  exit 2
fi

if [[ -e "$agent_path" && "$(plutil -extract Label raw -o - "$agent_path")" != 'com.homeasy.backup-monitor' ]]; then
  echo "Refusing to modify a LaunchAgent with another label: $agent_path" >&2
  exit 1
fi

"$node_bin" - "$staged_path" "$node_bin" "$monitor_js" "$repo_dir" "$docker_bin" <<'GENERATE_PLIST'
const fs = require('node:fs');
const path = require('node:path');
const [destination, node, script, project, docker] = process.argv.slice(2);
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const entry = (value) => `<string>${escape(value)}</string>`;
const out = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.homeasy.backup-monitor</string>
<key>ProgramArguments</key><array>${[node, script].map(entry).join('')}</array>
<key>WorkingDirectory</key>${entry(project)}
<key>EnvironmentVariables</key><dict>
<key>DATABASE_PATH</key>${entry(path.join(project, 'data/homeasy.db'))}
<key>HOMEASY_DOCKER_BIN</key>${entry(docker)}
<key>PATH</key>${entry(`${path.dirname(docker)}:${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`)}
</dict>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>1800</integer>
<key>StandardOutPath</key>${entry(path.join(project, 'data/backup-monitor.log'))}
<key>StandardErrorPath</key>${entry(path.join(project, 'data/backup-monitor.log'))}
</dict></plist>
`;
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, out, { flag: 'wx', mode: 0o600 });
GENERATE_PLIST

plutil -lint "$staged_path"
if launchctl print "gui/$(id -u)/com.homeasy.backup-monitor" > /dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "$agent_path"
fi
mv "$staged_path" "$agent_path"
launchctl bootstrap "gui/$(id -u)" "$agent_path"
echo "Homeasy backup monitor installed. Agent: $agent_path"
