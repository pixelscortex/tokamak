#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  ts)
    # Source walkers must finish before SDK checks create/remove .check-* fixtures.
    moon run workspace:format-check workspace:lint-ts
    moon run sdk:check build:check ui:check
    moon run sdk:test
    proto run bun -- test ./.ci/release.test.ts
    ;;
  rust)
    moon run workspace:lint-rust
    ;;
  native)
    moon run workspace:acp-test
    # Protocol generation temporarily uses its fixed SDK output path. Complete
    # its normalized comparison before concurrent TS fixture/type checks.
    moon run server:check
    # Existing scripts supply bundles, generated references and type fixtures.
    moon run workspace:ci-rust app:check lab:check runtime:check render:check engine:check
    moon run :test
    moon run workspace:rust-test workspace:gpu-test
    ;;
  *) exit 2 ;;
esac
