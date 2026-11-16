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
        if let Some(path) = std::env::var_os("TKM45_TEST_ARTIFACTS") {
            return serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        }
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
        Self::with_chat(false)
    }
    fn with_chat(chat: bool) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = root()
            .join(format!(
                "packages/server/target/tkm45-install-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ))
            .join("plugins");
        std::fs::create_dir_all(&path).unwrap();
        let installation = Self(path);
        for (name, source) in artifacts() {
            if (name.starts_with("chat/") || name.starts_with("acp/")) && !chat {
                continue;
            }
            let path = installation.0.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, source).unwrap();
        }
        installation
    }
}
impl Drop for Installation {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
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
    if matches!(scenario, "contract" | "lane" | "oversize") {
        acceptance_over(scenario, true);
    }
}

fn acceptance_over(scenario: &str, websocket: bool) {
    let installation = Installation::with_chat(scenario.starts_with("chat-"));
    if scenario == "chat-backend-missing" {
        std::fs::remove_dir_all(installation.0.join("acp")).unwrap();
    }
    if scenario == "chat-acp" {
        let directory = installation.0.parent().unwrap();
        let agent = directory.join("agent.py");
        std::fs::write(&agent, include_str!("support/acp_agent.py")).unwrap();
        std::fs::write(
            directory.join(".env.local"),
            "ACP_TEST_PASSTHROUGH=from-dotenv\nACP_TEST_NO_RESTORE=1\n",
        )
        .unwrap();
        std::fs::write(directory.join("agents.toml"), format!(
            "[agents.fake]\ncommand = \"/usr/bin/python3\"\nargs = [{}]\nenv = [\"ACP_TEST_PASSTHROUGH\"]\nplugins = [\"acp\"]\n[agents.fresh]\ncommand = \"/usr/bin/python3\"\nargs = [{}]\nenv = [\"ACP_TEST_PASSTHROUGH\", \"ACP_TEST_NO_RESTORE\"]\nplugins = [\"acp\"]\n", json!(agent), json!(agent)
        )).unwrap();
    }
    if scenario == "chat-grant" || scenario == "chat-real" {
        let path = installation.0.join("chat/manifest.json");
        let mut manifest: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        if scenario == "chat-grant" {
            manifest["plugin"]["permissions"]
                .as_array_mut()
                .unwrap()
                .retain(|grant| grant != "env:OPENROUTER_API_KEY");
        } else {
            manifest["plugin"]["permissions"] = json!([
                "net:openrouter.ai",
                "env:OPENROUTER_API_KEY",
                "env:OPENROUTER_BASE_URL"
            ]);
            let fixture_path = installation.0.join("b/manifest.json");
            let mut fixture: Value =
                serde_json::from_slice(&std::fs::read(&fixture_path).unwrap()).unwrap();
            fixture["plugin"]["provides"] = json!([]);
            std::fs::write(fixture_path, serde_json::to_vec(&fixture).unwrap()).unwrap();
            std::fs::copy(
                root().join(".env.local"),
                installation.0.parent().unwrap().join(".env.local"),
            )
            .unwrap();
        }
        std::fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    }
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(if scenario == "chat-real" { 360 } else { 30 }), async {
                let pool = Arc::new(Pool::new(PoolConfig {
                    workers: 1,
                    limits: Limits {
                        // Only the contract probe asserts the deliberately short
                        // budget; other scenarios retain the normal transaction
                        // budget under concurrent regression-test load.
                        call_timeout: if scenario == "contract" { Duration::from_millis(150) } else { Limits::default().call_timeout },
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
#[test]
fn oversized_action_result_fails_only_its_own_call() {
    acceptance("oversize");
}

// TKM-44 hot reload x TKM-45 action lane: reloading must cancel the running
// old-generation action (its grants may be revoked), deliver its failure on
// the same session, announce the new generation, and leave a working lane.
#[test]
fn reload_cancels_running_action_and_keeps_the_lane_usable() {
    let installation = Installation::new();
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(30), async {
                let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
                let database = Database::open(Storage::Memory).await.unwrap();
                let server = Server::load_plugins(database, pool, &installation.0)
                    .await
                    .unwrap();
                let mut session = server.connect().await.unwrap();
                let action = |id: u64, ms: u64| -> server::protocol::Request {
                    serde_json::from_value(
                        json!({"type":"action","id":id,"name":"a/ops:sleep","args":{"ms":ms}}),
                    )
                    .unwrap()
                };
                session.sender().request(action(1, 20_000)).unwrap();
                // Let the action reach a worker before the generation swap.
                tokio::time::sleep(Duration::from_millis(200)).await;
                server.reload_plugin("a".into()).await.unwrap();
                let (mut changed, mut cancelled) = (false, None);
                while !changed || cancelled.is_none() {
                    match tokio::time::timeout(Duration::from_secs(5), session.recv())
                        .await
                        .expect("reload must settle the old action promptly")
                        .unwrap()
                        .unwrap()
                    {
                        Event::PluginChanged { .. } => changed = true,
                        Event::Response { id: 1, result } => cancelled = Some(result),
                        event => panic!("unexpected event: {event:?}"),
                    }
                }
                assert!(
                    cancelled.unwrap().is_err(),
                    "old-generation action must not complete"
                );
                session.sender().request(action(2, 1)).unwrap();
                match session.recv().await.unwrap().unwrap() {
                    Event::Response { id: 2, result } => assert_eq!(result, Ok(json!("slept"))),
                    event => panic!("unexpected event: {event:?}"),
                }
                drop(session);
                server.close().await.unwrap();
            })
            .await
            .expect("reload/action interaction timeout");
        });
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

// Cancellation/error paths must recycle native slots within the same action.
// Readable cancellation must release an active incremental decoder.
#[test]
fn web_fix_decoder_readable_cancel_releases_slots() {
    acceptance("slots-decoders-cancel");
}
// Writable abort must release an active incremental decoder.
#[test]
fn web_fix_decoder_writable_abort_releases_slots() {
    acceptance("slots-decoders-abort");
}
// Fatal transform errors must release decoder state.
#[test]
fn web_fix_decoder_transform_error_releases_slots() {
    acceptance("slots-decoders-error");
}
// Invalid streaming input must reset previously allocated decoder state.
#[test]
fn web_fix_decoder_invalid_input_releases_slots() {
    acceptance("slots-decoders-invalid");
}
// Clears, thrown coercion and fired timeout signals must recycle capacity.
#[test]
fn web_fix_timer_clear_error_and_timeout_release_slots() {
    acceptance("slots-timers");
}

// Prevent silent body replay and detached retained URLSearchParams references.
// Body ownership must include POST transfer and direct-reader disturbance.
#[test]
fn web_fix_request_and_response_bodies_cannot_be_reused() {
    acceptance("bodies");
}
// Saved params must stay linked after replacing search or href.
#[test]
fn web_fix_retained_search_params_remain_live() {
    acceptance("params");
}

// Observe native sockets before another job can accidentally drive teardown.
// Abort must close native I/O without another JS promise poll.
#[test]
fn web_fix_abort_disconnects_while_javascript_is_busy() {
    acceptance("abort-busy");
}
// Successful retirement must close unused bodies without another job.
#[test]
fn web_fix_return_disconnects_with_worker_idle() {
    acceptance("abandoned-return");
}
// Exceptional retirement must close unused bodies without another job.
#[test]
fn web_fix_throw_disconnects_with_worker_idle() {
    acceptance("abandoned-throw");
}
// More than 64 exchanges must fit sequentially in one invocation.
// Cancelling a fetch reader must recycle its native exchange.
#[test]
fn web_fix_cancelled_body_readers_release_slots() {
    acceptance("slots-readers-cancel");
}
// A truncated fetch body must recycle its native exchange.
#[test]
fn web_fix_errored_body_readers_release_slots() {
    acceptance("slots-readers-error");
}
// Permission failure must cancel the transferred native upload source.
#[test]
fn web_fix_denied_upload_cancels_native_source() {
    acceptance("slots-uploads-denied");
}
// A pre-aborted request must cancel the transferred native upload source.
#[test]
fn web_fix_preaborted_upload_cancels_native_source() {
    acceptance("slots-uploads-abort");
}
// An early response must cancel an upload still waiting on source bytes.
#[test]
fn web_fix_early_response_cancels_native_upload_source() {
    acceptance("slots-uploads-early");
}

// Scope the deterministic OS resolver override to a child test process. This
// reaches reqwest's actual resolver/connector without internet or /etc changes.
#[cfg(unix)]
#[test]
fn web_fix_network_checks_resolved_addresses_and_canonical_hosts() {
    if std::env::var_os("TKM45_TEST_DNS").is_some() {
        use std::net::ToSocketAddrs;
        // A missing shim/DNS failure must never masquerade as a blocked address.
        for (host, ip) in [
            ("loopback", "127.0.0.1"),
            ("private", "10.1.2.3"),
            ("metadata", "169.254.169.254"),
            ("mapped", "::ffff:127.0.0.1"),
        ] {
            let addresses: Vec<_> = (format!("{host}.tkm.test"), 0)
                .to_socket_addrs()
                .unwrap()
                .collect();
            assert!(!addresses.is_empty());
            assert!(
                addresses
                    .iter()
                    .all(|address| address.ip() == ip.parse::<std::net::IpAddr>().unwrap())
            );
        }
        let attempts = std::env::var_os("TKM45_TEST_CONNECT_LOG").unwrap();
        std::fs::write(&attempts, "").unwrap();
        acceptance("network-boundary");
        assert_eq!(
            std::fs::read_to_string(attempts).unwrap(),
            "",
            "hostname grants must reject private/metadata answers before attempting a connection"
        );
        return;
    }
    let installation = Installation::new();
    let library = installation.0.join("resolver.dylib");
    let mut compile = Command::new("cc");
    if cfg!(target_os = "macos") {
        compile.arg("-dynamiclib");
    } else {
        compile.args(["-shared", "-fPIC"]);
    }
    let output = compile
        .arg(root().join("packages/server/tests/fixtures/actions/resolver.c"))
        .arg("-o")
        .arg(&library)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "DNS shim compile: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "web_fix_network_checks_resolved_addresses_and_canonical_hosts",
            "--nocapture",
        ])
        .env("TKM45_TEST_DNS", "1")
        .env("TKM45_TEST_CONNECT_LOG", installation.0.join("connect.log"))
        .env(
            if cfg!(target_os = "macos") {
                "DYLD_INSERT_LIBRARIES"
            } else {
                "LD_PRELOAD"
            },
            library,
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "DNS/HTTP acceptance:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

// Keep the cancelled pool allocated but idle: dropping the pool/runtime must
// not be what finally closes a response abandoned without JS cleanup.
#[test]
fn web_fix_cancel_disconnects_with_worker_idle() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let bundle = Arc::new(Bundle::new(artifacts()["a/bundle.js"].clone(), None).unwrap());
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap().block_on(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/hold", listener.local_addr().unwrap());
            let (ready, ready_rx) = tokio::sync::oneshot::channel();
            let (closed, closed_rx) = tokio::sync::oneshot::channel();
            let mock = tokio::spawn(async move {
                let mut ready = Some(ready);
                let mut closed = Some(closed);
                let mut peers = Vec::new();
                for _ in 0..2 {
                    let (mut peer, _) = listener.accept().await.unwrap();
                    let mut headers = Vec::new();
                    while !headers.ends_with(b"\r\n\r\n") {
                        headers.push(peer.read_u8().await.unwrap());
                        assert!(headers.len() < 8192);
                    }
                    if headers.starts_with(b"GET /ready ") {
                        peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await.unwrap();
                        ready.take().unwrap().send(()).unwrap();
                    } else {
                        peer.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nfirst\r\n").await.unwrap();
                        let closed = closed.take().unwrap();
                        peers.push(tokio::spawn(async move {
                            let mut byte = [0];
                            let result = peer.read(&mut byte).await;
                            assert!(matches!(result, Ok(0) | Err(_)), "expected disconnect, got {result:?}");
                            closed.send(()).unwrap();
                        }));
                    }
                }
                for peer in peers { peer.await.unwrap(); }
            });
            let pool = Pool::new_actions(PoolConfig { workers: 1, ..PoolConfig::default() }).unwrap();
            let mut ops = OpRegistry::new();
            ops.set_network_permissions(vec!["net:127.0.0.1".into()]);
            let pending = pool.submit(bundle, "invoke", json!({"name":"web:abandoned", "args":{"url":url,"mode":"cancel"}}), Arc::new(ops)).unwrap();
            ready_rx.await.unwrap();
            pool.cancel_actions();
            assert_eq!(pending.await.unwrap_err(), engine::Error::Closed);
            tokio::time::timeout(Duration::from_secs(2), closed_rx).await
                .expect("HTTP stayed open after cancellation while worker idle").unwrap();
            mock.await.unwrap();
            drop(pool);
        }).await.expect("cancelled action regression timeout");
    });
}

