use super::*;
use crate::plugins::{Catalog, Loaded};
use std::{process::Command, sync::OnceLock};

async fn fixture() -> (tempfile::TempDir, Arc<Supervisor>) {
    fixture_kind(false).await
}
async fn fixture_kind(machine: bool) -> (tempfile::TempDir, Arc<Supervisor>) {
    static FILES: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    let files = FILES.get_or_init(|| {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let output = Command::new("proto")
            .args(["run", "bun", "--"])
            .arg("packages/server/tests/build-worker.mjs")
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_str(
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .last()
                .unwrap(),
        )
        .unwrap()
    });
    let directory = tempfile::tempdir().unwrap();
    let plugin = directory.path().join("plugins/worker-test");
    std::fs::create_dir_all(&plugin).unwrap();
    for (name, text) in files {
        std::fs::write(plugin.join(name), text).unwrap();
    }
    let pool = engine::Pool::new(engine::PoolConfig::default()).unwrap();
    let mut loaded = Loaded::load(
        Catalog::read(&directory.path().join("plugins")).unwrap(),
        &pool,
    )
    .await
    .unwrap();
    let loaded = Arc::get_mut(&mut loaded).unwrap();
    let worker = if machine {
        loaded.machines.remove("worker-test")
    } else {
        loaded.workers.remove("worker-test")
    }
    .unwrap();
    (directory, worker)
}
async fn state(worker: &Supervisor) -> Value {
    worker
        .invoke("actions:state".into(), json!({}), local_user_ops())
        .await
        .unwrap()
}

fn local_user_ops() -> Arc<OpRegistry> {
    let mut ops = OpRegistry::new();
    ops.register_sync("user.current", |_| {
        Ok(json!(crate::identity::User::local()))
    })
    .unwrap();
    Arc::new(ops)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deadline_and_dropped_invocation_kill_stuck_worker_then_restart() {
    let (_directory, worker) = fixture().await;
    let first = state(&worker).await;
    let error = worker
        .invoke_with_deadline(
            "actions:cpu".into(),
            json!({}),
            local_user_ops(),
            Duration::from_millis(30),
        )
        .await
        .unwrap_err();
    assert!(error.contains("action deadline exceeded"), "{error}");
    let second = state(&worker).await;
    assert_ne!(first["pid"], second["pid"]);
    assert_eq!(second["count"], 1);
    let running = worker.clone();
    let call = tokio::spawn(async move {
        running
            .invoke("actions:stuck".into(), json!({}), local_user_ops())
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    call.abort();
    let _ = call.await;
    tokio::time::sleep(GRACE + Duration::from_millis(100)).await;
    let third = state(&worker).await;
    assert_ne!(second["pid"], third["pid"]);
    worker.stop().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cooperative_cancel_keeps_worker_and_missing_bun_is_readable() {
    let (_directory, mut worker) = fixture().await;
    let first = state(&worker).await;
    let error = worker
        .invoke_with_deadline(
            "actions:cooperative".into(),
            json!({}),
            local_user_ops(),
            Duration::from_millis(30),
        )
        .await
        .unwrap_err();
    assert!(error.contains("action deadline exceeded"));
    assert_eq!(first["pid"], state(&worker).await["pid"]);
    worker.stop().await;
    let worker = Arc::get_mut(&mut worker).unwrap();
    worker.closed = CancellationToken::new();
    worker.state.get_mut().process = None;
    worker.bun = None;
    assert_eq!(
        worker
            .invoke("actions:state".into(), json!({}), local_user_ops())
            .await
            .unwrap_err(),
        "Plugin worker-test needs Bun: install from https://bun.sh"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn machine_service_starts_restarts_and_cleans_up() {
    let (_directory, machine) = fixture_kind(true).await;
    let mut ops = OpRegistry::new();
    ops.register_sync("machine.configuration", |_| {
        Ok(json!({"machineId":"test-machine", "name":"Test", "hubs":[]}))
    })
    .unwrap();
    machine.start_service(Arc::new(ops));
    let starts = machine.directory.join("starts");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if std::fs::read_to_string(&starts)
                .unwrap_or_default()
                .lines()
                .count()
                >= 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let lines = std::fs::read_to_string(starts).unwrap();
    let lines: Vec<_> = lines.lines().collect();
    assert_eq!(lines.len(), 2);
    assert_ne!(lines[0], lines[1]);
    assert!(lines.iter().all(|line| line.ends_with(":test-machine")));
    machine.stop().await;
    assert!(machine.directory.join("stopped").is_file());
    assert!(
        machine
            .state
            .lock()
            .await
            .process
            .as_ref()
            .unwrap()
            .stopped
            .is_cancelled()
    );
}
