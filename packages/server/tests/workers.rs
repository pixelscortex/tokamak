use engine::{Pool, PoolConfig};
use serde_json::{Value, json};
use server::protocol::Request;
use server::{
    Event, Server,
    data::{Database, Storage},
};
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
fn artifacts() -> &'static BTreeMap<String, String> {
    static FILES: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    FILES.get_or_init(|| {
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
    })
}
struct Fixture {
    directory: tempfile::TempDir,
    server: Server,
    session: server::Session,
    next: u64,
}
impl Fixture {
    async fn new() -> Self {
        Self::with_permissions(None).await
    }
    async fn with_permissions(permissions: Option<Vec<String>>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("plugins/worker-test");
        std::fs::create_dir_all(&path).unwrap();
        for (name, text) in artifacts() {
            std::fs::write(path.join(name), text).unwrap();
        }
        if let Some(permissions) = permissions {
            let manifest = path.join("manifest.json");
            let mut value: Value =
                serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
            value["plugin"]["permissions"] = json!(permissions);
            value["plugin"]["workerLimits"] = json!({"pids":64});
            std::fs::write(manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        }
        let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
        let server = Server::load_plugins(
            Database::open(Storage::Memory).await.unwrap(),
            pool,
            &directory.path().join("plugins"),
        )
        .await
        .unwrap();
        let session = server.connect().await.unwrap();
        Self {
            directory,
            server,
            session,
            next: 0,
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
                    Event::Response { id, result } => return (id, result),
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
    assert!(
        first["cwd"]
            .as_str()
            .unwrap()
            .ends_with("plugin-data/worker-test")
    );
    let second = fixture.call("state", json!({})).await.unwrap();
    assert_eq!(second["count"], 2);
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
    fixture.call("remember", json!({})).await.unwrap();
    assert!(
        fixture
            .call("stale", json!({}))
            .await
            .unwrap()
            .as_str()
            .unwrap()
            .contains("stale invocation")
    );
    assert!(
        fixture
            .call("envDenied", json!({}))
            .await
            .unwrap_err()
            .contains("env:WORKER_UNGRANTED")
    );
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
    assert!(
        fixture
            .call("crash", json!({}))
            .await
            .unwrap_err()
            .contains("worker exited")
    );
    assert_eq!(fixture.call("state", json!({})).await.unwrap()["count"], 1);
    fixture.close().await;
}
#[cfg(unix)]
fn alive(pid: u64) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disable_kills_worker_and_children_and_fails_stuck_calls() {
    let mut fixture = Fixture::new().await;
    let pids = fixture.call("child", json!({})).await.unwrap();
    assert!(alive(pids["child"].as_u64().unwrap()));
    fixture.start("cpu", json!({}));
    std::fs::remove_dir_all(fixture.directory.path().join("plugins/worker-test")).unwrap();
    fixture
        .server
        .reload_plugin("worker-test".into())
        .await
        .unwrap();
    assert!(fixture.result().await.1.unwrap_err().contains("worker"));
    for _ in 0..100 {
        if !alive(pids["worker"].as_u64().unwrap()) && !alive(pids["child"].as_u64().unwrap()) {
            fixture.close().await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("worker or child survived disable: {pids}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_messages_fail_only_their_invocation() {
    let mut fixture = Fixture::new().await;
    let first = fixture.call("state", json!({})).await.unwrap();
    let waiting = fixture.start("waitForLarge", json!({}));
    let large = fixture.start("large", json!({}));
    let results = BTreeMap::from([fixture.result().await, fixture.result().await]);
    let error = results[&large].as_ref().unwrap_err();
    assert!(
        error.contains("Host operation result exceeds 1 MiB worker limit"),
        "{error}"
    );
    assert_eq!(results[&waiting], Ok(json!("waiting")));
    assert!(
        fixture
            .call("echo", json!({"value":"x".repeat(1024 * 1024),"delay":0}))
            .await
            .unwrap_err()
            .contains("Worker invocation exceeds 1 MiB limit")
    );
    let second = fixture.call("state", json!({})).await.unwrap();
    assert_eq!(first["pid"], second["pid"]);
    assert_eq!(second["count"], 2);
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
    for (name, text) in artifacts() {
        std::fs::write(plugins.join(name), text).unwrap();
    }
    let mut server = ServerGuard(
        Command::new(env!("CARGO_BIN_EXE_tokamak"))
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
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("server did not shut down promptly");
}
#[cfg(unix)]
#[test]
fn worker_logs_cannot_block_invocation_or_shutdown() {
    worker_lifecycle("logs");
}
#[cfg(unix)]
#[test]
fn busy_worker_and_children_die_with_server() {
    worker_lifecycle("parent-death");
}

async fn real_turn(agent: &str) {
    let directory = tempfile::tempdir().unwrap();
    let plugins = directory.path().join("plugins");
    for id in ["chat", "acp"] {
        let output = Command::new("bun")
            .args(["run", "plugin:build", &format!("plugins/{id}")])
            .current_dir(root())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let destination = plugins.join(id);
        std::fs::create_dir_all(&destination).unwrap();
        for entry in std::fs::read_dir(root().join(format!("plugins/{id}/dist"))).unwrap() {
            let entry = entry.unwrap();
            if entry.path().is_file() {
                std::fs::copy(entry.path(), destination.join(entry.file_name())).unwrap();
            }
        }
    }
    let cwd = directory.path().join("workspace");
    std::fs::create_dir(&cwd).unwrap();
    let server = Server::load_plugins(
        Database::open(Storage::Memory).await.unwrap(),
        Arc::new(Pool::new(PoolConfig::default()).unwrap()),
        &plugins,
    )
    .await
    .unwrap();
    let mut session = server.connect().await.unwrap();
    let mut id = 0;
    async fn call(
        session: &mut server::Session,
        id: &mut u64,
        kind: &str,
        name: &str,
        args: Value,
    ) -> Value {
        *id += 1;
        session
            .sender()
            .request(
                serde_json::from_value(json!({"type":kind,"id":*id,"name":name,"args":args}))
                    .unwrap(),
            )
            .unwrap();
        let event = tokio::time::timeout(Duration::from_secs(120), session.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Event::Response { result, .. } = event else {
            panic!("{event:?}")
        };
        result.unwrap()
    }
    let thread = call(
        &mut session,
        &mut id,
        "action",
        "chat/threads:create",
        json!({}),
    )
    .await;
    call(
        &mut session,
        &mut id,
        "action",
        "chat/backends:configure",
        json!({"plugin":"acp","backendId":agent,"settings":{"cwd":cwd}}),
    )
    .await;
    call(&mut session, &mut id, "mutation", "chat/threads:setBackend", json!({"threadId":thread,"backend":{"kind":"plugin","plugin":"acp","backendId":agent,"settings":{"cwd":cwd}}})).await;
    session.sender().request(Request::Action {id:1000, name:"chat/chat:send".into(), args:json!({"threadId":thread,"text":"Reply with the single word: ready. Do not use tools."})}).unwrap();
    // A second session polls the public permission API without consuming the
    // action's response or lending its invocation any extra host capabilities.
    let mut observer = server.connect().await.unwrap();
    let mut poll = tokio::time::interval(Duration::from_millis(250));
    let result = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            tokio::select! {
                event = session.recv() => {
                    let Event::Response {id:1000, result} = event.unwrap().unwrap() else {panic!("unexpected action event")};
                    break result.unwrap();
                }
                _ = poll.tick() => {
                    let messages = call(&mut observer, &mut id, "query", "chat/messages:list", json!({"threadId":thread})).await;
                    if let Some(message) = messages.as_array().and_then(|messages| messages.last()) {
                        for part in message["parts"].as_array().unwrap() {
                            if part["type"] != "permission" || part["status"] != "pending" { continue; }
                            let option = part["options"].as_array().unwrap().iter().find(|option| option["kind"].as_str().unwrap_or("").starts_with("reject"));
                            if let Some(option) = option {
                                call(&mut observer, &mut id, "mutation", "chat/permissions:answer", json!({"messageId":message["_id"],"requestId":part["requestId"],"optionId":option["optionId"]})).await;
                            }
                        }
                    }
                }
            }
        }
    }).await.unwrap();
    let messages = call(
        &mut session,
        &mut id,
        "query",
        "chat/messages:list",
        json!({"threadId":thread}),
    )
    .await;
    let message = messages.as_array().unwrap().last().unwrap();
    let text: String = message["parts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect();
    println!("{agent}: status={}, text={text:?}", result["status"]);
    assert_eq!(result["status"], "done", "{message}");
    assert!(text.to_lowercase().contains("ready"), "{message}");
    server.close().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires installed adapter and owner CLI login"]
async fn real_claude() {
    real_turn("claude").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires installed adapter and owner CLI login"]
async fn real_codex() {
    real_turn("codex").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sandbox_denies_ungranted_files_network_and_executables() {
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret");
    std::fs::write(&secret, "outside grants").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut fixture = Fixture::new().await;
    let result = fixture.call("sandbox", json!({"read":secret,"write":outside.path().join("escape"),"port":listener.local_addr().unwrap().port()})).await.unwrap();
    assert_eq!(
        result,
        json!({"readDenied":true,"writeDenied":true,"execDenied":true,"networkDenied":true,"own":"inside data","temporary":"inside temp"})
    );
    let descendant = fixture
        .call(
            "descendant",
            json!({"read":secret,"write":outside.path().join("descendant-escape")}),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(descendant.as_str().unwrap()).unwrap(),
        json!({"readDenied":true,"writeDenied":true})
    );
    assert!(!outside.path().join("descendant-escape").exists());
    assert!(!outside.path().join("escape").exists());
    fixture.close().await;
    let mut granted = Fixture::with_permissions(Some(vec![
        format!("fs:write:{}", outside.path().display()),
        "net:localhost".into(),
    ]))
    .await;
    assert_eq!(
        granted
            .call("granted", json!({"path":outside.path()}))
            .await
            .unwrap(),
        "granted path"
    );
    let result = granted.call("sandbox", json!({"read":secret,"write":outside.path().join("escape"),"port":listener.local_addr().unwrap().port()})).await.unwrap();
    assert_eq!(result["networkDenied"], false);
    assert_eq!(result["readDenied"], false);
    assert_eq!(result["writeDenied"], false);
    assert_eq!(result["execDenied"], true);
    granted.close().await;
}
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sandbox_linux_pids_max_bounds_descendants() {
    let mut fixture = Fixture::with_permissions(Some(vec!["proc:/bin/sleep".into()])).await;
    let result = fixture.call("pids", json!({})).await.unwrap();
    if result["delegated"] == false {
        eprintln!("SKIP pids.max: server has no delegated cgroup v2");
        assert!(
            std::env::var_os("TOKAMAK_REQUIRE_CGROUP").is_none(),
            "Linux CI requires cgroup delegation"
        );
    } else {
        assert_eq!(result["denied"], true, "{result}");
    }
    fixture.close().await;
}
