#!/usr/bin/env bash
# Ships dist/ to the fleet and (re)starts everything as services:
#   mini  coordinator + rust/go/js workers (launchd)
#   vps   rust/go/js workers, niced so the websites keep priority (systemd)
#   pc    rust/go/js workers inside WSL (systemd)
# The MacBook runs its workers on demand: scripts/fleet.sh macbook start
set -euo pipefail
cd "$(dirname "$0")/.."

COORD_IP=100.64.0.1 # mini, Tailscale
COORD="http://$COORD_IP:8787"
WSL='"C:\Program Files\WSL\wsl.exe" -d Ubuntu-24.04 --'

./scripts/build.sh

# ship <ssh-host> <platform> [remote command prefix]
# Double quotes on purpose: the PC goes through cmd.exe, which ignores single quotes.
ship() {
  COPYFILE_DISABLE=1 tar --no-xattrs -C "dist/$2" -cz . | ssh "$1" "${3:-} bash -c \"mkdir -p ~/render-race/logs && tar -xzm -C ~/render-race\""
}

# Linux workers as systemd services. Args: machine threads node-binary nice
linux_setup() {
  cat <<EOF
set -euo pipefail
for lang in rust go js; do
  case \$lang in
    js) exec="$3 \$HOME/render-race/worker.mjs" ;;
    *) exec="\$HOME/render-race/worker-\$lang" ;;
  esac
  sudo tee /etc/systemd/system/render-race-\$lang.service >/dev/null <<UNIT
[Unit]
Description=render-race \$lang worker
After=network-online.target
Wants=network-online.target

[Service]
User=\$(id -un)
ExecStart=\$exec --coordinator $COORD --machine $1 --threads $2
Restart=always
RestartSec=3
Nice=$4

[Install]
WantedBy=multi-user.target
UNIT
done
sudo systemctl daemon-reload
sudo systemctl enable --quiet render-race-rust render-race-go render-race-js
sudo systemctl restart render-race-rust render-race-go render-race-js
systemctl is-active render-race-rust render-race-go render-race-js | paste -sd' '
EOF
}

# launchd agent. Args: label program args...
plist() {
  local label=$1
  shift
  printf '<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key><array>%s</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$HOME/render-race/logs/%s.log</string>
  <key>StandardErrorPath</key><string>$HOME/render-race/logs/%s.log</string>
</dict></plist>\n' "$label" "$(printf '<string>%s</string>' "$@")" "$label" "$label"
}

mini_setup() {
  local R=$HOME/render-race args=(--coordinator "$COORD" --machine mini --threads 10)
  echo 'set -euo pipefail; mkdir -p ~/Library/LaunchAgents'
  # Bound to the Tailscale IP only: reachable from the fleet, not from the LAN.
  for spec in "coordinator|$R/coordinator -addr $COORD_IP:8787" \
    "worker-rust|$R/worker-rust ${args[*]}" \
    "worker-go|$R/worker-go ${args[*]}" \
    "worker-js|$HOME/.local/node/bin/node $R/worker.mjs ${args[*]}"; do
    local name=${spec%%|*} cmd=${spec#*|}
    local label="dev.render-race.$name" file="\$HOME/Library/LaunchAgents/dev.render-race.$name.plist"
    # shellcheck disable=SC2086
    echo "cat > $file <<'PLIST'"
    plist "$label" $cmd
    echo "PLIST"
    echo "launchctl bootout gui/\$(id -u)/$label 2>/dev/null || true"
    # bootout is asynchronous: retry while the old instance is still tearing down.
    echo "for i in 1 2 3 4 5; do launchctl bootstrap gui/\$(id -u) $file 2>/dev/null && break; sleep 1; done"
  done
  echo 'sleep 1; launchctl list | grep render-race'
}

echo "== mini"
ship mini darwin-arm64
mini_setup | ssh mini bash -s

echo "== vps"
ship vps linux-arm64
linux_setup vps 2 /usr/bin/node 19 | ssh vps bash -s

echo "== pc (WSL)"
ship pc linux-amd64 "$WSL"
linux_setup pc 32 '$HOME/.local/node/bin/node' 0 | ssh pc "$WSL bash -s"
