use std::process::Command;

#[allow(dead_code)] // This test needs only the Runner path.
#[path = "support/local_runtime.rs"]
mod local_runtime;

#[test]
fn a_window_routes_runner_queries_and_mutations_to_the_shared_server() {
    let server = std::path::Path::new(env!("CARGO_BIN_EXE_tokamak-server"));
    let runner = local_runtime::runner();
    let result = Command::new("proto")
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/runner-routing.mjs",
        ])
        .arg(server)
        .arg(runner)
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .output()
        .expect("start the shared-server routing test");
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    print!("{}", String::from_utf8_lossy(&result.stdout));
}
