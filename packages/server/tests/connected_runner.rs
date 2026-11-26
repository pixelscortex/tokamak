#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::process::Command;

#[path = "support/local_runtime.rs"]
mod local_runtime;

#[test]
fn an_outbound_runner_serves_the_callers_actions_and_recovers_after_connection_loss() {
    let result = Command::new("proto")
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/connected-runner.mjs",
        ])
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .arg(local_runtime::runner())
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .output()
        .expect("start the connected Runner driver");
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
