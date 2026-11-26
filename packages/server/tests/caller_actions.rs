#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::{
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[path = "support/local_runtime.rs"]
mod local_runtime;

#[test]
fn caller_actions_reach_the_live_server() {
    run(false);
}

#[test]
fn caller_actions_and_actions_run_with_an_empty_path() {
    run(true);
}

fn run(without_bun: bool) {
    let mut command = local_runtime::driver(
        Command::new("bun"),
        "packages/server/tests/caller-actions-driver.mjs",
    );
    if without_bun {
        command.arg("--without-bun");
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
            panic!("caller action acceptance test did not finish");
        }
        thread::sleep(Duration::from_millis(20));
    }
}
