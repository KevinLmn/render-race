#!/usr/bin/env bash
# Installs the latest GitHub release if it differs from the one installed here,
# then restarts the render-race services. Runs every 5 minutes on each machine
# (systemd timer on Linux, launchd agent on macOS), installed by deploy.sh.
set -euo pipefail

REPO=KevinLmn/render-race
DIR=$HOME/render-race

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-amd64 ;;
  Linux-aarch64) platform=linux-arm64 ;;
  Darwin-arm64) platform=darwin-arm64 ;;
  *) echo "unsupported platform $(uname -sm)" >&2; exit 1 ;;
esac

tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -m1 '"tag_name"' | cut -d'"' -f4)
[[ -n $tag ]] || { echo "no release found" >&2; exit 1; }
[[ -f $DIR/RELEASE && $(cat "$DIR/RELEASE") == "$tag" ]] && exit 0

# Staging dir on the same filesystem: the final mv is an atomic rename, so a
# running binary is replaced, never overwritten in place.
staging=$(mktemp -d "$DIR/.update.XXXXXX")
trap 'rm -rf "$staging"' EXIT
base="https://github.com/$REPO/releases/download/$tag"
curl -fsSL -o "$staging/pkg.tar.gz" "$base/render-race-$platform.tar.gz"
curl -fsSL -o "$staging/SHA256SUMS" "$base/SHA256SUMS"
expected=$(grep " render-race-$platform.tar.gz\$" "$staging/SHA256SUMS" | cut -d' ' -f1)
actual=$({ sha256sum 2>/dev/null || shasum -a 256; } <"$staging/pkg.tar.gz" | cut -d' ' -f1)
if [[ -z $expected || $expected != "$actual" ]]; then
  echo "checksum mismatch for $tag, not installing" >&2
  exit 1
fi

mkdir "$staging/pkg"
tar -xzf "$staging/pkg.tar.gz" -C "$staging/pkg"
for f in "$staging/pkg"/*; do mv -f "$f" "$DIR/"; done
echo "$tag" >"$DIR/RELEASE"

# Restart everything except this updater.
if [[ $(uname -s) == Darwin ]]; then
  for label in $(launchctl list | awk '/dev\.render-race\./ {print $3}' | grep -v updater); do
    launchctl kickstart -k "gui/$(id -u)/$label"
  done
else
  units=$(systemctl list-units --plain --no-legend --type=service 'render-race-*' | awk '{print $1}' | grep -v update || true)
  [[ -n $units ]] && sudo systemctl restart $units
fi
echo "installed $tag"
