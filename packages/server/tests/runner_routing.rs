use std::process::Command;

#[allow(dead_code)] // This test needs only the Runner path.
#[path = "support/local_runtime.rs"]
mod local_runtime;

#[test]
fn a_window_routes_runner_queries_and_mutations_to_the_shared_server() {
    let server = std::path::Path::new(env!("CARGO_BIN_EXE_tokamak-server"));
    let runner = local_runtime::runner();
    let mut command = Command::new("proto");
    command
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/runner-routing.mjs",
        ])
        .arg(server)
        .arg(runner)
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."));
    #[cfg(not(feature = "local-runtime"))]
    {
        command.arg("--server-build");
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            assert!(
                std::env::var_os("TOKAMAK_TEST_RUNNER_HOST").is_some(),
                "Set TOKAMAK_TEST_RUNNER_HOST to a plugin host built with local-runtime"
            );
        }
    }
    let result = command
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
