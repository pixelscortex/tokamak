use std::{path::Path, process::Command};

#[test]
fn snapshots_capture_the_fake_agents_worktree_without_touching_the_persons_git_state() {
    let output = Command::new("proto")
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/code-snapshots-driver.mjs",
        ])
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .output()
        .expect("run the code snapshots acceptance driver");
    assert!(
        output.status.success(),
        "code snapshots acceptance:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
