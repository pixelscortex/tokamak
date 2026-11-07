#!/bin/sh
# Real native behavior, not a DOM mock; package contracts run after ui:build.
set -eu
export NODE_ENV=production CARGO_BUILD_JOBS=2 RAYON_NUM_THREADS=2
proto run bun -- check --no-script --project tests/tsconfig.json
proto run bun -- tests/build.ts
proto run bun -- test tests/contracts.test.ts
cargo test --locked --manifest-path ../../Cargo.toml --package render --test ui_elements --jobs 2
