//! TKM7 acceptance uses the actual SDK client and real backend, not a second
//! client implementation. The native bridge opens no listener; the headless
//! driver launches the shipped executable and two independent WebSockets.
use engine::{Bundle, Engine, Json, OpRegistry, Pool, PoolConfig, QuickJsEngine};
use serde_json::{Value, json};
use server::{
    Backend, BackendConfig, Server,
    data::{Database, Storage},
};
use std::{
    future::Future,
    io::{BufRead, BufReader, Write},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

// A failed assertion/timeout must not orphan the SDK process blocked on stdin.
struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[path = "support/sdk.rs"]
mod sdk;
use sdk::{bun_script, bundle, root};

fn run(f: impl Future<Output = ()>) {
    sdk::run(f, 120);
}

fn config(storage: Storage) -> BackendConfig {
    BackendConfig {
        storage,
        bundle: bundle(),
        javascript: PoolConfig {
            workers: 2,
            ..PoolConfig::default()
        },
    }
}

// Same SDK workflow as headless below; only the message connection changes.
// Each stdin event is the unchanged common serde Event, including errors/null.
#[test]
fn actual_sdk_over_native_sessions_without_a_port() {
    run(async {
        let backend = Backend::start(config(Storage::Memory)).await.unwrap();
        let mut sessions = [
            Some(backend.connect().await.unwrap()),
            Some(backend.connect().await.unwrap()),
        ];
        let mut child = ChildGuard(
            bun_script("sdk-transport-driver.mjs")
                .args(["native"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let mut stdin = child.0.stdin.take().unwrap();
        let stdout = child.0.stdout.take().unwrap();
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if send.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        loop {
            let [first, second] = &mut sessions;
            tokio::select! {
                line = receive.recv() => {
                    let message: Value = serde_json::from_str(&line.expect("SDK exited before acceptance completed")).unwrap();
                    if message["done"] == true { break; }
                    let client = message["client"].as_u64().unwrap() as usize;
                    if message["close"] == true { sessions[client].take(); }
                    else {
                        let request = serde_json::from_value(message["request"].clone()).unwrap();
                        sessions[client].as_ref().unwrap().sender().request(request).unwrap();
                    }
                }
                event = async { first.as_mut().unwrap().recv().await }, if first.is_some() => {
                    writeln!(stdin, "{}", json!({"client":0,"event":event.unwrap().unwrap()})).unwrap();
                }
                event = async { second.as_mut().unwrap().recv().await }, if second.is_some() => {
                    writeln!(stdin, "{}", json!({"client":1,"event":event.unwrap().unwrap()})).unwrap();
                }
            }
        }
        drop(stdin);
        assert!(
            child.0.wait().unwrap().success(),
            "native SDK acceptance failed"
        );
        reader.join().unwrap();
        backend.close().await.unwrap();
    });
}

// Shipped CLI configuration, real two-client add/list/live, idle socket cleanup,
// SIGTERM barrier and persistence are validated together as a user would run it.
#[test]
fn headless_binary_two_real_sdk_clients_and_disk_reopen() {
    let result = bun_script("sdk-transport-driver.mjs")
        .args(["headless", env!("CARGO_BIN_EXE_tokamak")])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "headless SDK acceptance:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

// Failed descriptor inspection opens storage before failing. The caller must be
// able to immediately reuse its disk path, not wait for GC/process termination.
// A cancelled close and concurrent/repeated close must all share one barrier.
#[test]
fn startup_failure_and_cancelled_repeated_shutdown_release_disk() {
    run(async {
        let directory = root()
            .join("packages/server/target")
            .join(format!("tkm7-lifecycle-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let storage = Storage::Disk(directory.join("db"));
        let mut invalid = config(storage.clone());
        invalid.bundle = Arc::new(
            Bundle::new(
                "export function describe() { throw new Error('TKM7 startup sentinel'); }",
                None,
            )
            .unwrap(),
        );
        let failure = Backend::start(invalid)
            .await
            .err()
            .expect("invalid startup succeeded");
        assert!(
            failure.to_string().contains("TKM7 startup sentinel"),
            "{failure}"
        );
        let backend = Backend::start(config(storage.clone())).await.unwrap();
        let mut session = backend.connect().await.unwrap();
        session
            .call(
                1,
                "probe:insert",
                json!({"table":"items","value":{"persisted":true}}),
            )
            .unwrap();
        assert!(matches!(
            session.recv().await.unwrap(),
            Some(server::Event::Response { result: Ok(_), .. })
        ));
        let mut closing = Box::pin(backend.close());
        std::future::poll_fn(|cx| {
            // Polling admits shutdown; cancel even when the database has not
            // finished. No sleep guesses or extra native SQL stack are involved.
            assert!(
                closing.as_mut().poll(cx).is_pending(),
                "close unexpectedly completed on its first poll"
            );
            std::task::Poll::Ready(())
        })
        .await;
        drop(closing);
        let (a, b) = tokio::join!(backend.close(), backend.close());
        a.unwrap();
        b.unwrap();
        backend.close().await.unwrap();
        assert!(session.recv().await.unwrap().is_none());
        let reopened = Backend::start(config(storage)).await.unwrap();
        let mut check = reopened.connect().await.unwrap();
        check
            .call(2, "probe:list", json!({"table":"items"}))
            .unwrap();
        match check.recv().await.unwrap().unwrap() {
            server::Event::Response {
                result: Ok(rows), ..
            } => assert_eq!(rows[0]["persisted"], true),
            event => panic!("unexpected reopen event: {event:?}"),
        }
        reopened.close().await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    });
}

// Public network adapter must reject wildcard binding even when a library user
// bypasses the binary's argument validation.
#[test]
fn library_websocket_adapter_refuses_non_loopback() {
    run(async {
        let backend = Backend::start(config(Storage::Memory)).await.unwrap();
        let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
        let error = server::websocket::serve(listener, backend.server().clone(), async {})
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        backend.close().await.unwrap();
        // Public DB API remains reusable independently of the network adapter.
        let mut db = Database::open(Storage::Memory).await.unwrap();
        db.close().await.unwrap();
    });
}

// Only count real JS invocations; never supply results or intercept DB ops.
struct CountQueries {
    engine: QuickJsEngine,
    lists: Arc<AtomicUsize>,
}
impl Engine for CountQueries {
    async fn invoke(
        &mut self,
        bundle: &Bundle,
        export: &str,
        args: Json,
        ops: Arc<OpRegistry>,
    ) -> Result<Json, engine::Error> {
        if args["name"] == "probe:list" {
            self.lists.fetch_add(1, Ordering::SeqCst);
        }
        self.engine.invoke(bundle, export, args, ops).await
    }
}

// Closing the owner must END subscriptions, not merely stop displaying updates.
// A post-disconnect tracked write must not rerun the closed client's query. Both
// native drop and real peer WebSocket close are observed with actual QuickJS.
#[test]
fn dropped_native_and_closed_websocket_do_not_rerun_subscriptions() {
    run(async {
        let lists = Arc::new(AtomicUsize::new(0));
        let counts = lists.clone();
        let pool = Arc::new(
            Pool::with_engine(
                PoolConfig {
                    workers: 2,
                    ..PoolConfig::default()
                },
                move || {
                    Ok(CountQueries {
                        engine: QuickJsEngine::new(Default::default())?,
                        lists: counts.clone(),
                    })
                },
            )
            .unwrap(),
        );
        let server = Arc::new(
            Server::load(
                Database::open(Storage::Memory).await.unwrap(),
                pool,
                bundle(),
            )
            .await
            .unwrap(),
        );
        let mut native = server.connect().await.unwrap();
        native
            .subscribe(1, "probe:list", json!({"table":"items"}))
            .unwrap();
        assert!(matches!(
            native.recv().await.unwrap(),
            Some(server::Event::Subscription { result: Ok(_), .. })
        ));
        drop(native);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws", listener.local_addr().unwrap());
        let (stop, shutdown) = tokio::sync::oneshot::channel();
        let serving = tokio::spawn(server::websocket::serve(listener, server.clone(), async {
            let _ = shutdown.await;
        }));
        let output = tokio::task::spawn_blocking(move || {
            bun_script("sdk-transport-driver.mjs")
                .args(["disconnect", &url])
                .output()
                .unwrap()
        })
        .await
        .unwrap();
        assert!(
            output.status.success(),
            "peer-close SDK driver:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            lists.load(Ordering::SeqCst),
            2,
            "both subscriptions actually executed"
        );
        // Peer close is acknowledged only after the socket/session owner drops;
        // connecting and the mutation reply are coordinator barriers, not sleeps.
        let mut writer = server.connect().await.unwrap();
        writer
            .call(
                2,
                "probe:insert",
                json!({"table":"items","value":{"value":1}}),
            )
            .unwrap();
        assert!(matches!(
            writer.recv().await.unwrap(),
            Some(server::Event::Response { result: Ok(_), .. })
        ));
        assert_eq!(
            lists.load(Ordering::SeqCst),
            2,
            "closed subscription still executed feature code"
        );
        stop.send(()).unwrap();
        serving.await.unwrap().unwrap();
        server.close().await.unwrap();
    });
}

// Real CLI regression: SIGTERM is lifecycle control, not ordinary fallible
// command admission. An accepted mutation must commit even when 64 calls queue.
#[test]
fn headless_shutdown_drains_mutation_with_saturated_command_queue() {
    shutdown_driver("saturated");
}

// Real CLI regression: a TCP peer withholding HTTP's final CRLF must not keep
// axum's graceful server future (and therefore storage ownership) alive forever.
#[test]
fn headless_shutdown_bounds_partial_websocket_upgrade_peer() {
    shutdown_driver("partial-headers");
}

fn shutdown_driver(scenario: &str) {
    let output = bun_script("shutdown-driver.mjs")
        .args([scenario, env!("CARGO_BIN_EXE_tokamak")])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "shutdown regression {scenario}:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

// Pause only AFTER the first real mutation has executed its awaited DB write,
// but BEFORE service commit. The gate never supplies a result or storage op.
struct PauseFirstInsert {
    engine: QuickJsEngine,
    gate: Arc<
        std::sync::Mutex<
            Option<(
                tokio::sync::oneshot::Sender<()>,
                tokio::sync::oneshot::Receiver<()>,
            )>,
        >,
    >,
}
impl Engine for PauseFirstInsert {
    async fn invoke(
        &mut self,
        bundle: &Bundle,
        export: &str,
        args: Json,
        ops: Arc<OpRegistry>,
    ) -> Result<Json, engine::Error> {
        let insert = args["name"] == "probe:insert";
        let result = self.engine.invoke(bundle, export, args, ops).await;
        let gate = if insert {
            self.gate.lock().unwrap().take()
        } else {
            None
        };
        if let Some((arrived, resume)) = gate {
            arrived.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(15), resume)
                .await
                .unwrap()
                .unwrap();
        }
        result
    }
}

// Graceful shutdown owns ALL admitted mutations, not just the currently running
// one. A transport closes its Session before backend.close during serve shutdown;
// dropping the reply receiver must not revoke already-acknowledged admission.
// Retaining the Session is the control, with identical native/JS/storage work.
#[test]
fn shutdown_drains_admitted_queued_mutations_after_session_owner_drops() {
    run(async {
        for retain_session in [true, false] {
            let directory = root().join("packages/server/target").join(format!(
                "tkm7-admitted-{}-{retain_session}",
                std::process::id()
            ));
            std::fs::create_dir_all(&directory).unwrap();
            let storage = Storage::Disk(directory.join("db"));
            let (arrived, executing) = tokio::sync::oneshot::channel();
            let (resume, release) = tokio::sync::oneshot::channel();
            let gate = Arc::new(std::sync::Mutex::new(Some((arrived, release))));
            let pool = Arc::new(
                Pool::with_engine(
                    PoolConfig {
                        workers: 2,
                        ..PoolConfig::default()
                    },
                    move || {
                        Ok(PauseFirstInsert {
                            engine: QuickJsEngine::new(Default::default())?,
                            gate: gate.clone(),
                        })
                    },
                )
                .unwrap(),
            );
            let server = Server::load(
                Database::open(storage.clone()).await.unwrap(),
                pool,
                bundle(),
            )
            .await
            .unwrap();
            let mut session = Some(server.connect().await.unwrap());
            let sender = session.as_ref().unwrap().sender();
            sender
                .request(server::protocol::Request::Mutation {
                    id: 1,
                    name: "probe:insert".into(),
                    args: json!({"table":"items","value":{"value":"active"}}),
                })
                .unwrap();
            executing.await.unwrap();
            // The actor is held inside the active mutation. Each successful
            // request return below is deterministic admission evidence: none can
            // execute yet, and eight is well below the command/output limits.
            for id in 2..=9 {
                sender
                    .request(server::protocol::Request::Mutation {
                        id,
                        name: "probe:insert".into(),
                        args: json!({"table":"items","value":{"value":format!("queued-{id}")}}),
                    })
                    .unwrap();
            }
            if !retain_session {
                drop(session.take());
            }
            let mut closing = Box::pin(server.close());
            std::future::poll_fn(|cx| {
                assert!(closing.as_mut().poll(cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            resume.send(()).unwrap();
            closing.await.unwrap();
            drop(session);
            // Verify durable state only after close's awaited barrier. Replies
            // are deliberately not required once their receiver has disappeared.
            let reopened = Backend::start(config(storage)).await.unwrap();
            let mut check = reopened.connect().await.unwrap();
            check
                .call(20, "probe:list", json!({"table":"items"}))
                .unwrap();
            let rows = match check.recv().await.unwrap().unwrap() {
                server::Event::Response {
                    result: Ok(rows), ..
                } => rows,
                event => panic!("reopened list failed: {event:?}"),
            };
            reopened.close().await.unwrap();
            std::fs::remove_dir_all(directory).unwrap();
            assert_eq!(
                rows.as_array().unwrap().len(),
                9,
                "graceful shutdown lost an admitted queued mutation; retain_session={retain_session}; rows={rows}"
            );
            let mut values = rows
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["value"].as_str().unwrap())
                .collect::<Vec<_>>();
            values.sort();
            assert_eq!(
                values,
                vec![
                    "active", "queued-2", "queued-3", "queued-4", "queued-5", "queued-6",
                    "queued-7", "queued-8", "queued-9"
                ]
            );
        }
    });
}

// Mirror the deterministic native admission test through the actual CLI/SDK.
// A FIFO Ping/Pong barrier establishes adapter progress past all text frames,
// while the active slow mutation has not replied and queued work is under limit.
#[test]
fn headless_shutdown_drains_under_capacity_admitted_queued_mutations() {
    shutdown_driver("queued-mutations");
}
