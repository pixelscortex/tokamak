#!/bin/sh
set -eu
mkdir -p dist
proto run bun -- test tests/css.test.ts
cargo test --locked --package tokamak-build --jobs 2
