#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  ts)
    moon run workspace:format-check workspace:lint-ts
    proto run bun -- run typecheck
    moon run sdk:test build:test runtime:test ui:test chat:test app:test app:web-build
    proto run bun -- test ./.ci/release.test.ts
    ;;
  native)
    proto run bun -- run check
    moon run workspace:acp-test
    # Protocol generation temporarily uses its fixed SDK output path. Complete
    # its normalized comparison before concurrent TS fixture/type checks.
    moon run server:check
    # Existing scripts supply bundles, generated references and type fixtures.
    moon run engine:check
    cargo check --workspace --all-targets --locked
    moon run workspace:rust-test workspace:e2e
    proto run bun -- run e2e:browser
    ;;
  *) exit 2 ;;
esac
