#!/usr/bin/env bash
# Cross-compiles the coordinator and every worker for each machine of the fleet.
# Rust uses cargo-zigbuild (zig as the linker) so no per-target toolchain is needed.
#   dist/<platform>/{coordinator,worker-go,worker-rust,worker.mjs}
set -euo pipefail
cd "$(dirname "$0")/.."

# platform goos goarch rust-target (plain lists: macOS ships bash 3, no associative arrays)
TARGETS="darwin-arm64 darwin arm64 aarch64-apple-darwin
linux-arm64 linux arm64 aarch64-unknown-linux-gnu
linux-amd64 linux amd64 x86_64-unknown-linux-gnu"

echo "$TARGETS" | while read -r platform goos goarch target; do
  out="dist/$platform"
  mkdir -p "$out"
  (cd coordinator && CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath -o "../$out/coordinator" .)
  (cd workers/go && CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath -o "../../$out/worker-go" .)

  if [[ $platform == darwin-* ]]; then
    (cd workers/rust && cargo build --release --quiet --target "$target")
  else
    (cd workers/rust && cargo zigbuild --release --quiet --target "$target")
  fi
  cp "workers/rust/target/$target/release/worker-rust" "$out/"
  cp workers/js/worker.mjs scripts/update.sh "$out/"
  [[ $platform == linux-amd64 ]] && cp workers/cuda/worker.py "$out/worker-cuda.py"
  echo "built $out"
done
