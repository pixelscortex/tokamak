use std::process::Command;

#[path = "local_runtime.rs"]
mod local_runtime;

pub fn run(script: &str) {
    let mut bun = Command::new("proto");
    bun.args(["run", "bun", "--"]);
    let runtime = local_runtime::selected();
    let output = local_runtime::driver(bun, script, &runtime)
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
