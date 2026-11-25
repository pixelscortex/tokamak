#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::process::Command;

#[path = "support/local_runtime.rs"]
mod local_runtime;

#[test]
fn actions_run_on_the_selected_machine_with_the_original_call_note() {
    let mut command = Command::new("proto");
    command
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/action-placement.mjs",
        ])
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .arg(local_runtime::runner())
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."));

    if !cfg!(feature = "local-runtime") {
        command.arg("--cloud");
    }

    let output = command.output().expect("start the action placement driver");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
