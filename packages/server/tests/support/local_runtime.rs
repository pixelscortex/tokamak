use std::{path::Path, process::Command};

use tokamak_worker::LocalRuntime;

pub fn driver(mut command: Command, script: &str, runtime: &LocalRuntime) -> Command {
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
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_tokamak-server"))
        .current_dir(root)
        .env_remove("TOKAMAK_TEST_PLUGIN_HOST")
        .env(
            "TOKAMAK_PLUGIN_RUNTIME",
            if host.is_some() {
                "quickjs"
            } else {
                "bun"
            },
        );
    if let Some(host) = host {
        command.env("TOKAMAK_TEST_PLUGIN_HOST", host);
    }
    command
}
