use std::{path::Path, process::Command};

/// Chat on the new API through the real server binary, the real chat build,
/// two real clients and chat's real local part (see chat-threads-driver.mjs).
#[test]
fn chat_threads_start_on_first_send_and_reach_a_second_window() {
    let result = Command::new("proto")
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/chat-threads-driver.mjs",
        ])
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "chat threads acceptance:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
