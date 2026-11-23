#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname -s)-$(uname -m)" != Darwin-arm64 ]; then
  echo "This release requires macOS arm64" >&2
  exit 1
fi
# Reserved inputs: wire these to Tauri only when signed releases are introduced.
: "${MACOS_SIGNING_IDENTITY:=}"
: "${MACOS_NOTARIZATION_PROFILE:=}"
if [ -n "$MACOS_SIGNING_IDENTITY$MACOS_NOTARIZATION_PROFILE" ]; then
  echo "Signing and notarization are not implemented; leave the reserved inputs empty" >&2
  exit 1
fi
proto run bun -- run --cwd app tauri build --no-sign --bundles app
output="$PWD/.ci-results/macos-arm64"
mkdir -p "$output"
rm -rf "$output/Tokamak.app"
ditto target/release/bundle/macos/Tokamak.app "$output/Tokamak.app"
ditto -c -k --sequesterRsrc --keepParent "$output/Tokamak.app" "$output/Tokamak-macos-arm64.zip"
tar -czf "$output/server-macos-arm64.tar.gz" -C target/release tokamak-server tokamak-plugin-host
(
  cd "$output"
  shasum -a 256 Tokamak-macos-arm64.zip server-macos-arm64.tar.gz > SHA256SUMS.txt
)
wc -c "$output/Tokamak-macos-arm64.zip" "$output/server-macos-arm64.tar.gz"
