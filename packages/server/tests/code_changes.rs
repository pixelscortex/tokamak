use std::{path::Path, process::Command};

#[test]
fn a_turns_change_card_review_panel_and_branch_come_from_local_git() {
    let output = Command::new("proto")
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/code-changes-driver.mjs",
        ])
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .output()
        .expect("run the code changes acceptance driver");
    assert!(
        output.status.success(),
        "code changes acceptance:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
