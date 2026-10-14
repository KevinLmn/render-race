#!/usr/bin/env bash
# Fleet helpers.
#   scripts/fleet.sh status            workers known to the coordinator
#   scripts/fleet.sh macbook start     run the MacBook workers in the background
#   scripts/fleet.sh macbook stop
set -euo pipefail
cd "$(dirname "$0")/.."

COORD=${COORD:-http://100.64.0.1:8787}
LOGS=${TMPDIR:-/tmp}/render-race
BIN=dist/darwin-arm64

case "${1:-} ${2:-}" in
  "status ")
    node -e '
      const ws = new WebSocket(process.argv[1].replace(/^http/, "ws") + "/ws")
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return
        const m = JSON.parse(e.data)
        if (m.type !== "workers") return
        for (const w of m.workers) console.log(w.online ? "online " : "offline", w.id.padEnd(14), `${w.threads} threads`)
        process.exit(0)
      }
      setTimeout(() => { console.error("coordinator unreachable"); process.exit(1) }, 5000)' "$COORD"
    ;;
  "macbook start")
    [[ -x $BIN/worker-rust ]] || ./scripts/build.sh
    mkdir -p "$LOGS"
    args=(--coordinator "$COORD" --machine macbook)
    nohup "$BIN/worker-rust" "${args[@]}" >"$LOGS/rust.log" 2>&1 &
    nohup "$BIN/worker-go" "${args[@]}" >"$LOGS/go.log" 2>&1 &
    nohup node "$BIN/worker.mjs" "${args[@]}" >"$LOGS/js.log" 2>&1 &
    echo "macbook workers started, logs in $LOGS"
    ;;
  "macbook stop")
    pkill -f "$BIN/worker" || true # worker-rust, worker-go, worker.mjs
    echo "macbook workers stopped"
    ;;
  *)
    sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
