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
    proto run bun -- e2e/fake-agent/build-fixtures.mjs "$fixture_dir"
    export TOKAMAK_AGENT_FIXTURES="$fixture_dir/artifacts"

    # The worker package suite below covers its library tests.
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test --locked --workspace --lib --exclude tokamak-worker
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test --locked -p tokamak-plugin-host -p tokamak-worker -p tokamak-runner

    # Replay traffic reaches the real server and database in both runs. Compare
    # the stored content and order across runtimes, excluding wall-clock times.
    TOKAMAK_TURN_PARITY_DIR=$(mktemp -d)
    export TOKAMAK_TURN_PARITY_DIR
    cleanup_parity() {
      for file in "$TOKAMAK_TURN_PARITY_DIR"/{claude,codex}.json; do
        if [[ -f "$file" ]]; then unlink "$file"; fi
      done
      rmdir "$TOKAMAK_TURN_PARITY_DIR"
    }
    trap cleanup_parity EXIT
    time TOKAMAK_PLUGIN_RUNTIME=bun CI=1 cargo test --locked -p server \
      --test claude_turns --test codex_turns --test local_functions --test workers
    # A clean quit must also reap the Bun fallback's processes.
    TOKAMAK_PLUGIN_RUNTIME=bun cargo test --locked -p tokamak-runner --test lifecycle graceful_quit

    # Run the QuickJS replays through the Runner instead of adding a third pass.
    export TOKAMAK_TEST_RUNNER=1
    # The liveness test waits out the real deadline, and the snapshot suite
    # also waits on real Git and hook timing. The two code suites share build
    # inputs and run in one group. The groups use separate workspaces;
    # let them run while the rest of the integration binaries execute.
    time env -u TOKAMAK_PLUGIN_RUNTIME CI=1 cargo test --locked -p server \
      --test ai_liveness --test code_changes --test code_snapshots &
    slow_suite=$!
    status=0
    # The workspace library pass already ran the server library's unit tests.
    time env -u TOKAMAK_PLUGIN_RUNTIME CI=1 cargo test --locked -p server --bins \
      --test actions --test ai_threads --test ai_turns \
      --test chat_threads --test claude_turns \
      --test codex_turns --test data --test data_cancellation --test data_indexes \
      --test identity --test local_functions --test plugins --test schema_indexes \
      --test runner_routing --test sdk_transport --test service --test workers || status=$?
    wait "$slow_suite" || status=$?
    exit "$status"
    ;;
  *) exit 2 ;;
esac
