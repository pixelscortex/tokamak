#!/usr/bin/env bash
set -euo pipefail
# Fast checks plus offline agent and plugin integration suites.
check_cloud_graph() {
  local graph
  graph=$(cargo tree --locked --no-default-features -p server -p tokamak-plugin-host \
    -e normal,build --prefix none --format '{p} [{f}]')
  if grep -E '^(server|tokamak-worker|tokamak-plugin-host) .*\[.*local-runtime|^(tokamak-runner|tokamak-app|llrt_fetch) v' <<<"$graph"; then
    echo "The cloud binaries must build without the local runtime" >&2
    exit 1
  fi
  echo "Cloud dependency graph excludes the local runtime"
}

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
    cargo build --locked -p tokamak-runner -p tokamak-plugin-host

    # Server and host suites are split below; no Tauri bundle is built here.
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test --locked --workspace --lib --exclude tokamak-worker --exclude server
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test --locked -p tokamak-worker -p tokamak-runner
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test --locked -p tokamak-plugin-host --test protocol --test programs

    # Replay traffic reaches the real server and database in both runs. Compare
    # the stored content and order across runtimes, excluding wall-clock times.
    TOKAMAK_TURN_PARITY_DIR=$(mktemp -d)
    export TOKAMAK_TURN_PARITY_DIR
    cleanup_parity() {
      for file in "$TOKAMAK_TURN_PARITY_DIR"/{claude,codex}.json; do
        if [[ -f "$file" ]]; then unlink "$file"; fi
      done
      if [[ -f "$TOKAMAK_TURN_PARITY_DIR/tokamak-plugin-host" ]]; then
        unlink "$TOKAMAK_TURN_PARITY_DIR/tokamak-plugin-host"
      fi
      rmdir "$TOKAMAK_TURN_PARITY_DIR"
    }
    trap cleanup_parity EXIT
    TOKAMAK_PLUGIN_RUNTIME=bun cargo test --locked -p server --lib host::worker::tests
    time TOKAMAK_PLUGIN_RUNTIME=bun CI=1 cargo test --locked -p server \
      --test claude_turns --test codex_turns --test local_functions --test workers
    # A clean quit must also reap the Bun fallback's processes.
    TOKAMAK_PLUGIN_RUNTIME=bun cargo test --locked -p tokamak-runner --test lifecycle graceful_quit

    # Run the QuickJS replays through the Runner instead of adding a third pass.
    export TOKAMAK_TEST_RUNNER=1
    time env -u TOKAMAK_PLUGIN_RUNTIME CI=1 cargo test --locked -p server \
      --test ai_liveness --test ai_threads --test ai_turns --test chat_threads --test claude_turns \
      --test code_changes --test code_snapshots --test codex_turns --test local_functions

    # Keep a full host for the Runner in runner_routing. The build below
    # replaces the sibling host with the actions-only variant for the server.
    cp "${CARGO_TARGET_DIR:-target}/debug/tokamak-plugin-host" "$TOKAMAK_TURN_PARITY_DIR/tokamak-plugin-host"
    check_cloud_graph
    cargo build --locked --no-default-features -p server -p tokamak-plugin-host
    # Check the linked debug binaries too, so a missing source gate is caught
    # even if the local module didn't pull in an optional dependency.
    cloud_debug="${CARGO_TARGET_DIR:-target}/debug"
    nm -C "$cloud_debug/tokamak-server" "$cloud_debug/tokamak-plugin-host" | awk '
      /tokamak_plugin_host::action_process::run/ { action_host = 1 }
      /server::host::action_process::/ { action_launcher = 1 }
      /tokamak_plugin_host::(fs|modules|programs|protocol|runtime|timers)::|tokamak_worker::(runner::|Process::launch(_local|_runner)?::)|server::host::worker::/ {
        print "Local runtime symbol in cloud build: " $0
        found = 1
      }
      END {
        if (!action_host || !action_launcher) {
          print "Cloud symbol check requires both unstripped action binaries"
          exit 1
        }
        exit found
      }
    '
    echo "Cloud binaries exclude local runtime symbols"
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test --locked --no-default-features -p tokamak-plugin-host --all-targets
    time env -u TOKAMAK_PLUGIN_RUNTIME CI=1 TOKAMAK_TEST_RUNNER_HOST="$TOKAMAK_TURN_PARITY_DIR/tokamak-plugin-host" \
      cargo test --locked --no-default-features -p server --lib --bins --tests
    ;;
  cloud-graph) check_cloud_graph ;;
  *) exit 2 ;;
esac
