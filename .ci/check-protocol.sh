#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
protocol=packages/sdk/src/protocol.ts
scratch=$(mktemp -d)
cp "$protocol" "$scratch/original.ts"
# The exporter has a fixed output path. Always restore it, including on errors;
# only the temporary generated copy is formatted. No source changes survive.
trap 'cp "$scratch/original.ts" "$protocol"; rm -rf "$scratch"' EXIT
cargo run --locked --package server --features protocol-codegen --bin export-protocol
cp "$protocol" "$scratch/generated.ts"
cp "$scratch/original.ts" "$protocol"
proto run bun -- run oxfmt --stdin-filepath "$protocol" < "$scratch/generated.ts" > "$scratch/formatted.ts"
if ! cmp -s "$protocol" "$scratch/formatted.ts"; then
  diff -u "$protocol" "$scratch/formatted.ts"
  exit 1
fi
