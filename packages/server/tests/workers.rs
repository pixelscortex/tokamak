use engine::{Pool, PoolConfig};
use serde_json::{Value, json};
use server::protocol::Request;
use server::{
    Event, Server,
    data::{Database, Storage},
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::Command,
    sync::{Arc, OnceLock},
    time::Duration,
};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn artifacts(legacy: bool) -> &'static BTreeMap<String, String> {
    static FILES: OnceLock<BTreeMap<String, BTreeMap<String, String>>> = OnceLock::new();
    &FILES.get_or_init(|| {
        let output = Command::new("bun")
            .arg("packages/server/tests/build-worker.mjs")
            .current_dir(root())
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
    })[if legacy {
        "legacy"
    } else {
        "portable"
    }]
}
struct Fixture {
    directory: tempfile::TempDir,
    server: Server,
    session: server::Session,
    next: u64,
    _exclusive: tokio::sync::MutexGuard<'static, ()>,
}
impl Fixture {
    async fn new() -> Self {
        static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let exclusive = SERIAL.lock().await;
        let directory = install_fixture(false);
        let server = load_fixture(&directory).await.unwrap();
        let session = server.connect().await.unwrap();
        Self {
            directory,
            server,
            session,
            next: 0,
            _exclusive: exclusive,
        }
    }
    fn start(&mut self, name: &str, args: Value) -> u64 {
        self.next += 1;
        self.session
            .sender()
            .request(Request::Action {
                id: self.next,
                name: format!("worker-test/actions:{name}"),
                args,
            })
            .unwrap();
        self.next
    }
    async fn result(&mut self) -> (u64, Result<Value, String>) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match self.session.recv().await.unwrap().unwrap() {
                    Event::Response { id, result, .. } => {
                        return (id, result);
                    }
                    Event::PluginChanged { .. } => {}
                    event => panic!("{event:?}"),
                }
            }
        })
        .await
        .unwrap()
    }

    async fn call(&mut self, name: &str, args: Value) -> Result<Value, String> {
        let id = self.start(name, args);
        let (actual, result) = self.result().await;
        assert_eq!(id, actual);
        result
    }
    async fn close(self) {
        self.server.close().await.unwrap();
    }
}
fn install_fixture(legacy: bool) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("plugins/worker-test");
    std::fs::create_dir_all(&path).unwrap();
    for (name, text) in artifacts(legacy) {
        std::fs::write(path.join(name), text).unwrap();
    }
    directory
}

