//! Public builder -> manifest resolver -> real SDK/QuickJS -> one DB transaction.
use engine::{Bundle, Engine, Json, Limits, OpRegistry, Pool, PoolConfig, QuickJsEngine};
use serde_json::{Value, json};
use server::{
    Event, Server, Session,
    data::{DataSpace, Database, Id, Storage, Table, json_object},
};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

struct Installation(PathBuf);
impl Installation {
    fn empty() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
            "target/plugin-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn new() -> Self {
        let installation = Self::empty();
        let path = &installation.0;
        let source = built();
        for id in ["a", "b"] {
            let target = path.join(id);
            std::fs::create_dir(&target).unwrap();
            for file in [
                "manifest.json",
                "bundle.js",
                "bundle.js.map",
                "api.ts",
                "transactions.js",
                "transactions.js.map",
            ] {
                std::fs::copy(source.join(id).join("dist").join(file), target.join(file)).unwrap();
            }
        }
        installation
    }
    fn change(&self, id: &str, edit: impl FnOnce(&mut Value)) {
        let path = self.0.join(id).join("manifest.json");
        let mut manifest: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        edit(&mut manifest);
        std::fs::write(path, manifest.to_string()).unwrap();
    }
}
impl Drop for Installation {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Process(std::process::Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn built() -> PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        for id in ["a", "b"] {
            let output = std::process::Command::new("proto")
                .args([
                    "run",
                    "bun",
                    "--",
                    "packages/build/src/build.ts",
                    &format!("packages/server/tests/fixtures/plugins/{id}"),
                ])
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        root.join("packages/server/tests/fixtures/plugins")
    })
    .clone()
}

async fn next(session: &mut Session) -> Event {
    // Existing backend assertions consume data events. UI generation notices
    // now share this ordered stream and have their own client-loader coverage.
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = session.recv().await.unwrap().unwrap();
            if !matches!(event, Event::PluginChanged { .. }) {
                return event;
            }
        }
    })
    .await
    .unwrap()
}
async fn call(session: &mut Session, id: u64, name: &str, args: Value) -> Result<Value, String> {
    session.call(id, name, args).unwrap();
    match next(session).await {
        Event::Response { id: actual, result } => {
            assert_eq!(actual, id);
            result.map_err(|error| error.to_string())
        }
        event => panic!("unexpected {event:?}"),
    }
}
#[test]
fn nested_plugins_share_transactions_read_dependencies_and_a_single_worker() {
    let root = built();
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let pool = Arc::new(
                Pool::new(PoolConfig {
                    workers: 1,
                    ..Default::default()
                })
                .unwrap(),
            );
            let database = Database::open(Storage::Memory).await.unwrap();
            let server = Server::load_plugins(database, pool, &root).await.unwrap();
            let mut reader = server.connect().await.unwrap();
            let mut writer = server.connect().await.unwrap();
            assert_nested_plugin_transactions(&mut writer).await;
            reader.subscribe(100, "a/ops:combined", json!({})).unwrap();
            assert!(matches!(
                next(&mut reader).await,
                Event::Subscription {
                    id: 100,
                    result: Ok(_)
                }
            ));
            call(&mut writer, 9, "b/ops:add", json!({"fail":false}))
                .await
                .unwrap();
            match next(&mut reader).await {
                Event::Subscription {
                    id: 100,
                    result: Ok(value),
                } => {
                    assert_eq!(value["a"].as_array().unwrap().len(), 1);
                    assert_eq!(value["b"].as_array().unwrap().len(), 2);
                }
                event => panic!("unexpected {event:?}"),
            }
            drop(reader);
            drop(writer);
            server.close().await.unwrap();
        });
}

