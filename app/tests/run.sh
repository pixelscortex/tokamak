#!/bin/sh
# TKM-10 final independent tests. The bundle dependency supplies the production
# feature and UI; no raw DB shortcuts or substitute Todo fixtures are built.
set -eu
export NODE_ENV=production CARGO_BUILD_JOBS=2 RAYON_NUM_THREADS=2
proto run bun -- tests/build-todo.ts
proto run bun -- check --no-script --project tests/tsconfig.json
proto run bun -- tests/build-graph.ts
proto run bun -- tests/compiler.ts
proto run bun -- tests/run.ts
cargo build --locked --package server --bin tokamak --jobs 2
proto run bun -- tests/local-server.ts
cargo test --locked --package tokamak-app --test native --test socket --test plugins --jobs 2 -- --test-threads=1
