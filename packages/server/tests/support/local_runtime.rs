use std::{path::Path, process::Command};

#[cfg(feature = "local-runtime")]
#[allow(dead_code)] // Each integration test includes only the entry point it needs.
pub fn driver(command: Command, script: &str) -> Command {
    driver_for(command, script, false)
}

#[cfg(feature = "local-runtime")]
pub fn driver_for(mut command: Command, script: &str, runner: bool) -> Command {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let host = {
        let server = Path::new(env!("CARGO_BIN_EXE_tokamak-server"));
        let probe = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build the host capability probe runtime");
        let check = || probe.block_on(tokamak_worker::require_local_host(server));
        match check() {
            Ok(host) => host,
            Err(error) => {
                if std::env::var_os("TOKAMAK_PLUGIN_HOST").is_some() {
                    panic!("{error}");
                }
                let mut build = Command::new(env!("CARGO"));
                build
                    .args([
                        "build",
                        "--locked",
                        "-p",
                        "tokamak-plugin-host",
                        "--target-dir",
                    ])
                    .arg(server.parent().unwrap().parent().unwrap())
                    .current_dir(&root);
                if let Some(profile) = server
                    .parent()
                    .and_then(Path::file_name)
                    .and_then(|name| name.to_str())
                    .filter(|name| *name != "debug")
                {
                    build.args(["--profile", profile]);
                }
                let status = build
                    .status()
                    .expect("run Cargo to build the plugin host for local integration tests");
                assert!(
                    status.success(),
                    "building tokamak-plugin-host for local integration tests failed: {status}"
                );
                check()
                    .expect("expected a local plugin host beside tokamak-server after building it")
            }
        }
    };
    let server = Path::new(env!("CARGO_BIN_EXE_tokamak-server"));
    let executable = if runner {
        self::runner()
    } else {
        server.to_owned()
    };
    command
        .arg(script)
        .arg(executable)
        .current_dir(root)
        .env("TOKAMAK_TEST_PLUGIN_HOST", host);
    command
}

/// The job can supply the already built Runner. A direct test builds it in the
/// local target directory, including when tokamak-server lives in target/cloud.
#[allow(dead_code)] // Each integration test includes only the entry point it needs.
pub fn runner() -> std::path::PathBuf {
    if let Some(path) = std::env::var_os("TOKAMAK_TEST_RUNNER_BIN") {
        return path.into();
    }
    let server = Path::new(env!("CARGO_BIN_EXE_tokamak-server"));
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let profile = server.parent().unwrap();
    #[cfg(feature = "local-runtime")]
    let target = profile.parent().unwrap().to_owned();
    #[cfg(not(feature = "local-runtime"))]
    let target = root.join("target");
    let mut build = Command::new(env!("CARGO"));
    build
        .args(["build", "--locked", "-p", "tokamak-runner", "--target-dir"])
        .arg(&target)
        .current_dir(root);
    let profile = profile.file_name().unwrap();
    build.arg("--profile").arg(if profile == "debug" {
        "dev".as_ref()
    } else {
        profile
    });
    let status = build.status().expect("run Cargo to build the Runner");
    assert!(status.success(), "building tokamak-runner failed: {status}");
    target
        .join(profile)
        .join(format!("tokamak-runner{}", std::env::consts::EXE_SUFFIX))
}