async fn load_fixture(directory: &tempfile::TempDir) -> Result<Server, server::Error> {
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    Server::load_plugins(
        Database::open(Storage::Memory).await.unwrap(),
        pool,
        &directory.path().join("plugins"),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_values_ops_concurrency_state_and_crash_recovery() {
    let mut fixture = Fixture::new().await;
    let first = fixture.call("state", json!({})).await.unwrap();
    fixture.next += 1;
    fixture
        .session
        .sender()
        .request(Request::Query {
            id: fixture.next,
            name: "worker-test/actions:pure".into(),
            args: json!({}),
        })
        .unwrap();
    assert_eq!(fixture.result().await.1.unwrap(), json!("QuickJS"));
    assert_eq!(first["count"], 1);
    assert_eq!(first["secret"], Value::Null);
    assert_eq!(first["pid"], Value::Null);
    assert_eq!(first["cwd"], Value::Null);
    let second = fixture.call("state", json!({})).await.unwrap();
    assert_eq!(second["count"], 1);
    assert_eq!(first["pid"], second["pid"]);
    assert_eq!(
        fixture
            .call("roundtrip", json!({"value":"stored through QuickJS"}))
            .await
            .unwrap()["value"],
        "stored through QuickJS"
    );
    let slow = fixture.start("echo", json!({"value":"slow","delay":100}));
    let fast = fixture.start("echo", json!({"value":"fast","delay":0}));
    assert_eq!(fixture.result().await, (fast, Ok(json!("fast"))));
    assert_eq!(fixture.result().await, (slow, Ok(json!("slow"))));
    let env_error = fixture.call("envDenied", json!({})).await.unwrap_err();
    assert!(env_error.contains("env:WORKER_UNGRANTED"), "{env_error}");
    check_action_process_errors(&mut fixture).await;
    assert_eq!(
        fixture.call("dbDenied", json!({})).await.unwrap(),
        Value::Null
    );
    assert!(
        fixture
            .call("echo", json!({"value":1,"delay":0}))
            .await
            .is_err()
    );
    check_action_process_recovery(fixture).await;
}

async fn check_action_process_errors(fixture: &mut Fixture) {
    let thrown = fixture.call("thrown", json!({})).await.unwrap_err();
    assert!(
        thrown.contains("action error sentinel") && thrown.contains("actions.ts:"),
        "{thrown}"
    );
    let error = fixture.call("networkDenied", json!({})).await.unwrap_err();
    assert!(error.contains("requires net:127.0.0.1"), "{error}");
}

async fn check_action_process_recovery(mut fixture: Fixture) {
    let pid = action_process_pid(std::process::id());
    let waiting = fixture.start("stuck", json!({}));
    tokio::time::sleep(Duration::from_millis(100)).await;
    kill(pid);
    let (id, result) = fixture.result().await;
    assert_eq!(id, waiting);
    assert!(result.unwrap_err().contains("Action process exited"));
    fixture.next += 1;
    fixture
        .session
        .sender()
        .request(Request::Query {
            id: fixture.next,
            name: "worker-test/actions:pure".into(),
            args: json!({}),
        })
        .unwrap();
    assert_eq!(fixture.result().await.1.unwrap(), "QuickJS");
    let mut previous = pid;
    for minimum in [200, 450, 950, 1950, 3950] {
        let restart = std::time::Instant::now();
        assert_eq!(fixture.call("state", json!({})).await.unwrap()["count"], 1);
        assert!(
            restart.elapsed() >= Duration::from_millis(minimum),
            "restart did not back off for at least {minimum} ms"
        );
        let next = action_process_pid(std::process::id());
        assert_ne!(previous, next);
        previous = next;
        let waiting = fixture.start("stuck", json!({}));
        tokio::time::sleep(Duration::from_millis(100)).await;
        kill(next);
        let (id, result) = fixture.result().await;
        assert_eq!(id, waiting);
        assert!(result.unwrap_err().contains("Action process exited"));
    }

    // The next restart waits eight seconds; reload must finish independently.
    let waiting = fixture.start("stuck", json!({}));
    tokio::time::sleep(Duration::from_millis(40)).await;
    tokio::time::timeout(
        Duration::from_millis(2500),
        fixture.server.reload_plugin("worker-test".into()),
    )
    .await
    .expect("reload waited for action process back-off")
    .unwrap();
    let (id, result) = fixture.result().await;
    assert_eq!(id, waiting);
    assert!(result.unwrap_err().contains("cancelled by reload"));
    fixture.close().await;
    assert!(!alive(previous));
}

#[cfg(unix)]
fn action_process_pid(parent: u32) -> u64 {
    let processes = Command::new("ps")
        .args(["-ww", "-axo", "pid=,ppid=,command="])
        .output()
        .unwrap();
    assert!(processes.status.success());
    let processes = String::from_utf8(processes.stdout).unwrap();
    processes
        .lines()
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u64>().ok()?;
            let owner = fields.next()?.parse::<u32>().ok()?;
            (owner == parent && line.contains("tokamak-plugin-host --actions")).then_some(pid)
        })
        .unwrap_or_else(|| panic!("no action process child of {parent}"))
}

#[cfg(not(unix))]
fn action_process_pid(_: u32) -> u64 {
    unreachable!("the action process is unavailable on this platform")
}

#[cfg(unix)]
fn kill(pid: u64) {
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);
}

#[cfg(not(unix))]
fn kill(_: u64) {
    unreachable!("the action process is unavailable on this platform")
}

#[cfg(not(unix))]
fn alive(_: u64) -> bool {
    false
}

