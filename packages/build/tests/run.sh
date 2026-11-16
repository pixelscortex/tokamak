#!/bin/sh
set -eu
mkdir -p dist
proto run bun -- test tests/css.test.ts tests/plugins.test.mjs tests/descriptor.test.ts tests/boundary.test.mjs
cargo test --locked --package tokamak-build --jobs 2
