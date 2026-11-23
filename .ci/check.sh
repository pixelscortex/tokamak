#!/usr/bin/env bash
set -euo pipefail
# Fast checks plus offline agent and plugin integration suites.
case "$1" in
  lint)
    shopt -s nullglob
    for copy in plugins/*/contracts/*.ts; do
      id=$(basename "$copy" .ts)
      owner="plugins/$id/src/contracts.ts"
      if ! cmp -s "$owner" "$copy"; then
        echo "Contract copy $copy differs from $owner" >&2
        exit 1
      fi
    done
    # Replays and every tracked text file: no login, home folder or TOKAMAK_PRIVATE_WORDS.
    proto run bun -- e2e/fake-agent/replay-privacy.mjs
    moon run workspace:format-check workspace:lint-ts workspace:lint-rust
    ;;
  ts)
    proto run bun -- run typecheck
    moon run sdk:test build:test runtime:test ui:test chat:test ai:test app:test app:web-build
    proto run bun -- test ./.ci/*.test.ts
    ;;
  rust)
    cargo build --locked -p tokamak-plugin-host
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test --locked --workspace --lib
    cargo test --locked -p tokamak-plugin-host -p tokamak-worker
    # Replay traffic reaches the real server and database in both runs. Compare
    # the stored content and order across runtimes, excluding wall-clock times.
    TOKAMAK_TURN_PARITY_DIR=$(mktemp -d)
    export TOKAMAK_TURN_PARITY_DIR
    trap 'rm -f "$TOKAMAK_TURN_PARITY_DIR"/{claude,codex}.json; rmdir "$TOKAMAK_TURN_PARITY_DIR"' EXIT
    TOKAMAK_PLUGIN_RUNTIME=bun CI=1 cargo test --locked -p server \
      --test ai_turns --test ai_threads --test ai_liveness --test chat_threads \
      --test code_snapshots --test code_changes --test codex_turns --test claude_turns \
      --test local_functions --test identity --test sdk_transport --test actions --test plugins --test workers
    env -u TOKAMAK_PLUGIN_RUNTIME CI=1 cargo test --locked -p server --tests
    ;;
  *) exit 2 ;;
esac
