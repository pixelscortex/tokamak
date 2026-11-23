use std::{
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use tokamak_worker::LocalRuntime;

#[test]
fn local_functions_reach_the_live_server_on_the_configured_runtime() {
    run(LocalRuntime::selected().expect("valid local function runtime"));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn local_functions_reach_the_live_server_on_the_other_runtime() {
    let other = match LocalRuntime::selected().expect("valid local function runtime") {
        LocalRuntime::Bun => LocalRuntime::QuickJs,
        LocalRuntime::QuickJs => LocalRuntime::Bun,
    };
    run(other);
}

fn run(runtime: LocalRuntime) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let host = (runtime == LocalRuntime::QuickJs).then(|| {
        let server = Path::new(env!("CARGO_BIN_EXE_tokamak-server"));
        if let Ok(host) = LocalRuntime::host_path(server) {
            return host;
        }
        assert!(
            std::env::var_os("TOKAMAK_PLUGIN_HOST").is_none(),
            "{}", LocalRuntime::host_path(server).unwrap_err()
        );
        let mut build = Command::new(env!("CARGO"));
        build.args(["build", "--locked", "-p", "tokamak-plugin-host"])
            .current_dir(&root);
        if let Some(profile) = server.parent()
            .and_then(Path::file_name).and_then(|name| name.to_str())
            .filter(|name| *name != "debug") {
            build.args(["--profile", profile]);
        }
        let status = build.status().expect("run Cargo to build the plugin host for local-functions tests");
        assert!(status.success(), "building tokamak-plugin-host for local-functions tests failed: {status}");
        LocalRuntime::host_path(server).expect("tokamak-plugin-host was built but is missing beside tokamak-server; set TOKAMAK_PLUGIN_HOST to its path")
    });
    let mut command = Command::new("bun");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.env_remove("TOKAMAK_TEST_PLUGIN_HOST");
    if let Some(host) = host {
        command.env("TOKAMAK_TEST_PLUGIN_HOST", host);
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
