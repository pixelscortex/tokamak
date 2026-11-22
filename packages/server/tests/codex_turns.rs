use std::{path::Path, process::Command};

#[test]
fn codex_replays_through_the_server_and_local_worker() {
    // Exercise the installed provider over the same local worker and protocol path
    // as the desktop client, without requiring a real Codex login in CI.
    let output = Command::new("proto")
        .args(["run", "bun", "--", "plugins/codex/tests/e2e.mjs"])
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Codex replays:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
