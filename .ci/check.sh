#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  ts)
    moon run workspace:format-check workspace:lint-ts sdk:check build:check ui:check sdk:test workspace:acp-test
    ;;
  native)
    # Existing scripts supply bundles, generated references and type fixtures.
    moon run workspace:lint-rust app:check lab:check runtime:check render:check server:check engine:check :test
    moon run workspace:rust-test workspace:gpu-test
    ;;
  *) exit 2 ;;
esac
