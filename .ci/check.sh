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

    mkdir -p "$PWD/target"
    fixture_dir=$(mktemp -d "$PWD/target/agent-fixtures.XXXXXX")
    unset TOKAMAK_TURN_PARITY_DIR
    cleanup_rust() {
      for dir in "$fixture_dir" "${TOKAMAK_TURN_PARITY_DIR:-}"; do
        if [[ -n "$dir" && -d "$dir" ]]; then
          find "$dir" ! -type d -exec unlink {} \;
          find "$dir" -depth -type d -exec rmdir {} \;
        fi
      done
    }
    trap cleanup_rust EXIT
    proto run bun -- e2e/fake-agent/build-fixtures.mjs "$fixture_dir"
    export TOKAMAK_AGENT_FIXTURES="$fixture_dir/artifacts"

    # The worker package suite below covers its library tests.
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test --locked --workspace --lib --exclude tokamak-worker
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test --locked -p tokamak-plugin-host -p tokamak-worker -p tokamak-runner

    # Replay traffic reaches the real server and database in both runs. Compare
    # the stored content and order across runtimes, excluding wall-clock times.
    TOKAMAK_TURN_PARITY_DIR=$(mktemp -d)
    export TOKAMAK_TURN_PARITY_DIR
    echo "Timing Rust integration: Bun fallback"
    time TOKAMAK_PLUGIN_RUNTIME=bun CI=1 cargo test --locked -p server \
      --test claude_turns --test codex_turns --test local_functions --test workers
    # A clean quit must also reap the Bun fallback's processes.
    TOKAMAK_PLUGIN_RUNTIME=bun cargo test --locked -p tokamak-runner --test lifecycle graceful_quit

    # Run the QuickJS replays through the Runner instead of adding a third pass.
    export TOKAMAK_TEST_RUNNER=1
    # The workspace library pass already ran the server library's unit tests.
    echo "Timing Rust integration: QuickJS main group"
    time env -u TOKAMAK_PLUGIN_RUNTIME CI=1 cargo test --locked -p server --bins \
      --test actions --test ai_threads --test ai_turns \
      --test chat_threads --test claude_turns \
      --test codex_turns --test data --test data_cancellation --test data_indexes \
      --test identity --test local_functions --test plugins --test schema_indexes \
      --test runner_routing --test sdk_transport --test service --test workers
    # These suites use real deadlines and Git/hook timing. Run them only
    # after the other test binaries finish compiling and running.
    for suite in ai_liveness code_changes code_snapshots; do
      echo "Timing Rust integration: $suite"
      time env -u TOKAMAK_PLUGIN_RUNTIME CI=1 cargo test --locked -p server --test "$suite"
    done
    ;;
  *) exit 2 ;;
esac
