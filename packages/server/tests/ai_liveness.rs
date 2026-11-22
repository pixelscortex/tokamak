use std::{path::Path, process::Command};

/// A turn whose app went away, end to end with the fake agent: the real server
/// binary, the real builds, real windows and local parts (see
/// ai-liveness-driver.mjs). Waits out the real 45-second limit, so it is slow.
#[test]
fn a_silent_turn_is_interrupted_and_a_slow_one_is_not() {
    let result = Command::new("proto")
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/ai-liveness-driver.mjs",
        ])
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "ai liveness acceptance:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
