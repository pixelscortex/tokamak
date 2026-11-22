use std::{
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[test]
fn local_process_lines_reach_live_server_queries_and_the_program_can_be_stopped() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("bun");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .arg("packages/server/tests/local-functions-driver.mjs")
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .current_dir(root)
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
