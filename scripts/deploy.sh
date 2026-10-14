#!/usr/bin/env bash
# Ships dist/ to the fleet and (re)starts everything as services:
#   vps   coordinator (private listener on Tailscale, public one behind Caddy)
#         + rust/go/js workers, niced so the websites keep priority (systemd)
#   mini  Wake-on-LAN relay + rust/go/js workers (launchd)
#   pc    rust/go/js workers + the CUDA worker inside WSL (systemd)
# The MacBook runs its workers on demand: scripts/fleet.sh macbook start
set -euo pipefail
cd "$(dirname "$0")/.."

# Fleet settings (Tailscale IP, MAC addresses) live in fleet.env, not in git.
if [[ ! -f fleet.env ]]; then
  echo "missing fleet.env: copy fleet.env.example and fill it in" >&2
  exit 1
fi
source fleet.env
COORD="http://$COORD_IP:$COORD_PORT"
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
# Pulls new GitHub releases every 5 minutes (scripts/update.sh).
sudo tee /etc/systemd/system/render-race-update.service >/dev/null <<UNIT
[Unit]
Description=render-race: install the latest release
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=\$(id -un)
ExecStart=\$HOME/render-race/update.sh
UNIT
sudo tee /etc/systemd/system/render-race-update.timer >/dev/null <<UNIT
[Unit]
Description=render-race: check for a new release every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --quiet render-race-rust render-race-go render-race-js
sudo systemctl enable --quiet --now render-race-update.timer
sudo systemctl restart render-race-rust render-race-go render-race-js
systemctl is-active render-race-rust render-race-go render-race-js render-race-update.timer | paste -sd' '
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
  <key>StandardOutPath</key><string>%s/render-race/logs/%s.log</string>
  <key>StandardErrorPath</key><string>%s/render-race/logs/%s.log</string>
</dict></plist>\n' "$label" "$(printf '<string>%s</string>' "$@")" "$MINI_HOME" "$label" "$MINI_HOME" "$label"
}

mini_setup() {
  local R=$MINI_HOME/render-race args=(--coordinator "$COORD" --machine mini --threads 10)
  echo 'set -euo pipefail; mkdir -p ~/Library/LaunchAgents'
  # The coordinator used to run here: remove its agent.
  echo "launchctl bootout gui/\$(id -u)/dev.render-race.coordinator 2>/dev/null || true"
  echo "rm -f \$HOME/Library/LaunchAgents/dev.render-race.coordinator.plist"
  # The relay is bound to the Tailscale IP only: the coordinator calls it, the LAN can't.
  for spec in "wake-relay|$R/coordinator -relay -addr $RELAY_IP:$RELAY_PORT -wake $WAKE" \
    "worker-rust|$R/worker-rust ${args[*]}" \
    "worker-go|$R/worker-go ${args[*]}" \
    "worker-js|$MINI_HOME/.local/node/bin/node $R/worker.mjs ${args[*]}"; do
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
  # Pulls new GitHub releases every 5 minutes (scripts/update.sh).
  local file="\$HOME/Library/LaunchAgents/dev.render-race.updater.plist"
  echo "cat > $file <<'PLIST'"
  printf '<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.render-race.updater</string>
  <key>ProgramArguments</key><array><string>%s/render-race/update.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>%s/render-race/logs/dev.render-race.updater.log</string>
  <key>StandardErrorPath</key><string>%s/render-race/logs/dev.render-race.updater.log</string>
</dict></plist>\n' "$MINI_HOME" "$MINI_HOME" "$MINI_HOME"
  echo "PLIST"
  echo "launchctl bootout gui/\$(id -u)/dev.render-race.updater 2>/dev/null || true"
  echo "for i in 1 2 3 4 5; do launchctl bootstrap gui/\$(id -u) $file 2>/dev/null && break; sleep 1; done"
  echo 'sleep 1; launchctl list | grep render-race'
}

echo "== vps"
ship vps linux-arm64
ssh vps bash -s <<EOF
set -euo pipefail
sudo tee /etc/systemd/system/render-race-coordinator.service >/dev/null <<UNIT
[Unit]
Description=render-race coordinator
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=\$(id -un)
ExecStart=\$HOME/render-race/coordinator -addr $COORD_IP:$COORD_PORT -public-addr 127.0.0.1:$PUBLIC_PORT -wake-relay http://$RELAY_IP:$RELAY_PORT -wakeable $WAKEABLE
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
# Workers reach the private listener over Tailscale only; the public one is loopback.
sudo ufw allow in on tailscale0 to any port $COORD_PORT proto tcp >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --quiet render-race-coordinator
sudo systemctl restart render-race-coordinator
systemctl is-active render-race-coordinator
EOF
linux_setup vps 2 /usr/bin/node 19 | ssh vps bash -s

echo "== mini"
MINI_HOME=$(ssh mini 'echo $HOME') # launchd needs absolute paths
ship mini darwin-arm64
mini_setup | ssh mini bash -s

echo "== pc (WSL)"
ship pc linux-amd64 "$WSL"
linux_setup pc 32 '$HOME/.local/node/bin/node' 0 | ssh pc "$WSL bash -s"
# GPU worker: Python + CuPy from the venv in ~/render-race/gpu-venv.
ssh pc "$WSL env COORD=$COORD bash -s" <<'EOF'
set -euo pipefail
sudo tee /etc/systemd/system/render-race-cuda.service >/dev/null <<UNIT
[Unit]
Description=render-race CUDA worker
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
ExecStart=$HOME/render-race/gpu-venv/bin/python $HOME/render-race/worker-cuda.py --coordinator $COORD --machine pc --threads 16
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --quiet render-race-cuda
sudo systemctl restart render-race-cuda
systemctl is-active render-race-cuda
EOF
