#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  ts)
    moon run workspace:format-check workspace:lint-ts sdk:check build:check ui:check runtime:ts-check app:check workspace:plugins-check workspace:e2e-check
    moon run sdk:test build:test runtime:test ui:test app:test app:web-build
    proto run bun -- test ./.ci/release.test.ts
    ;;
  native)
    moon run workspace:acp-test
    # Protocol generation temporarily uses its fixed SDK output path. Complete
    # its normalized comparison before concurrent TS fixture/type checks.
    moon run server:check
    # Existing scripts supply bundles, generated references and type fixtures.
    moon run workspace:lint-rust engine:check
    cargo check --workspace --all-targets --locked
    moon run workspace:rust-test workspace:e2e
    ;;
  *) exit 2 ;;
esac
