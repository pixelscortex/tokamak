use std::{path::Path, process::Command};

/// ai's agent, model and session per thread, end to end with two fake agents:
/// the real server binary, the real builds, real windows, the real local part
/// and the replay program (see ai-threads-driver.mjs and e2e/fake-agent).
#[test]
fn a_thread_keeps_its_choices_and_carries_its_conversation_across_sessions_and_agents() {
    let result = Command::new("proto")
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/ai-threads-driver.mjs",
        ])
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "ai threads acceptance:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
