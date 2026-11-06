#!/bin/sh
# Check only this renderer; the parent owns workspace/database acceptance.
set -eu
export CARGO_BUILD_JOBS=2 RAYON_NUM_THREADS=2
proto run bun -- check --no-script --project tsconfig.json
proto run bun -- check --no-script --project tsconfig.tools.json
cargo fmt --package render -- --check
cargo check --locked --package render --all-targets --jobs 2
