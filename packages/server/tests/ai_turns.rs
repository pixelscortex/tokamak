use std::{path::Path, process::Command};

/// ai's turns end to end with the fake agent: the real server binary, the real
/// builds of chat, ai and the fake agent plugin, real windows, the real local
/// part and the replay program (see ai-turns-driver.mjs and e2e/fake-agent).
#[test]
fn a_turn_streams_the_fake_agents_reply_into_the_thread() {
    let result = Command::new("proto")
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/ai-turns-driver.mjs",
        ])
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "ai turns acceptance:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
