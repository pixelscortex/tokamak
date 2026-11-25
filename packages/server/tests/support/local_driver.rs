use std::process::Command;

#[path = "local_runtime.rs"]
mod local_runtime;

#[allow(dead_code)] // Each integration test chooses its own mode.
pub fn run(script: &str) {
    dispatch(script, false);
}

#[allow(dead_code)] // Agent replays and the two Code integration suites select the Runner.
pub fn replay(script: &str) {
    dispatch(script, true);
}

fn dispatch(script: &str, use_runner: bool) {
    let mut bun = Command::new("proto");
    bun.args(["run", "bun", "--"]);
    let mut command = local_runtime::driver_for(bun, script, use_runner);
    if !use_runner {
        command.env("TOKAMAK_TEST_RUNNER_BIN", local_runtime::runner());
    }
    let output = command.output().expect("run the local acceptance driver");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{script}:\n{stdout}\n{stderr}");
    print!("{stdout}");
}
