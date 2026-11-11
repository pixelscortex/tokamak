#!/bin/sh
set -eu
mkdir -p dist
proto run bun -- test tests/css.test.ts tests/plugins.test.mjs tests/materials.test.ts tests/fills.test.ts
cargo test --locked --package tokamak-build --jobs 2
