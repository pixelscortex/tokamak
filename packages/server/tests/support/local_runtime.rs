use std::{path::Path, process::Command};

use tokamak_worker::LocalRuntime;

pub fn selected() -> LocalRuntime {
    LocalRuntime::selected().expect("valid local function runtime")
}

#[allow(dead_code)] // Each integration test includes only the entry point it needs.
pub fn driver(command: Command, script: &str, runtime: &LocalRuntime) -> Command {
    driver_for(command, script, runtime, false)
}

pub fn driver_for(
    mut command: Command,
    script: &str,
    runtime: &LocalRuntime,
    runner: bool,
) -> Command {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let host = (*runtime == LocalRuntime::QuickJs).then(|| {
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
        let status = build.status().expect("run Cargo to build the plugin host for local integration tests");
        assert!(status.success(), "building tokamak-plugin-host for local integration tests failed: {status}");
        LocalRuntime::host_path(server).expect("tokamak-plugin-host was built but is missing beside tokamak-server; set TOKAMAK_PLUGIN_HOST to its path")
    });
    let server = Path::new(env!("CARGO_BIN_EXE_tokamak-server"));
    let executable = if runner {
        server.with_file_name(format!("tokamak-runner{}", std::env::consts::EXE_SUFFIX))
    } else {
        server.to_owned()
    };
    command
        .arg(script)
        .arg(executable)
        .current_dir(root)
        .env_remove("TOKAMAK_TEST_PLUGIN_HOST");
    if let Some(host) = host {
        command.env("TOKAMAK_TEST_PLUGIN_HOST", host);
    }
    command
}