#[test]
fn reload_is_atomic_preserves_storage_and_rejects_partial_or_invalid_installations() {
    let installation = Installation::new();
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let pool = Arc::new(
                Pool::new(PoolConfig {
                    workers: 1,
                    ..Default::default()
                })
                .unwrap(),
            );
            let database = Database::open(Storage::Memory).await.unwrap();
            let server = Server::load_plugins(database, pool, &installation.0)
                .await
                .unwrap();
            let mut session = server.connect().await.unwrap();
            call(&mut session, 1, "a/ops:both", json!({"fail":false}))
                .await
                .unwrap();
            let original = server.plugins().await.unwrap()["revision"].clone();
            let change = |name: &str| {
                let path = installation.0.join("b").join(name);
                let source = std::fs::read_to_string(&path).unwrap();
                assert!(source.contains("child failure"));
                let changed = source.replace("child failure", "reloaded child failure");
                std::fs::write(path, &changed).unwrap();
                format!("{:x}", Sha256::digest(changed.as_bytes()))
            };
            let bundle = change("bundle.js");
            let transactions = change("transactions.js");
            assert!(
                server
                    .reload_plugin("b".into())
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("hash mismatch")
            );
            assert_eq!(server.plugins().await.unwrap()["revision"], original);
            installation.change("b", |manifest| {
                manifest["hashes"]["bundle.js"] = bundle.into();
                manifest["hashes"]["transactions.js"] = transactions.into();
            });
            let started = std::time::Instant::now();
            let reloaded = server.reload_plugin("b".into()).await.unwrap();
            assert!(started.elapsed() < Duration::from_secs(2));
            assert_ne!(reloaded["revision"], original);
            assert!(
                call(&mut session, 2, "a/ops:both", json!({"fail":true}))
                    .await
                    .unwrap_err()
                    .contains("reloaded child failure")
            );
            assert_eq!(
                call(&mut session, 3, "b/ops:list", json!({}))
                    .await
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            assert_invalid_reload_leaves_plugin_running(&installation, &server, &mut session).await;
            assert!(
                server
                    .plugin_asset("b".into(), "bundle.js".into())
                    .await
                    .unwrap()
                    .is_none()
            );
            drop(session);
            server.close().await.unwrap();
        });
}

