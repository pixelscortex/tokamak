//! Independent TKM-45 regressions: public builder, real QuickJS, server and SDK
//! native transport. The HTTP/SSE mock lives in the SDK driver, on loopback :0.
use engine::{ActionEngine, Bundle, Determinism, Engine, Limits, OpRegistry, Pool, PoolConfig};
use serde_json::{Value, json};
use server::{
    Event, Server,
    data::{Database, Storage},
};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn artifacts() -> &'static BTreeMap<String, String> {
    static BUILT: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    BUILT.get_or_init(|| {
        let output = Command::new("proto")
            .args([
                "run",
                "bun",
                "--",
                "packages/server/tests/build-actions.mjs",
            ])
            .current_dir(root())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "action fixture build:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        serde_json::from_str(stdout.lines().last().unwrap()).unwrap()
    })
}
struct Installation(PathBuf);
impl Installation {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = root().join(format!(
            "packages/server/target/tkm45-install-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        let installation = Self(path);
        for (name, source) in artifacts() {
            let path = installation.0.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, source).unwrap();
        }
        installation
    }
}
impl Drop for Installation {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

// Same stdio -> Session bridge used by tkm7.rs; no dispatcher/transport mocks.
fn acceptance(scenario: &str) {
    acceptance_over(scenario, false);
    if matches!(scenario, "contract" | "lane") {
        acceptance_over(scenario, true);
    }
}

fn acceptance_over(scenario: &str, websocket: bool) {
    let installation = Installation::new();
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(20), async {
                let pool = Arc::new(Pool::new(PoolConfig {
                    workers: 1,
                    limits: Limits {
                        call_timeout: Duration::from_millis(150),
                        load_timeout: Duration::from_secs(5),
                        ..Limits::default()
                    }, ..PoolConfig::default()
                }).unwrap());
                let database = Database::open(Storage::Memory).await.unwrap();
                let server = Arc::new(Server::load_plugins(database, pool, &installation.0).await.unwrap());
                let (url, serving) = if websocket {
                    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
                    let (stop, shutdown) = tokio::sync::oneshot::channel();
                    let serving = tokio::spawn(server::websocket::serve(listener, server.clone(), async { let _ = shutdown.await; }));
                    (url, Some((stop, serving)))
                } else { (String::new(), None) };
                let mut session = server.connect().await.unwrap();
                let mut child = Child(Command::new("proto")
                    .args(["run", "bun", "--"]).arg(installation.0.join("driver.mjs")).arg(scenario).arg(url)
                    .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
                    .spawn().unwrap());
                let mut input = child.0.stdin.take().unwrap();
                let output = child.0.stdout.take().unwrap();
                let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
                let reader = std::thread::spawn(move || {
                    for line in BufReader::new(output).lines() {
                        if send.send(line.unwrap()).is_err() { break; }
                    }
                });
                loop {
                    tokio::select! {
                        line = receive.recv() => {
                            let message: Value = serde_json::from_str(&line.expect("SDK exited before acceptance completed; see failing assertion above")).unwrap();
                            if message["done"] == true { break; }
                            session.sender().request(serde_json::from_value(message["request"].clone()).unwrap()).unwrap();
                        }
                        event = session.recv() => {
                            let event: Event = event.unwrap().unwrap();
                            writeln!(input, "{}", json!({"event":event})).unwrap();
                        }
                    }
                }
                drop(input);
                assert!(child.0.wait().unwrap().success(), "SDK acceptance failed: {scenario}");
                reader.join().unwrap();
                drop(session);
                if let Some((stop, serving)) = serving {
                    stop.send(()).unwrap();
                    serving.await.unwrap().unwrap();
                }
                server.close().await.unwrap();
            }).await.expect("TKM-45 action acceptance timeout");
        });
}

// Each name is a runnable regression; the driver documents the failure prevented.
#[test]
fn action_kind_and_independent_transactions_outlive_normal_budget() {
    acceptance("contract");
}
#[test]
fn pending_action_does_not_block_same_connection_transactions() {
    acceptance("lane");
}
#[test]
fn fetch_checks_effects_permissions_streaming_and_redirects() {
    acceptance("fetch");
}
#[test]
fn abort_disconnects_http_before_action_returns() {
    acceptance("abort");
}
#[test]
fn action_clock_advances_but_nested_transactions_freeze_time() {
    acceptance("time");
}
#[test]
fn actions_enforce_cross_plugin_exports() {
    acceptance("exports");
}
#[test]
fn pinned_ai_sdk_streams_multiple_deltas_offline() {
    acceptance("ai");
}
#[test]
fn pinned_ai_sdk_abort_disconnects_mid_stream() {
    acceptance("ai-abort");
}
#[test]
fn missing_web_api_fails_loudly() {
    acceptance("missing");
}

// A fixed replay seed must not seed an action's Math.random. Repeated fresh
// worlds with identical explicit inputs catch seeding without probabilistic
// assumptions about the server's own per-call seed selection.
#[test]
fn action_random_ignores_transaction_replay_seed() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let bundle = Bundle::new(artifacts()["a/bundle.js"].clone(), None).unwrap();
            let mut ops = OpRegistry::new();
            ops.set_determinism(Determinism {
                timestamp_ms: 123,
                seed: 456,
            });
            let ops = Arc::new(ops);
            let mut engine = ActionEngine::new(Limits::default()).unwrap();
            let args = json!({"name":"ops:random","args":{}});
            let first = engine
                .invoke(&bundle, "invoke", args.clone(), ops.clone())
                .await
                .unwrap();
            let second = engine.invoke(&bundle, "invoke", args, ops).await.unwrap();
            assert_ne!(
                first, second,
                "actions must use native randomness, even with identical replay inputs"
            );
            for value in first
                .as_array()
                .unwrap()
                .iter()
                .chain(second.as_array().unwrap())
            {
                assert!((0.0..1.0).contains(&value.as_f64().unwrap()));
            }
        });
}
