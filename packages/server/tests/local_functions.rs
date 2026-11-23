use std::{
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use tokamak_worker::LocalRuntime;

#[path = "support/local_runtime.rs"]
mod local_runtime;

#[test]
fn local_functions_reach_the_live_server_on_the_configured_runtime() {
    run(local_runtime::selected(), None, false);
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn local_functions_reach_the_live_server_on_the_other_runtime() {
    let other = match LocalRuntime::selected().expect("valid local function runtime") {
        LocalRuntime::Bun => LocalRuntime::QuickJs,
        LocalRuntime::QuickJs => LocalRuntime::Bun,
    };
    let setting = other.name();
    run(other, Some(setting), false);
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn default_runtime_runs_local_functions_and_actions_without_bun() {
    run(LocalRuntime::QuickJs, None, true);
}

fn run(runtime: LocalRuntime, setting: Option<&str>, without_bun: bool) {
    let mut command = local_runtime::driver(
        Command::new("bun"),
        "packages/server/tests/local-functions-driver.mjs",
        &runtime,
    );
    if without_bun {
        command
            .env_remove("TOKAMAK_PLUGIN_RUNTIME")
            .arg("--without-bun");
    } else if let Some(setting) = setting {
        command.env("TOKAMAK_PLUGIN_RUNTIME", setting);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("start real client");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().expect("wait for real client") {
            assert!(status.success(), "client exited: {status}");
            break;
        }
        if Instant::now() > deadline {
            #[cfg(unix)]
            // The fixture's server and fake program belong to this test group.
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            panic!("local function acceptance test did not finish");
        }
        thread::sleep(Duration::from_millis(20));
    }
}
