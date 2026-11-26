#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::process::Command;

#[path = "support/local_runtime.rs"]
mod local_runtime;

#[test]
fn owned_machine_lifecycle_and_action_routing() {
    let result = Command::new("proto")
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/plugin-machines.mjs",
        ])
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .arg(local_runtime::runner())
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .output()
        .expect("start the plugin machines driver");
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
