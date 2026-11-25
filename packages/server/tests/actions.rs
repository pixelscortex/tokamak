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
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn local_user_operations() -> OpRegistry {
    let mut ops = OpRegistry::new();
    ops.register_sync("auth.current", |_| {
        Ok(json!(server::identity::AuthContext::local()))
    })
    .unwrap();
    ops
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

#[tokio::test]
async fn plugin_calls_preserve_the_caller_across_queries_mutations_and_actions() {
    let installation = Installation::new();
    let db = Database::open(Storage::Memory).await.unwrap();
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    let server = Server::load_plugins(db, pool, &installation.0)
        .await
        .unwrap();
    for (id, name) in [("alice", "Alice"), ("bob", "Bob")] {
        let mut session = server
            .connect_as(server::identity::User {
                id: id.into(),
                name: name.into(),
                role: server::identity::Role::Member,
            })
            .await
            .unwrap();
        verify_plugin_callers(&mut session, id, name).await;
    }
    server.close().await.unwrap();
}

async fn call_ok(session: &mut server::Session, name: &str, args: Value) -> Value {
    call_result(session, name, args).await.unwrap()
}

async fn call_result(
    session: &mut server::Session,
    name: &str,
    args: Value,
) -> Result<Value, String> {
    session.call(1, name, args).unwrap();
    let Some(Event::Response { result, .. }) =
        tokio::time::timeout(Duration::from_secs(10), session.recv())
            .await
            .expect("action response timeout")
            .unwrap()
    else {
        panic!("missing action response for {name}")
    };
    result
}

async fn verify_plugin_callers(session: &mut server::Session, id: &str, name: &str) {
    let user = json!({"id":id,"name":name,"role":"member"});
    for function in ["a/ops:callerViaQuery", "a/ops:callerViaMutation"] {
        assert_eq!(call_ok(session, function, json!({})).await, user);
    }
    assert_eq!(
        call_ok(session, "a/ops:callerViaAction", json!({})).await,
        json!([user, user, user])
    );
}

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
    let installation = Installation::new();
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(30), async {
                let pool = Arc::new(
                    Pool::new(PoolConfig {
                        workers: 1,
                        limits: Limits {
                            // Only the contract probe asserts the deliberately short
                            // budget; other scenarios retain the normal transaction
                            // budget under concurrent regression-test load.
                            call_timeout: if scenario == "contract" {
                                Duration::from_millis(150)
                            } else {
                                Limits::default().call_timeout
                            },
                            load_timeout: Duration::from_secs(5),
                            ..Limits::default()
                        },
                        ..PoolConfig::default()
                    })
                    .unwrap(),
                );
                let database = Database::open(Storage::Memory).await.unwrap();
                let server = Arc::new(
                    Server::load_plugins(database, pool, &installation.0)
                        .await
                        .unwrap(),
                );
                let (url, serving) = if websocket {
                    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
                    let (stop, shutdown) = tokio::sync::oneshot::channel();
                    let serving =
                        tokio::spawn(server::websocket::serve(listener, server.clone(), async {
                            let _ = shutdown.await;
                        }));
                    (url, Some((stop, serving)))
                } else {
                    (String::new(), None)
                };
                let mut session = server.connect().await.unwrap();
                let mut child = Child(
                    Command::new("proto")
                        .args(["run", "bun", "--"])
                        .arg(installation.0.join("driver.mjs"))
                        .arg(scenario)
                        .arg(url)
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::inherit())
                        .spawn()
                        .unwrap(),
                );
                let mut input = child.0.stdin.take().unwrap();
                let output = child.0.stdout.take().unwrap();
                let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
                let reader = std::thread::spawn(move || {
                    forward_driver_stdout(output, send);
                });
                relay_action_driver(&mut session, &mut input, &mut receive).await;
                drop(input);
                assert!(
                    child.0.wait().unwrap().success(),
                    "SDK acceptance failed: {scenario}"
                );
                reader.join().unwrap();
                drop(session);
                if let Some((stop, serving)) = serving {
                    stop.send(()).unwrap();
                    serving.await.unwrap().unwrap();
                }
                server.close().await.unwrap();
            })
            .await
            .expect("TKM-45 action acceptance timeout");
        });
}

// Each name is a runnable regression; the driver documents the failure prevented.
#[test]
fn call_note_survives_three_plugins_and_rejects_overrides() {
    acceptance("call-note");
}

#[test]
fn call_depth_limits_a_cycle_between_plugins() {
    acceptance("call-depth");
}

