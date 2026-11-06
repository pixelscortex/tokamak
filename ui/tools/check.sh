#!/bin/sh
# Keep build-only Node types separate from QuickJS element source types.
set -eu
proto run bun -- check --no-script --project tsconfig.json
proto run bun -- check --no-script --project tsconfig.tools.json
