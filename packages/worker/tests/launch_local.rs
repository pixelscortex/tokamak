#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

use tokamak_worker::{LocalRuntime, Process};

#[test]
fn launch_local_defaults_to_quickjs_and_supports_bun() {
    const CHILD: &str = "TOKAMAK_TEST_LAUNCH_DIRECTORY";
    if let Some(directory) = std::env::var_os(CHILD) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let expected = std::env::var("TOKAMAK_TEST_LAUNCH_EXPECTED").unwrap();
        runtime.block_on(check_launch(Path::new(&directory), &expected));
        return;
    }

    // Executable discovery rejects directories writable by other users.
    let directory = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    for (file, script) in [
        (
            "host",
            "#!/bin/sh\nprintf 'host %s %s' \"$*\" \"$TOKAMAK_PLUGIN_HOST_HEAP_MIB\"\n",
        ),
        (
            "bun",
            "#!/bin/sh\nprintf 'bun %s %s' \"$*\" \"$TOKAMAK_WORKER_LANE\"\n",
        ),
    ] {
        let path = directory.path().join(file);
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    let results: Vec<_> = [
        (None, "quickjs"),
        (Some("quickjs"), "quickjs"),
        (Some("bun"), "bun"),
    ]
    .into_iter()
    .map(|(runtime, expected)| {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "launch_local_defaults_to_quickjs_and_supports_bun",
            ])
            .env(CHILD, directory.path())
            .env("TOKAMAK_TEST_LAUNCH_EXPECTED", expected)
            .env("TOKAMAK_PLUGIN_HOST", directory.path().join("host"))
            .env("TOKAMAK_PLUGIN_HOST_HEAP_MIB", "123")
            .env_remove("TOKAMAK_PLUGIN_RUNTIME");
        if let Some(runtime) = runtime {
            command.env("TOKAMAK_PLUGIN_RUNTIME", runtime);
        }
        command.output().unwrap()
    })
    .collect();

    for result in results {
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
    }
}

async fn check_launch(directory: &Path, expected: &str) {
    use tokio::io::AsyncReadExt;
    let (mut process, selected) = Process::launch_local(
        Path::new("entry.js"),
        Path::new("bundle.js"),
        directory,
        &BTreeMap::new(),
        &[directory.to_owned()],
    )
    .unwrap();
    let (_input, mut output, _stderr) = process.pipes().unwrap();
    let mut line = String::new();
    output.read_to_string(&mut line).await.unwrap();
    process.stop().await;
    if expected == "quickjs" {
        assert_eq!(selected, LocalRuntime::QuickJs);
        assert_eq!(line, "host bundle.js 123");
    } else {
        assert_eq!(selected, LocalRuntime::Bun);
        assert_eq!(line, "bun entry.js bundle.js local");
    }
}