#[test]
fn call_depth_limits_a_cycle_between_actions() {
    acceptance("action-depth");
}

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
                        Event::Response { id: 1, result, .. } => cancelled = Some(result),
                        event => panic!("unexpected event: {event:?}"),
                    }
                }
                assert!(
                    cancelled.unwrap().is_err(),
                    "old-generation action must not complete"
                );
                session.sender().request(action(2, 1)).unwrap();
                match session.recv().await.unwrap().unwrap() {
                    Event::Response { id: 2, result, .. } => assert_eq!(result, Ok(json!("slept"))),
                    event => panic!("unexpected event: {event:?}"),
                }
                drop(session);
                server.close().await.unwrap();
            })
            .await
            .expect("reload/action interaction timeout");
        });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reload_replaces_only_the_reloaded_plugins_action_runtime() {
    let installation = Installation::new();
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    let server = Server::load_plugins(
        Database::open(Storage::Memory).await.unwrap(),
        pool,
        &installation.0,
    )
    .await
    .unwrap();
    let mut session = server.connect().await.unwrap();
    let action = |id, name: &str, args| server::protocol::Request::Action {
        id,
        name: name.into(),
        args,
    };
    session
        .sender()
        .request(action(1, "a/ops:sleep", json!({"ms":1})))
        .unwrap();
    assert!(matches!(
        session.recv().await.unwrap(),
        Some(Event::Response {
            id: 1,
            result: Ok(_),
            ..
        })
    ));
    session
        .sender()
        .request(action(2, "a/ops:sleep", json!({"ms":30000})))
        .unwrap();
    session
        .sender()
        .request(action(3, "b/ops:waitThroughReload", json!({})))
        .unwrap();

    // The combined action module must never initialize on the server.
    let path = installation.0.join("a/bundle.js");
    let source = std::fs::read_to_string(&path).unwrap();
    assert!(source.contains("slept"));
    let source = format!(
        "if (!globalThis.console) throw Error('action initialized in the server');\n{}",
        source.replace("slept", "reloaded")
    );
    use sha2::{Digest, Sha256};
    let manifest = installation.0.join("a/manifest.json");
    let mut manifest_json: Value =
        serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    manifest_json["hashes"]["bundle.js"] =
        json!(format!("{:x}", Sha256::digest(source.as_bytes())));
    std::fs::write(path, source).unwrap();
    std::fs::write(manifest, manifest_json.to_string()).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    server.reload_plugin("a".into()).await.unwrap();
    session
        .sender()
        .request(action(4, "a/ops:sleep", json!({"ms":1})))
        .unwrap();

    let results = tokio::time::timeout(Duration::from_secs(6), async {
        let mut results = BTreeMap::new();
        while results.len() < 3 {
            if let Some(Event::Response { id, result, .. }) = session.recv().await.unwrap() {
                results.insert(id, result);
            }
        }
        results
    })
    .await
    .unwrap();
    assert!(results[&2].as_ref().unwrap_err().contains("cancelled"));
    assert_eq!(results[&3], Ok(json!("public")));
    assert_eq!(results[&4], Ok(json!("reloaded")));
    server.close().await.unwrap();
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
            let mut ops = local_user_operations();
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
    let mut child = Command::new(std::env::current_exe().unwrap());
    child
        .args([
            "--exact",
            "web_fix_network_checks_resolved_addresses_and_canonical_hosts",
            "--nocapture",
        ])
        .env("TKM45_TEST_DNS", "1")
        .env("TKM45_TEST_CONNECT_LOG", installation.0.join("connect.log"))
        .env(resolver_environment(), &library);
    configure_action_process_resolver(&mut child, &installation.0, &library);
    let output = child.output().unwrap();
    assert!(
        output.status.success(),
        "DNS/HTTP acceptance:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
fn resolver_environment() -> &'static str {
    if cfg!(target_os = "macos") {
        "DYLD_INSERT_LIBRARIES"
    } else {
        "LD_PRELOAD"
    }
}

#[cfg(unix)]
fn configure_action_process_resolver(
    command: &mut Command,
    directory: &std::path::Path,
    library: &std::path::Path,
) {
    use std::os::unix::fs::PermissionsExt;

    // The launcher deliberately clears its environment. Use an executable
    // owned by this test to interpose DNS in the process making the requests.
    fn quote(path: &std::path::Path) -> String {
        format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
    }

    let host = tokamak_worker::Process::action_host_path().unwrap();
    let wrapper = directory.join("action-process-with-resolver");
    std::fs::write(&wrapper, format!(
        "#!/bin/sh\nexport {}={} TKM45_DNS_LOG={} TKM45_DNS_RELEASE={} TKM45_TEST_CONNECT_LOG={}\nexec {} \"$@\"\n",
        resolver_environment(),
        quote(library),
        quote(&directory.join("dns.log")),
        quote(&directory.join("release")),
        quote(&directory.join("connect.log")),
        quote(&host),
    )).unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    command.env("TOKAMAK_PLUGIN_HOST", wrapper);
}

// Keep the cancelled pool allocated but idle: dropping the pool/runtime must
// not be what finally closes a response abandoned without JS cleanup.
#[test]
fn web_fix_cancel_disconnects_with_worker_idle() {
    let bundle = Arc::new(Bundle::new(artifacts()["a/bundle.js"].clone(), None).unwrap());
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(5), async {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let url = format!("http://{}/hold", listener.local_addr().unwrap());
                let (ready, ready_rx) = tokio::sync::oneshot::channel();
                let (closed, closed_rx) = tokio::sync::oneshot::channel();
                let mock = tokio::spawn(async move {
                    serve_cancellation_peers(listener, ready, closed).await;
                });
                let pool = Pool::new_actions(PoolConfig {
                    workers: 1,
                    ..PoolConfig::default()
                })
                .unwrap();
                let mut ops = local_user_operations();
                ops.set_network_permissions(vec!["net:127.0.0.1".into()]);
                let pending = pool
                    .submit(
                        bundle,
                        "invoke",
                        json!({"name":"web:abandoned", "args":{"url":url,"mode":"cancel"}}),
                        Arc::new(ops),
                    )
                    .unwrap();
                ready_rx.await.unwrap();
                pool.cancel_actions();
                assert_eq!(pending.await.unwrap_err(), engine::Error::Closed);
                tokio::time::timeout(Duration::from_secs(2), closed_rx)
                    .await
                    .expect("HTTP stayed open after cancellation while worker idle")
                    .unwrap();
                mock.await.unwrap();
                drop(pool);
            })
            .await
            .expect("cancelled action regression timeout");
        });
}

