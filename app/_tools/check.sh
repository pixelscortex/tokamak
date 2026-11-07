#!/bin/sh
# App types and host ownership compile together; no placeholder test task.
set -eu
proto run bun -- check --no-script --project tsconfig.json
proto run bun -- check --no-script --project tsconfig.tools.json
cargo fmt --package tokamak-app -- --check
cargo check --locked --package tokamak-app --all-targets --jobs 2