#[cfg(unix)]
fn alive(pid: u64) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disable_fails_stuck_calls_and_keeps_the_action_process_alive() {
    let mut fixture = Fixture::new().await;
    fixture.call("state", json!({})).await.unwrap();
    let pid = action_process_pid(std::process::id());
    fixture.start("stuck", json!({}));
    std::fs::remove_dir_all(fixture.directory.path().join("plugins/worker-test")).unwrap();
    fixture
        .server
        .reload_plugin("worker-test".into())
        .await
        .unwrap();
    assert!(fixture.result().await.1.unwrap_err().contains("cancelled"));
    assert!(alive(pid));
    fixture.close().await;
    assert!(!alive(pid));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_messages_fail_only_their_invocation() {
    let mut fixture = Fixture::new().await;
    let first = fixture.call("state", json!({})).await.unwrap();
    let waiting = fixture.start("echo", json!({"value":"waiting","delay":50}));
    let large = fixture.start("large", json!({}));
    let results = BTreeMap::from([fixture.result().await, fixture.result().await]);
    let error = results[&large].as_ref().unwrap_err();
    assert!(
        error.contains("Host operation result exceeds the action process's 1 MiB limit"),
        "{error}"
    );
    assert_eq!(results[&waiting], Ok(json!("waiting")));
    assert!(
        fixture
            .call("echo", json!({"value":"x".repeat(1024 * 1024),"delay":0}))
            .await
            .unwrap_err()
            .contains("Action process invocation exceeds 1 MiB limit")
    );
    let second = fixture.call("state", json!({})).await.unwrap();
    assert_eq!(first["pid"], second["pid"]);
    assert_eq!(second["count"], 1);
    fixture.close().await;
}

#[cfg(unix)]
fn worker_lifecycle(scenario: &str) {
    use std::io::BufRead;
    use std::process::Stdio;
    struct ServerGuard(std::process::Child);
    impl Drop for ServerGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let plugins = directory.path().join("plugins/worker-test");
    std::fs::create_dir_all(&plugins).unwrap();
    for (name, text) in artifacts(false) {
        std::fs::write(plugins.join(name), text).unwrap();
    }
    let mut server = ServerGuard(
        Command::new(env!("CARGO_BIN_EXE_tokamak-server"))
            .args([
                "--plugins",
                directory.path().join("plugins").to_str().unwrap(),
                "--data",
                directory.path().join("db").to_str().unwrap(),
                "--listen",
                "127.0.0.1:0",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    // Keep the actual OS stderr pipe undrained. Bun.spawn eagerly buffers its
    // pipes, which would hide this regression even without a consumer.
    let mut line = String::new();
    std::io::BufReader::new(server.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let url = line
        .split_whitespace()
        .find(|part| part.starts_with("ws://"))
        .expect(&line);
    let output = Command::new("bun")
        .arg("packages/server/tests/worker-lifecycle-driver.mjs")
        .arg(url)
        .arg(server.0.id().to_string())
        .arg(scenario)
        .current_dir(root())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{scenario}: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    for _ in 0..150 {
        if let Some(status) = server.0.try_wait().unwrap() {
            if scenario == "logs" {
                assert!(status.success(), "{status}");
            }
            if scenario == "logs" {
                assert_action_log(server.0.stderr.take().unwrap());
            }
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("server did not shut down promptly");
}
#[cfg(unix)]
fn assert_action_log(mut stderr: std::process::ChildStderr) {
    use std::io::Read;
    let mut logs = String::new();
    stderr.read_to_string(&mut logs).unwrap();
    assert!(
        logs.contains("Plugin worker-test [info]: action process log marker"),
        "{logs}"
    );
}

#[cfg(unix)]
#[test]
fn worker_logs_cannot_block_invocation_or_shutdown() {
    worker_lifecycle("logs");
}
#[cfg(unix)]
#[test]
fn busy_action_process_dies_with_server() {
    worker_lifecycle("parent-death");
}

#[tokio::test]
async fn quickjs_refuses_node_imports_in_old_worker_artifacts() {
    let directory = install_fixture(true);
    let error = load_fixture(&directory).await.err().unwrap().to_string();
    assert!(
        error.contains("Module is not allowed in the action process: node:child_process"),
        "{error}"
    );
}

#[tokio::test]
async fn quickjs_rejects_a_reload_if_the_action_module_throws_during_evaluation() {
    let mut fixture = Fixture::new().await;
    let path = fixture.directory.path().join("plugins/worker-test");
    let code = path.join("bundle.js");
    let mut source = std::fs::read_to_string(&code).unwrap();
    source.push_str("\nthrow new Error('broken action module on reload');");
    std::fs::write(code, &source).unwrap();

    let manifest_path = path.join("manifest.json");
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    manifest["hashes"]["bundle.js"] = json!(format!("{:x}", Sha256::digest(source.as_bytes())));
    std::fs::write(manifest_path, manifest.to_string()).unwrap();

    let error = fixture
        .server
        .reload_plugin("worker-test".into())
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("broken action module on reload"),
        "{error}"
    );
    assert_eq!(fixture.call("state", json!({})).await.unwrap()["count"], 1);
    fixture.close().await;
}
