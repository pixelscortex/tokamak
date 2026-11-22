use std::{path::Path, process::Command};

/// Runs the Claude stream-JSON recordings through the real server and provider.
#[test]
fn claude_turns_replay_locally_against_the_real_server() {
    let result = Command::new("proto")
        .args(["run", "bun", "--", "plugins/claude/tests/turns.mjs"])
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "Claude replay:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
