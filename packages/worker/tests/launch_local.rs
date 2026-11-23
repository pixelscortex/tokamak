#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

use tokamak_worker::{LocalRuntime, Process};

#[test]
fn launch_local_starts_quickjs_when_selected_and_bun_when_unset() {
    const CHILD: &str = "TOKAMAK_TEST_LAUNCH_DIRECTORY";
    if let Some(directory) = std::env::var_os(CHILD) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(check_launch(Path::new(&directory)));
        return;
    }

    let directory = std::env::temp_dir().join(format!("tokamak-launch-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
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
        let path = directory.join(file);
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    let results: Vec<_> = [None, Some("quickjs")]
        .into_iter()
        .map(|runtime| {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "launch_local_starts_quickjs_when_selected_and_bun_when_unset",
                ])
                .env(CHILD, &directory)
                .env("TOKAMAK_PLUGIN_HOST", directory.join("host"))
                .env("TOKAMAK_PLUGIN_HOST_HEAP_MIB", "123")
                .env_remove("TOKAMAK_PLUGIN_RUNTIME");
            if let Some(runtime) = runtime {
                command.env("TOKAMAK_PLUGIN_RUNTIME", runtime);
            }
            command.output().unwrap()
        })
        .collect();

    fs::remove_file(directory.join("host")).unwrap();
    fs::remove_file(directory.join("bun")).unwrap();
    fs::remove_dir(directory).unwrap();
    for result in results {
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
    }
}

async fn check_launch(directory: &Path) {
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
    if std::env::var_os("TOKAMAK_PLUGIN_RUNTIME").is_some() {
        assert_eq!(selected, LocalRuntime::QuickJs);
        assert_eq!(line, "host bundle.js 123");
    } else {
        assert_eq!(selected, LocalRuntime::Bun);
        assert_eq!(line, "bun entry.js bundle.js local");
    }
}
