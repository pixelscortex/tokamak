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

check_local_symbols() {
  local build=$1
  shift
  nm -C "$@" | awk -v build="$build" '
    BEGIN {
      count = split("fs modules programs protocol runtime timers", modules)
      for (i = 1; i <= count; i++) patterns[i] = "tokamak_plugin_host::" modules[i] "::"
      patterns[++count] = "tokamak_worker::runner::"
      patterns[++count] = "server::host::worker::"
      # Match method definitions in v0 and legacy mangling, not their closures.
      patterns[++count] = "tokamak_worker::Process>?::launch$"
      patterns[++count] = "tokamak_worker::Process>?::launch_local$"
      patterns[++count] = "tokamak_worker::Process>?::launch_plugin$"
      patterns[++count] = "tokamak_plugin_host::local_plugin::run"
      patterns[++count] = "tokamak_worker::Process>?::launch_runner$"
    }
    /tokamak_plugin_host::action_process::run/ { action_host = 1 }
    /server::host::action_process::/ { action_launcher = 1 }
    {
      for (i = 1; i <= count; i++) if ($0 ~ patterns[i]) seen[i] = 1
    }
    END {
      for (i = 1; i <= count; i++) {
        if (build == "cloud" && seen[i]) {
          print "Local runtime symbol in cloud build: " patterns[i]
          failed = 1
        }
        if (build == "runner" && !seen[i]) {
          print "Missing Runner control symbol: " patterns[i]
          failed = 1
        }
      }
      if (build == "cloud" && (!action_host || !action_launcher)) {
        print "Cloud symbol check requires both unstripped action binaries"
        failed = 1
      }
      exit failed
    }
  '
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
    moon run workspace:format-check workspace:lint-ts workspace:lint-rust workspace:lint-cloud-rust
    ;;
  ts)
    proto run bun -- run typecheck
    moon run sdk:test build:test runtime:test ui:test chat:test ai:test app:test app:web-build
    proto run bun -- test ./.ci/*.test.ts
    ;;
  rust)
    runner_target=${CARGO_TARGET_DIR:-$PWD/target}
    [[ "$runner_target" = /* ]] || runner_target="$PWD/$runner_target"
    cloud_target="$runner_target/cloud"
    # Share fingerprinted dependencies, never the runnable binaries.
    export CARGO_BUILD_BUILD_DIR="${CARGO_BUILD_BUILD_DIR:-$runner_target/build-cache}"
    cargo build --locked -p server -p tokamak-runner -p tokamak-plugin-host
    runner_debug="$runner_target/debug"
    export TOKAMAK_TEST_RUNNER_BIN="$runner_debug/tokamak-runner"
    # Test executables link in the shared cache, away from either real host.
    export TOKAMAK_PLUGIN_HOST="$runner_debug/tokamak-plugin-host"
    test "$("$TOKAMAK_PLUGIN_HOST" --capabilities)" = "actions local"

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

    # Server and host suites are split below; no Tauri bundle is built here.
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test --locked --workspace --lib --exclude tokamak-worker --exclude server
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test --locked -p tokamak-worker -p tokamak-runner
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test --locked -p tokamak-plugin-host --bins --test protocol --test programs

    # Replay traffic reaches the real server and database in both runs. Compare
    # the stored content and order across runtimes, excluding wall-clock times.
    TOKAMAK_TURN_PARITY_DIR=$(mktemp -d)
    export TOKAMAK_TURN_PARITY_DIR
    TOKAMAK_PLUGIN_RUNTIME=bun cargo test --locked -p server --lib host::worker::tests
    echo "Timing Rust integration: Bun fallback"
    time TOKAMAK_PLUGIN_RUNTIME=bun CI=1 cargo test --locked -p server \
      --test claude_turns --test codex_turns --test local_functions --test workers
    # A clean quit must also reap the Bun fallback's processes.
    TOKAMAK_PLUGIN_RUNTIME=bun cargo test --locked -p tokamak-runner --test lifecycle graceful_quit

    # Run the QuickJS replays through the Runner instead of adding a third pass.
    # The Bun supervisor units already ran in the Bun lane above.
    export TOKAMAK_TEST_RUNNER=1
    echo "Timing Rust integration: QuickJS main group"
    time env -u TOKAMAK_PLUGIN_RUNTIME CI=1 cargo test --locked -p server --lib --bins \
      --test actions --test ai_threads --test ai_turns \
      --test chat_threads --test claude_turns \
      --test codex_turns --test data --test data_cancellation --test data_indexes \
      --test identity --test local_functions --test plugins --test schema_indexes \
      --test runner_routing --test sdk_transport --test service --test workers \
      -- --skip host::worker::tests::
    # These suites use real deadlines and Git/hook timing. Run them only
    # after the other test binaries finish compiling and running.
    for suite in ai_liveness code_changes code_snapshots; do
      echo "Timing Rust integration: $suite"
      time env -u TOKAMAK_PLUGIN_RUNTIME CI=1 cargo test --locked -p server --test "$suite"
    done

    # The lifecycle executable exercises launch_runner; the Runner itself
    # launches plugins, not other Runners.
    lifecycle=$(cargo test --locked -p tokamak-runner --test lifecycle --no-run --message-format=json |
      proto run bun -- -e '
        for await (const line of console) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.reason === "compiler-artifact" && message.target.name === "lifecycle" && message.executable) {
            console.log(message.executable);
          }
        }
      ')
    test -n "$lifecycle"
    check_local_symbols runner "$runner_debug/tokamak-server" "$runner_debug/tokamak-runner" \
      "$runner_debug/tokamak-plugin-host" "$lifecycle"
    echo "Runner provides a positive control for every local runtime symbol pattern"

    check_cloud_graph
    cloud=(--locked --no-default-features --target-dir "$cloud_target")
    cargo build "${cloud[@]}" -p server -p tokamak-plugin-host
    cloud_debug="$cloud_target/debug"
    test "$("$cloud_debug/tokamak-plugin-host" --capabilities)" = "actions"
    check_local_symbols cloud "$cloud_debug/tokamak-server" "$cloud_debug/tokamak-plugin-host"
    echo "Cloud binaries exclude local runtime symbols"
    env -u TOKAMAK_PLUGIN_RUNTIME cargo test "${cloud[@]}" -p tokamak-plugin-host --all-targets
    echo "Timing Rust integration: actions-only cloud server"
    time env -u TOKAMAK_PLUGIN_RUNTIME CI=1 TOKAMAK_TEST_RUNNER_HOST="$TOKAMAK_PLUGIN_HOST" \
      TOKAMAK_PLUGIN_HOST="$cloud_debug/tokamak-plugin-host" \
      cargo test "${cloud[@]}" -p server --lib --bins --tests
    ;;
  cloud-graph) check_cloud_graph ;;
  *) exit 2 ;;
esac
