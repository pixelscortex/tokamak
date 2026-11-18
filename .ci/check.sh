#!/usr/bin/env bash
set -euo pipefail
# Fast checks only. Integration, end-to-end and browser suites are not run in CI
# for now; they stay runnable locally (see e2e/README.md).
case "$1" in
  lint)
    # Platform-independent checks run once, in one job.
    moon run workspace:format-check workspace:lint-ts workspace:lint-rust
    ;;
  ts)
    proto run bun -- run typecheck
    moon run sdk:test build:test runtime:test ui:test chat:test app:test app:web-build
    proto run bun -- test ./.ci/release.test.ts
    ;;
  rust)
    # Unit tests inside the Rust crates; the slow suites in packages/*/tests are skipped.
    cargo test --locked --workspace --lib
    ;;
  *) exit 2 ;;
esac