#[cfg(unix)]
#[path = "helpers/actions_dns.rs"]
mod dns;

#[test]
fn chat_thread_crud_cascades_messages_and_runs() {
    acceptance("chat-crud");
}
#[test]
fn chat_stream_persists_deltas_and_live_query_observes_growth() {
    acceptance("chat-stream");
}
#[test]
fn chat_stale_runs_recover_without_cancelling_healthy_runs() {
    acceptance("chat-recovery");
}
#[test]
fn chat_cancel_stops_a_silent_upstream() {
    acceptance("chat-cancel");
}
#[test]
fn chat_upstream_failure_marks_message_and_run_error() {
    acceptance("chat-error");
}
#[test]
fn chat_missing_environment_grant_is_refused() {
    acceptance("chat-grant");
}
#[test]
#[ignore = "manual OpenRouter smoke run; requires .env.local"]
fn chat_real_openrouter_smoke() {
    acceptance("chat-real");
}

#[test]
fn chat_tools_persist_running_done_then_text_and_filter_providers() {
    acceptance("chat-tools");
}
#[test]
fn chat_tool_errors_return_to_model_and_finish_run() {
    acceptance("chat-tools-error");
}

#[test]
fn record_tools_allow_consumer_and_refuse_non_consumer() {
    acceptance("record-tools");
}

