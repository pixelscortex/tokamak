use std::process::Command;

#[path = "local_runtime.rs"]
mod local_runtime;

#[allow(dead_code)] // Each integration test chooses its own mode.
pub fn run(script: &str) {
    dispatch(script, false);
}

#[allow(dead_code)] // Only the two agent replay crates select the Runner.
pub fn replay(script: &str) {
    dispatch(script, std::env::var_os("TOKAMAK_TEST_RUNNER").is_some());
}

fn dispatch(script: &str, use_runner: bool) {
    let mut bun = Command::new("proto");
    bun.args(["run", "bun", "--"]);
    let runtime = local_runtime::selected();
    let output = local_runtime::driver_for(bun, script, &runtime, use_runner)
        .output()
        .expect("run the local acceptance driver");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "{script} on {runtime:?}:\n{stdout}\n{stderr}"
    );
    print!("{stdout}");
}