#[cfg(unix)]
#[path = "helpers/actions_dns.rs"]
mod dns;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_data_is_unchanged_and_action_errors_use_the_invocation_snapshot() {
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
    let request = owner_websocket_request(&listener);
    let (stop, shutdown) = tokio::sync::oneshot::channel();
    let serving = tokio::spawn(server::websocket::serve_with_access(
        listener,
        server.clone(),
        async {
            let _ = shutdown.await;
        },
        Some(server::websocket::LocalAccess {
            token: ACTION_TEST_OWNER.into(),
            identity: json!({}),
        }),
    ));
    let (mut owner, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(
        call_owner_function(&mut owner, "query", "a/ops:messageError", json!({})).await["result"]["Ok"],
        json!([{ "error":"failed: action-secret-do-not-echo", "text":"action-secret-do-not-echo" }])
    );
    let caught = call_owner_function(&mut owner, "action", "a/ops:caught", json!({})).await;
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
    let change = change_action_environment(barrier, &env);
    let (error, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(
            call_owner_function(
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

async fn call_owner_function(
    socket: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    kind: &str,
    name: &str,
    args: Value,
) -> Value {
    use futures_util::{SinkExt, StreamExt};

    use tokio_tungstenite::tungstenite::Message;
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

async fn serve_cancellation_peers(
    listener: tokio::net::TcpListener,
    ready: tokio::sync::oneshot::Sender<()>,
    closed: tokio::sync::oneshot::Sender<()>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
            peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
            ready.take().unwrap().send(()).unwrap();
        } else {
            peer.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nfirst\r\n")
                .await
                .unwrap();
            let closed = closed.take().unwrap();
            peers.push(tokio::spawn(async move {
                let mut byte = [0];
                let result = peer.read(&mut byte).await;
                assert!(
                    matches!(result, Ok(0) | Err(_)),
                    "expected disconnect, got {result:?}"
                );
                closed.send(()).unwrap();
            }));
        }
    }
    for peer in peers {
        peer.await.unwrap();
    }
}

async fn relay_action_driver(
    session: &mut server::Session,
    input: &mut std::process::ChildStdin,
    receive: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
) {
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
}

fn change_action_environment(
    barrier: tokio::net::TcpListener,
    env: &std::path::Path,
) -> impl std::future::Future<Output = ()> + '_ {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async move {
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
        std::fs::write(env, "ACTION_TEST_SECRET=replacement-secret\n").unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    }
}

fn forward_driver_stdout(
    output: std::process::ChildStdout,
    send: tokio::sync::mpsc::UnboundedSender<String>,
) {
    for line in BufReader::new(output).lines() {
        if send.send(line.unwrap()).is_err() {
            break;
        }
    }
}

fn owner_websocket_request(
    listener: &tokio::net::TcpListener,
) -> tokio_tungstenite::tungstenite::handshake::client::Request {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = format!("ws://{}/ws", listener.local_addr().unwrap())
        .into_client_request()
        .unwrap();

    request.headers_mut().insert(
        "authorization",
        format!("Bearer {ACTION_TEST_OWNER}").parse().unwrap(),
    );

    request
}

const ACTION_TEST_OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