#[test]
fn chat_acp_backend() {
    acceptance("chat-acp");
}

#[test]
fn chat_missing_backend_finishes_run_with_clear_error() {
    acceptance("chat-backend-missing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_data_is_unchanged_and_action_errors_use_the_invocation_snapshot() {
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::{
        MaybeTlsStream, WebSocketStream,
        tungstenite::{Message, client::IntoClientRequest},
    };

    async fn call(
        socket: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
        kind: &str,
        name: &str,
        args: Value,
    ) -> Value {
        socket
            .send(Message::Text(
                json!({"type":kind,"id":1,"name":name,"args":args})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::from_str(message.to_text().unwrap()).unwrap()
    }

    let installation = Installation::new();
    let env = installation.0.parent().unwrap().join(".env.local");
    std::fs::write(&env, "ACTION_TEST_SECRET=action-secret-do-not-echo\n").unwrap();
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    let database = Database::open(Storage::Memory).await.unwrap();
    let server = Arc::new(
        Server::load_plugins(database, pool, &installation.0)
            .await
            .unwrap(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut request = format!("ws://{}/ws", listener.local_addr().unwrap())
        .into_client_request()
        .unwrap();
    const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {OWNER}").parse().unwrap());
    let (stop, shutdown) = tokio::sync::oneshot::channel();
    let serving = tokio::spawn(server::websocket::serve_with_access(
        listener,
        server.clone(),
        async {
            let _ = shutdown.await;
        },
        Some(server::websocket::LocalAccess {
            token: OWNER.into(),
            identity: json!({}),
        }),
    ));
    let (mut owner, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(
        call(&mut owner, "query", "a/ops:messageError", json!({})).await["result"]["Ok"],
        json!([{ "error":"failed: action-secret-do-not-echo", "text":"action-secret-do-not-echo" }])
    );
    let caught = call(&mut owner, "action", "a/ops:caught", json!({})).await;
    assert!(
        caught["result"]["Ok"]["error"]
            .as_str()
            .unwrap()
            .contains("[redacted]"),
        "{caught}"
    );
    assert!(!caught.to_string().contains("action-secret-do-not-echo"));

    let barrier = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", barrier.local_addr().unwrap());
    let change = async {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), barrier.accept())
            .await
            .unwrap()
            .unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(stream.read_u8().await.unwrap());
            assert!(request.len() < 8192);
        }
        // The HTTP barrier proves the action has already captured its env.
        std::fs::write(&env, "ACTION_TEST_SECRET=replacement-secret\n").unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    };
    let (error, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(
            call(
                &mut owner,
                "action",
                "a/ops:delayedSecret",
                json!({"url":url})
            ),
            change
        )
    })
    .await
    .expect("action snapshot regression timeout");
    assert!(
        error["result"]["Err"]
            .as_str()
            .unwrap()
            .starts_with("[redacted]:[redacted]"),
        "{error}"
    );
    assert!(!error.to_string().contains("action-secret-do-not-echo"));
    drop(owner);
    stop.send(()).unwrap();
    serving.await.unwrap().unwrap();
    server.close().await.unwrap();
}
