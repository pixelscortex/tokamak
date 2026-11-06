#!/bin/sh
# Bundle before executing Rust integration tests, without building the database.
set -eu
export NODE_ENV=production CARGO_BUILD_JOBS=2 RAYON_NUM_THREADS=2
proto run bun -- check --no-script --project tests/tsconfig.json
proto run bun -- check --no-script --project tests/tsconfig.tools.json
proto run bun -- tests/bundle.mjs
proto run bun -- ../ui/tests/build.ts
cargo test --locked --package render --jobs 2