async fn assert_invalid_reload_leaves_plugin_running(
    installation: &Installation,
    server: &Server,
    session: &mut Session,
) {
    let stable = server.plugins().await.unwrap()["revision"].clone();
    installation.change("b", |manifest| {
        manifest["plugin"]["permissions"] = json!(["net:example.com"]);
    });
    assert!(
        server
            .reload_plugin("b".into())
            .await
            .unwrap_err()
            .to_string()
            .contains("bump its version")
    );
    assert_eq!(server.plugins().await.unwrap()["revision"], stable);
    installation.change("b", |manifest| {
        manifest["plugin"]["permissions"] = json!([]);
        manifest["plugin"]["depends"] = json!({"missing":"*"});
    });
    assert!(
        server
            .reload_plugin("b".into())
            .await
            .unwrap_err()
            .to_string()
            .contains("Missing dependency")
    );
    assert_eq!(server.plugins().await.unwrap()["revision"], stable);
    // A failed reload leaves both the old code and existing connections usable.
    assert_eq!(
        call(session, 4, "b/ops:list", json!({}))
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn standalone_binary_exposes_only_authenticated_plugin_controls_and_cli() {
    let installation = Installation::new();
    let local = installation.0.join("local");
    std::fs::create_dir(&local).unwrap();
    let token = local.join("server.token");
    std::fs::write(&token, "a".repeat(64)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let binary = env!("CARGO_BIN_EXE_tokamak-server");
    let mut process = Process(
        std::process::Command::new(binary)
            .arg("--local-dir")
            .arg(&local)
            .arg("--plugins")
            .arg(&installation.0)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let started = std::time::Instant::now();
    while !local.join("server.json").exists() {
        assert!(
            process.0.try_wait().unwrap().is_none(),
            "plugin server exited before readiness"
        );
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "plugin startup timed out"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let identity: Value =
        serde_json::from_slice(&std::fs::read(local.join("server.json")).unwrap()).unwrap();
    let base = identity["url"]
        .as_str()
        .unwrap()
        .replace("ws://", "http://")
        .trim_end_matches("/ws")
        .to_owned();
    assert_authenticated_plugin_controls(&base, binary, &local);
    let started = std::time::Instant::now();
    while process.0.try_wait().unwrap().is_none() {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "server did not shut down"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!local.join("server.json").exists());
}

// Dependency access must not bypass exports. Even a caught
// denial must poison the transaction, including writes preceding the call.
#[tokio::test]
async fn private_plugin_calls_are_denied_and_caught_writes_roll_back() {
    let installation = Installation::new();
    let database = Database::open(Storage::Memory).await.unwrap();
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    let server = Server::load_plugins(database, pool, &installation.0)
        .await
        .unwrap();
    let mut session = server.connect().await.unwrap();
    let error = call(&mut session, 1, "a/ops:denied", json!({}))
        .await
        .unwrap_err();
    assert!(
        error.contains("ops:privateWrite is not exported by b"),
        "{error}"
    );
    for name in ["a/ops:list", "b/ops:list"] {
        assert_eq!(
            call(&mut session, 2, name, json!({})).await.unwrap(),
            json!([])
        );
    }
    // The same private function is legal from a client; self-calls are legal too.
    call(&mut session, 3, "a/ops:privateWrite", json!({}))
        .await
        .unwrap();
    call(&mut session, 4, "b/ops:ownPrivate", json!({}))
        .await
        .unwrap();
    call(&mut session, 5, "a/ops:both", json!({"fail":false}))
        .await
        .unwrap();
    assert_eq!(
        call(&mut session, 6, "a/ops:list", json!({}))
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        call(&mut session, 7, "b/ops:list", json!({}))
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    server.close().await.unwrap();
}

// Omitting exports must close the cross-plugin surface, even if an artifact
// previously listed public functions; clients and self-calls retain access.
#[tokio::test]
async fn plugin_without_exports_exposes_nothing_to_other_plugins() {
    let installation = Installation::new();
    installation.change("b", |manifest| {
        manifest["plugin"]
            .as_object_mut()
            .unwrap()
            .remove("exports");
    });
    let database = Database::open(Storage::Memory).await.unwrap();
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    let server = Server::load_plugins(database, pool, &installation.0)
        .await
        .unwrap();
    let mut session = server.connect().await.unwrap();
    let error = call(&mut session, 1, "a/ops:both", json!({"fail":false}))
        .await
        .unwrap_err();
    assert!(error.contains("ops:add is not exported by b"), "{error}");
    for name in ["a/ops:list", "b/ops:list"] {
        assert_eq!(
            call(&mut session, 2, name, json!({})).await.unwrap(),
            json!([])
        );
    }
    call(&mut session, 3, "b/ops:add", json!({"fail":false}))
        .await
        .unwrap();
    call(&mut session, 4, "b/ops:ownPrivate", json!({}))
        .await
        .unwrap();
    assert_eq!(
        call(&mut session, 5, "b/ops:list", json!({}))
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    server.close().await.unwrap();
}

fn build_source(installation: &Installation, plugin: Option<Value>) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let source = installation.0.join("source");
    std::fs::create_dir_all(source.join("src/server")).unwrap();
    std::fs::create_dir_all(source.join("node_modules/@tokamak")).unwrap();
    std::os::unix::fs::symlink(
        root.join("packages/sdk"),
        source.join("node_modules/@tokamak/sdk"),
    )
    .unwrap();
    std::fs::write(
        source.join("package.json"),
        r#"{"name":"@regression/inferred","version":"1.0.0","type":"module"}"#,
    )
    .unwrap();
    std::fs::write(
        source.join("src/server/ops.ts"),
        "import { query } from '@tokamak/sdk'; export const answer = query({handler: () => 42});\n",
    )
    .unwrap();
    std::fs::write(
        source.join("src/server/tsconfig.json"),
        json!({
            "extends":root.join("tsconfig.json")
        })
        .to_string(),
    )
    .unwrap();
    let options = plugin.map_or(
        json!({"ui":false}),
        |plugin| json!({"ui":false,"plugin":plugin}),
    );
    std::fs::write(
        source.join("vite.config.ts"),
        format!(
            "import {{tokamak}} from {}; export default {{plugins:[tokamak({options})]}};",
            json!(root.join("packages/build/src/vite.ts"))
        ),
    )
    .unwrap();
    source
}
fn build_artifact(source: &std::path::Path) -> (bool, String) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("proto")
        .args(["run", "bun", "--", "packages/build/src/build.ts"])
        .arg(source.canonicalize().unwrap())
        .current_dir(root)
        .output()
        .unwrap();
    (
        output.status.success(),
        format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
    )
}

// Invalid export declarations must fail at the public build boundary, before
// publishing an artifact that could silently expose the wrong backend surface.
#[test]
fn builder_rejects_missing_exports_file_and_nonexistent_reexport() {
    let installation = Installation::empty();
    let source = build_source(
        &installation,
        Some(json!({"id":"exports.invalid","version":"1.0.0","exports":"./api.ts"})),
    );
    let (success, output) = build_artifact(&source);
    assert!(!success, "missing exports file accepted: {output}");
    assert!(
        output.contains("Invalid plugin exports ./api.ts: file does not exist"),
        "{output}"
    );
    std::fs::write(
        source.join("api.ts"),
        "export { nonexistent } from './src/server/ops';\n",
    )
    .unwrap();
    let (success, output) = build_artifact(&source);
    assert!(!success, "nonexistent re-export accepted: {output}");
    assert!(
        output.contains("Invalid plugin exports ./api.ts") && output.contains("nonexistent"),
        "{output}"
    );
    assert!(!source.join("dist/manifest.json").exists());
}

// Generated runtime references must use package-inferred identity too; a
// syntactically valid unqualified reference otherwise fails only after install.
#[tokio::test]
async fn inferred_plugin_references_resolve_after_installation() {
    let installation = Installation::empty();
    let source = build_source(&installation, None);
    let (success, output) = build_artifact(&source);
    assert!(success, "{output}");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let output = std::process::Command::new("proto").args(["run", "bun", "--", "-e"])
        .arg(format!("import {{api}} from {}; import {{functionName}} from {}; console.log(api.ops.answer[functionName]);",
            json!(source.canonicalize().unwrap().join("dist/api.ts")), json!(root.join("packages/sdk/src/index.ts"))))
        .current_dir(root).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let name = String::from_utf8(output.stdout).unwrap().trim().to_owned();
    assert_eq!(name, "regression.inferred/ops:answer");
    let database = Database::open(Storage::Memory).await.unwrap();
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    let server = Server::load_plugins(database, pool, &installation.0)
        .await
        .unwrap();
    let mut session = server.connect().await.unwrap();
    assert_eq!(call(&mut session, 1, &name, json!({})).await.unwrap(), 42);
    server.close().await.unwrap();
}

struct ReplayPause {
    arrived: tokio::sync::oneshot::Sender<Value>,
    resume: tokio::sync::oneshot::Receiver<()>,
}
struct ReplayEngine {
    engine: QuickJsEngine,
    pause: Arc<Mutex<Option<ReplayPause>>>,
    attempts: Arc<std::sync::atomic::AtomicUsize>,
}
impl Engine for ReplayEngine {
    async fn invoke(
        &mut self,
        bundle: &Bundle,
        export: &str,
        args: Json,
        ops: Arc<OpRegistry>,
    ) -> Result<Json, engine::Error> {
        let observed = args["name"] == "determinism:write";
        let result = self.engine.invoke(bundle, export, args, ops).await;
        if observed {
            self.attempts
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let pause = self.pause.lock().unwrap().take();
            if let Some(pause) = pause {
                pause.arrived.send(result.clone().unwrap()).unwrap();
                tokio::time::timeout(Duration::from_secs(10), pause.resume)
                    .await
                    .unwrap()
                    .unwrap();
            }
        }
        result
    }
}
fn assert_snapshot(value: &Value) {
    let now = &value["before"]["now"];
    let streams = [
        &value["before"],
        &value["first"]["before"],
        &value["second"]["before"],
    ];
    for sample in [
        &value["before"],
        &value["after"],
        &value["first"]["before"],
        &value["first"]["after"],
        &value["second"]["before"],
        &value["second"]["after"],
    ] {
        for key in ["now", "later", "constructed"] {
            assert_eq!(&sample[key], now, "invocation clock drifted: {value}");
        }
        assert_eq!(sample["text"], value["before"]["text"]);
        assert_eq!(sample["explicit"], 1234);
        for random in sample["random"].as_array().unwrap() {
            let random = random.as_f64().unwrap();
            assert!((0.0..1.0).contains(&random));
        }
    }
    for i in 0..streams.len() {
        for j in i + 1..streams.len() {
            assert_ne!(
                streams[i]["random"], streams[j]["random"],
                "nested calls reused a random stream"
            );
        }
    }
    assert_ne!(
        value["before"]["random"], value["after"]["random"],
        "parent random stream restarted after delegation"
    );
}

// A real native write conflict must replay the entire invocation's clock and
// random streams (including children), while separate calls get fresh seeds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deterministic_query_and_conflict_retry_preserve_time_randomness_and_writes() {
    let installation = Installation::new();
    let data = tempfile::tempdir().unwrap();
    let storage = || Storage::Disk(data.path().join("db"));
    // Run the startup migration before deliberately holding a second writer
    // open to force a conflict in the handler itself.
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    let initial = Server::load_plugins(
        Database::open(storage()).await.unwrap(),
        pool,
        &installation.0,
    )
    .await
    .unwrap();
    initial.close().await.unwrap();
    let database = Database::open(storage()).await.unwrap();
    let items = DataSpace::plugin("a")
        .unwrap()
        .table(&Table::new("items").unwrap())
        .unwrap();
    let mut seed = database.begin().await.unwrap();
    let id: Id = seed
        .insert(&items, json_object(&json!({"value":0})).unwrap())
        .await
        .unwrap();
    seed.commit().await.unwrap();
    let presented_id = DataSpace::plugin("a").unwrap().present_id(&id).unwrap();
    let mut winner = database.begin().await.unwrap();
    winner
        .patch(&id, json_object(&json!({"value":10})).unwrap())
        .await
        .unwrap();
    let (arrived, wait) = tokio::sync::oneshot::channel();
    let (resume, release) = tokio::sync::oneshot::channel();
    let pause = Arc::new(Mutex::new(Some(ReplayPause {
        arrived,
        resume: release,
    })));
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = attempts.clone();
    let pool = Arc::new(
        Pool::with_engine(
            PoolConfig {
                workers: 1,
                ..Default::default()
            },
            move || {
                Ok(ReplayEngine {
                    engine: QuickJsEngine::new(Limits::default())?,
                    pause: pause.clone(),
                    attempts: observed.clone(),
                })
            },
        )
        .unwrap(),
    );
    let server = Server::load_plugins(database, pool, &installation.0)
        .await
        .unwrap();
    let mut session = server.connect().await.unwrap();
    assert_distinct_query_seeds(&mut session).await;
    session
        .call(3, "a/determinism:write", json!({"id":presented_id}))
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(10), wait)
        .await
        .unwrap()
        .unwrap();
    assert_snapshot(&first);
    winner.commit().await.unwrap();
    resume.send(()).unwrap();
    let replayed = match next(&mut session).await {
        Event::Response { id: 3, result } => result.unwrap(),
        event => panic!("{event:?}"),
    };
    assert_eq!(
        attempts.load(std::sync::atomic::Ordering::Relaxed),
        2,
        "test did not force a whole-handler retry"
    );
    assert_eq!(replayed, first, "retry changed time or random sequences");
    assert_replayed_plugin_writes(&mut session, &presented_id, &first).await;
    server.close().await.unwrap();
}

async fn assert_distinct_query_seeds(session: &mut Session) {
    let query = call(session, 1, "a/determinism:read", json!({}))
        .await
        .unwrap();
    assert_snapshot(&query);
    let second = call(session, 2, "a/determinism:read", json!({}))
        .await
        .unwrap();
    assert_snapshot(&second);
    assert_ne!(
        query["before"]["random"], second["before"]["random"],
        "separate queries reused a seed"
    );
}

async fn assert_nested_plugin_transactions(writer: &mut server::Session) {
    // Child writes then throws; the parent deliberately catches it.
    assert!(
        call(writer, 2, "a/ops:both", json!({"fail":true}))
            .await
            .unwrap_err()
            .contains("child failure")
    );
    for (id, name) in [(3, "a/ops:list"), (4, "b/ops:list")] {
        assert_eq!(call(writer, id, name, json!({})).await.unwrap(), json!([]));
    }
    call(writer, 5, "a/ops:both", json!({"fail":false}))
        .await
        .unwrap();
    let result = call(writer, 6, "a/ops:combined", json!({})).await.unwrap();
    assert_eq!(result["a"][0]["source"], "a");
    assert_eq!(result["b"][0]["source"], "b");
    assert!(
        result["a"][0]["_id"]
            .as_str()
            .unwrap()
            .starts_with("a/items:")
    );
    assert!(
        result["b"][0]["_id"]
            .as_str()
            .unwrap()
            .starts_with("b/items:")
    );
    assert!(
        call(writer, 7, "a/ops:illegal", json!({}))
            .await
            .unwrap_err()
            .contains("Queries cannot call mutations")
    );
    assert!(
        call(writer, 8, "a/ops:cycle", json!({}))
            .await
            .unwrap_err()
            .contains("cycle")
    );
}

async fn assert_build_identity(
    client: &reqwest::Client,
    base: &str,
    binary: &str,
    local: &std::path::Path,
) {
    let discovery: Value =
        serde_json::from_slice(&std::fs::read(local.join("server.json")).unwrap()).unwrap();
    let output = std::process::Command::new(binary)
        .arg("--build-id")
        .output()
        .unwrap();
    assert!(output.status.success());
    let build = String::from_utf8(output.stdout).unwrap();
    assert_eq!(
        build.trim(),
        format!("{:x}", Sha256::digest(std::fs::read(binary).unwrap()))
    );
    assert_eq!(discovery["buildId"], build.trim());
    let health = client
        .get(format!("{base}/health"))
        .bearer_auth("a".repeat(64))
        .send()
        .await
        .unwrap();
    assert!(health.status().is_success());
    let health: Value = serde_json::from_str(&health.text().await.unwrap()).unwrap();
    assert_eq!(health, discovery);
}

fn assert_authenticated_plugin_controls(base: &str, binary: &str, local: &std::path::Path) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap();
            assert_build_identity(&client, base, binary, local).await;
            assert_eq!(
                client
                    .get(format!("{base}/plugins"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                401
            );
            assert_eq!(
                client
                    .post(format!("{base}/plugins/b/reload"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                401
            );
            assert_eq!(
                client
                    .get(format!("{base}/plugins"))
                    .bearer_auth("a".repeat(64))
                    .header("origin", "http://example.com")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                403
            );
            let response = client
                .get(format!("{base}/plugins/b/assets/bundle.js"))
                .bearer_auth("a".repeat(64))
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                404,
                "backend source must never be a client asset"
            );
            for command in [vec!["plugin", "list"], vec!["plugin", "reload", "b"]] {
                let output = std::process::Command::new(binary)
                    .args(command)
                    .env("TOKAMAK_SERVER_DIR", local)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let metadata: Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(metadata["plugins"].as_array().unwrap().len(), 2);
            }
            // Shutdown may close the HTTP acknowledgement while stopping sockets.
            let _ = client
                .post(format!("{base}/shutdown"))
                .bearer_auth("a".repeat(64))
                .send()
                .await;
        });
}

async fn assert_replayed_plugin_writes(
    session: &mut server::Session,
    presented_id: &str,
    first: &Value,
) {
    let row = call(session, 4, "a/determinism:get", json!({"id":presented_id}))
        .await
        .unwrap();
    assert_eq!(
        row["value"], 11,
        "retry did not read the winner's committed snapshot"
    );
    assert_eq!(&row["replay"], first);
    let audit = call(session, 5, "a/determinism:audit", json!({}))
        .await
        .unwrap();
    assert_eq!(
        audit.as_array().unwrap().len(),
        1,
        "losing attempt leaked a write"
    );
    assert_eq!(&audit[0]["replay"], first);
    let second_mutation = call(
        session,
        6,
        "a/determinism:write",
        json!({"id":presented_id}),
    )
    .await
    .unwrap();
    assert_snapshot(&second_mutation);
    assert_ne!(
        first["before"]["random"], second_mutation["before"]["random"],
        "separate mutations reused a seed"
    );
}

fn install_ui(root: &Installation, id: &str, depends: Value) {
    let directory = root.0.join(id);
    std::fs::create_dir(&directory).unwrap();
    let mut hashes = std::collections::BTreeMap::new();
    for (name, source) in [("ui.js", "export {};"), ("ui.js.map", "{}")] {
        std::fs::write(directory.join(name), source).unwrap();
        hashes.insert(name, format!("{:x}", Sha256::digest(source)));
    }
    let manifest = json!({
        "formatVersion": 1,
        "plugin": { "id": id, "version": "1.0.0", "depends": depends },
        "hashes": hashes,
        "entries": { "ui": { "code": "ui.js", "map": "ui.js.map" } }
    });
    std::fs::write(directory.join("manifest.json"), manifest.to_string()).unwrap();
}

#[test]
fn first_scan_assigns_installation_priority_by_dependencies_then_id() {
    let root = Installation::empty();
    install_ui(&root, "a-dependent", json!({"z-base":"*"}));
    install_ui(&root, "z-base", json!({}));
    install_ui(&root, "b-independent", json!({}));
    let metadata = server::plugins::Catalog::read(&root.0).unwrap().metadata();
    let plugins = metadata["plugins"].as_array().unwrap();
    let ids = plugins
        .iter()
        .map(|plugin| plugin["plugin"]["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["b-independent", "z-base", "a-dependent"]);
    for (index, plugin) in plugins.iter().enumerate() {
        assert_eq!(plugin["installOrder"], index);
    }
}

#[tokio::test]
async fn catalog_preserves_installation_order_on_reload_and_restart() {
    let root = Installation::empty();
    let data = tempfile::tempdir().unwrap();
    let install = |id: &str| install_ui(&root, id, json!({}));
    let start = || async {
        let database = Database::open(Storage::Disk(data.path().join("db")))
            .await
            .unwrap();
        let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
        Server::load_plugins(database, pool, &root.0).await.unwrap()
    };

    install("z-first");
    let server = start().await;
    install("a-second");
    let reload = server.reload_plugin("a-second".to_owned()).await.unwrap();
    assert_eq!(reload["plugins"][0]["plugin"]["id"], "a-second");
    assert_eq!(reload["plugins"][0]["installOrder"], 1);
    assert_eq!(reload["plugins"][1]["installOrder"], 0);
    server.close().await.unwrap();

    // An upgrade can replace the installation directory while the server is closed.
    std::fs::rename(root.0.join("z-first"), root.0.join(".old")).unwrap();
    install("z-first");
    let server = start().await;
    assert_eq!(
        server.plugins().await.unwrap()["plugins"],
        reload["plugins"]
    );
    server.close().await.unwrap();
}

#[tokio::test]
async fn removing_a_plugin_clears_its_saved_window_state() {
    use server::protocol::Request;

    let root = Installation::empty();
    install_ui(&root, "notes", json!({}));
    install_ui(&root, "other", json!({}));
    let database = Database::open(Storage::Memory).await.unwrap();
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    let server = Server::load_plugins(database, pool, &root.0).await.unwrap();
    let mut session = server.connect().await.unwrap();
    for plugin in ["notes", "other"] {
        session
            .sender()
            .request(Request::Mutation {
                id: 1,
                name: "tokamak:writeWindowState".into(),
                args: json!({"plugin": plugin, "key": "pins", "value": [plugin]}),
            })
            .unwrap();
        assert!(matches!(
            next(&mut session).await,
            Event::Response {
                result: Ok(Value::Null),
                ..
            }
        ));
    }

    std::fs::rename(root.0.join("notes"), root.0.join(".notes")).unwrap();
    server.reload_plugin("notes".into()).await.unwrap();
    std::fs::rename(root.0.join(".notes"), root.0.join("notes")).unwrap();
    server.reload_plugin("notes".into()).await.unwrap();
    for (plugin, expected) in [
        ("notes", Value::Null),
        ("other", json!({"value": ["other"]})),
    ] {
        assert_eq!(
            read_window_state(&mut session, plugin, "pins").await,
            expected,
            "{plugin}"
        );
    }
    server.close().await.unwrap();
}

#[tokio::test]
async fn startup_removes_hash_only_window_state_and_keeps_owned_rows() {
    let root = Installation::empty();
    install_ui(&root, "notes", json!({}));
    let data = tempfile::tempdir().unwrap();
    let storage = || Storage::Disk(data.path().join("db"));
    let database = Database::open(storage()).await.unwrap();
    let table = DataSpace::plugin("tokamak.host")
        .unwrap()
        .table(&Table::new("window_state").unwrap())
        .unwrap();
    let mut seed = database.begin().await.unwrap();
    for key in ["old-1", "old-2", "owned"] {
        let row = if key == "owned" {
            json!({"user": "local", "plugin": "notes", "key": key, "value": key})
        } else {
            json!({"value": key})
        };
        seed.insert(&table, json_object(&row).unwrap())
            .await
            .unwrap();
    }
    seed.commit().await.unwrap();

    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    let server = Server::load_plugins(database, pool, &root.0).await.unwrap();
    server.close().await.unwrap();
    let mut database = Database::open(storage()).await.unwrap();
    let mut tx = database.read_only().await.unwrap();
    let rows = tx.query(&table).collect().await.unwrap();
    assert_eq!(rows.len(), 1);
    let row = rows.into_iter().next().unwrap().into_json();
    assert_eq!(row["key"], "owned");
    assert_eq!(row["value"], "owned");
    tx.rollback().await.unwrap();
    database.close().await.unwrap();
}

async fn read_window_state(session: &mut Session, plugin: &str, key: &str) -> Value {
    session
        .sender()
        .request(server::protocol::Request::Query {
            id: 1,
            name: "tokamak:readWindowState".into(),
            args: json!({"plugin": plugin, "key": key}),
        })
        .unwrap();
    match next(session).await {
        Event::Response { result, .. } => result.unwrap(),
        event => panic!("Unexpected event: {event:?}"),
    }
}

#[tokio::test]
async fn hosted_startup_clears_revoked_members_window_state() {
    use server::{
        identity::Identities,
        websocket::{self, HostedWeb, LocalAccess},
    };

    let root = Installation::empty();
    install_ui(&root, "notes", json!({}));
    let data = tempfile::tempdir().unwrap();
    std::fs::write(data.path().join("index.html"), "test").unwrap();
    let owner = "0123456789abcdef0123456789abcdef";
    let members = data.path().join("members.json");
    let stored: Vec<_> = ["Alice", "Bob", "Carol"]
        .into_iter()
        .map(|name| json!({"id":name,"name":name,"role":"member","created_at":1}))
        .collect();
    std::fs::write(&members, json!(stored).to_string()).unwrap();
    let identities = Identities::hosted(members.clone(), owner, "Owner").unwrap();
    let member = |name: &str| server::identity::User {
        id: name.into(),
        name: name.into(),
        role: server::identity::Role::Member,
    };
    let alice = member("Alice");
    let bob = member("Bob");
    let carol = member("Carol");
    let start = || async {
        let database = Database::open(Storage::Disk(data.path().join("db")))
            .await
            .unwrap();
        let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
        Arc::new(Server::load_plugins(database, pool, &root.0).await.unwrap())
    };

    let server = start().await;
    for user in [&alice, &bob, &carol] {
        let mut session = server.connect_as(user.clone()).await.unwrap();
        save_member_pins(&mut session, &user.name).await;
    }
    server.close().await.unwrap();
    // Simulate the persisted revocation succeeding without window-state cleanup.
    identities.revoke(&alice.id).unwrap();
    let identities = Arc::new(Identities::hosted(members, owner, "Owner").unwrap());
    let server = start().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let web = HostedWeb::configure(Some(data.path().to_owned()), address).unwrap();
    let (stop, shutdown) = tokio::sync::oneshot::channel();
    let serving = tokio::spawn(websocket::serve_with_identities(
        listener,
        server.clone(),
        async {
            let _ = shutdown.await;
        },
        Some(LocalAccess {
            token: owner.into(),
            identity: json!({}),
        }),
        web,
        identities,
    ));
    revoke_member_over_http(address, owner, &bob.id).await;
    for (user, expected) in [
        (alice, Value::Null),
        (bob, Value::Null),
        (carol, json!({"value":["Carol"]})),
    ] {
        let mut session = server.connect_as(user).await.unwrap();
        assert_eq!(
            read_window_state(&mut session, "notes", "pins").await,
            expected
        );
    }
    stop.send(()).unwrap();
    serving.await.unwrap().unwrap();
    server.close().await.unwrap();
}

async fn save_member_pins(session: &mut Session, name: &str) {
    assert_eq!(
        read_window_state(session, "notes", "pins").await,
        Value::Null
    );
    session
        .sender()
        .request(server::protocol::Request::Mutation {
            id: 2,
            name: "tokamak:writeWindowState".into(),
            args: json!({"plugin":"notes","key":"pins","value":[name]}),
        })
        .unwrap();
    assert!(matches!(
        next(session).await,
        Event::Response {
            result: Ok(Value::Null),
            ..
        }
    ));
}

async fn revoke_member_over_http(address: std::net::SocketAddr, owner: &str, id: &str) {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    assert_eq!(
        http.get(format!("http://{address}/health"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        http.post(format!("http://{address}/members/{id}/revoke"))
            .bearer_auth(owner)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
}

#[test]
fn plugin_create_writes_the_current_skill_and_refuses_overwrites() {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let scratch = tempfile::tempdir_in(workspace.join("target")).unwrap();
    let folder = scratch.path().join("hello");
    let create = || {
        std::process::Command::new(env!("CARGO_BIN_EXE_tokamak-server"))
            .args(["plugin", "create"])
            .arg(&folder)
            .output()
            .unwrap()
    };
    let created = create();
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let skill = std::fs::read_to_string(folder.join("SKILL.md")).unwrap();
    assert!(skill.contains("ctx.auth.user") && skill.contains("ctx.proc"));
    assert!(!create().status.success());
    assert_eq!(
        std::fs::read_to_string(folder.join("SKILL.md")).unwrap(),
        skill
    );
}

#[tokio::test]
async fn quickjs_allows_an_old_transaction_only_artifact_and_refuses_an_old_action_artifact() {
    let installation = Installation::new();
    installation.change("b", |manifest| {
        for name in ["transactions.js", "transactions.js.map"] {
            manifest["hashes"].as_object_mut().unwrap().remove(name);
        }
    });
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    let server = Server::load_plugins(
        Database::open(Storage::Memory).await.unwrap(),
        pool,
        &installation.0,
    )
    .await
    .unwrap();
    let mut session = server.connect().await.unwrap();
    assert_eq!(
        call(&mut session, 1, "b/ops:list", json!({}))
            .await
            .unwrap(),
        json!([])
    );

    let source =
        r#"export const describe = () => ({schema:{},functions:[{name:"job",kind:"action"}]});"#;
    std::fs::write(installation.0.join("b/bundle.js"), source).unwrap();
    installation.change("b", |manifest| {
        manifest["hashes"]["bundle.js"] = format!("{:x}", Sha256::digest(source)).into();
    });
    let error = server
        .reload_plugin("b".into())
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("require a transaction bundle; rebuild this plugin"),
        "{error}"
    );
    drop(session);
    server.close().await.unwrap();
}
