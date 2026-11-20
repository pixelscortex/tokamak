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
            for file in ["manifest.json", "bundle.js", "bundle.js.map", "api.ts"] {
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
            result
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
            assert_eq!(
                call(&mut writer, 1, "b/ops:providers", json!({}))
                    .await
                    .unwrap(),
                2
            );
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
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
        .block_on(async {
            let pool = Arc::new(Pool::new(PoolConfig {workers:1,..Default::default()}).unwrap());
            let database = Database::open(Storage::Memory).await.unwrap();
            let server = Server::load_plugins(database,pool,&installation.0).await.unwrap();
            let mut session = server.connect().await.unwrap();
            call(&mut session,1,"a/ops:both",json!({"fail":false})).await.unwrap();
            let mut reader = server.connect().await.unwrap();
            reader.subscribe(100,"b/ops:providers",json!({})).unwrap();
            assert!(matches!(next(&mut reader).await,Event::Subscription {id:100,result:Ok(value)} if value == 2));
            let original = server.plugins().await.unwrap()["revision"].clone();
            let path = installation.0.join("b/bundle.js");
            let source = std::fs::read_to_string(&path).unwrap();
            assert!(source.contains("child failure"));
            let changed = source.replace("child failure","reloaded child failure");
            std::fs::write(&path,&changed).unwrap();
            assert!(server.reload_plugin("b".into()).await.unwrap_err().to_string().contains("hash mismatch"));
            assert_eq!(server.plugins().await.unwrap()["revision"],original);
            installation.change("b",|manifest| manifest["hashes"]["bundle.js"] =
                format!("{:x}",Sha256::digest(changed.as_bytes())).into());
            let started = std::time::Instant::now();
            let reloaded = server.reload_plugin("b".into()).await.unwrap();
            assert!(started.elapsed() < Duration::from_secs(2));
            assert_ne!(reloaded["revision"],original);
            assert!(call(&mut session,2,"a/ops:both",json!({"fail":true})).await.unwrap_err().contains("reloaded child failure"));
            assert_eq!(call(&mut session,3,"b/ops:list",json!({})).await.unwrap().as_array().unwrap().len(),1);
            let stable = reloaded["revision"].clone();
            installation.change("b",|manifest| manifest["plugin"]["permissions"] = json!(["net:example.com"]));
            assert!(server.reload_plugin("b".into()).await.unwrap_err().to_string().contains("bump its version"));
            assert_eq!(server.plugins().await.unwrap()["revision"],stable);
            installation.change("b",|manifest| {
                manifest["plugin"]["permissions"] = json!([]);
                manifest["plugin"]["provides"] = json!([]);
            });
            server.reload_plugin("b".into()).await.unwrap();
            assert!(matches!(next(&mut reader).await,Event::Subscription {id:100,result:Ok(value)} if value == 1));
            installation.change("b",|manifest| manifest["plugin"]["consumes"] = json!([]));
            server.reload_plugin("b".into()).await.unwrap();
            assert!(call(&mut session,20,"b/ops:denied",json!({})).await.unwrap_err().contains("does not declare access"));
            assert_eq!(call(&mut session,21,"b/ops:list",json!({})).await.unwrap().as_array().unwrap().len(),1);
            let stable = server.plugins().await.unwrap()["revision"].clone();
            installation.change("b",|manifest| {
                manifest["plugin"]["permissions"] = json!([]);
                manifest["plugin"]["depends"] = json!({"missing":"*"});
            });
            assert!(server.reload_plugin("b".into()).await.unwrap_err().to_string().contains("Missing dependency"));
            assert_eq!(server.plugins().await.unwrap()["revision"],stable);
            // A failed reload leaves both the old code and existing connections usable.
            assert_eq!(call(&mut session,4,"b/ops:list",json!({})).await.unwrap().as_array().unwrap().len(),1);
            assert!(server.plugin_asset("b".into(),"bundle.js".into()).await.unwrap().is_none());
            drop(session);
            drop(reader);
            server.close().await.unwrap();
        });
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
            .stderr(std::process::Stdio::null())
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
            started.elapsed() < Duration::from_secs(90),
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

// Dependency and interface capabilities must not bypass exports. Even a caught
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
    for provider in [false, true] {
        let error = call(
            &mut session,
            1,
            "b/ops:denied",
            json!({"provider":provider}),
        )
        .await
        .unwrap_err();
        assert!(
            error.contains("ops:privateWrite is not exported by a"),
            "{error}"
        );
        for name in ["a/ops:list", "b/ops:list"] {
            assert_eq!(
                call(&mut session, 2, name, json!({})).await.unwrap(),
                json!([])
            );
        }
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
    assert_eq!(
        call(&mut session, 8, "b/ops:providerList", json!({}))
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
    std::fs::create_dir_all(source.join("backend")).unwrap();
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
        source.join("backend/ops.ts"),
        "import { query } from '@tokamak/sdk'; export const answer = query({handler: () => 42});\n",
    )
    .unwrap();
    std::fs::write(
        source.join("backend/tsconfig.json"),
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
        "export { nonexistent } from './backend/ops';\n",
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
    let database = Database::open(Storage::Memory).await.unwrap();
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
    let query = call(&mut session, 1, "a/determinism:read", json!({}))
        .await
        .unwrap();
    assert_snapshot(&query);
    let second_query = call(&mut session, 2, "a/determinism:read", json!({}))
        .await
        .unwrap();
    assert_snapshot(&second_query);
    assert_ne!(
        query["before"]["random"], second_query["before"]["random"],
        "separate queries reused a seed"
    );
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
            let output = std::process::Command::new(binary)
                .args(["plugin", "list"])
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
            let old_command = std::process::Command::new(binary)
                .args(["plugin", "reload", "b"])
                .env("TOKAMAK_SERVER_DIR", local)
                .output()
                .unwrap();
            assert!(!old_command.status.success());
            assert!(String::from_utf8_lossy(&old_command.stderr).contains("tokamak plugin reload"));
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

#[tokio::test]
async fn local_server_skips_missing_and_unbuilt_index_entries_and_prefers_the_index() {
    let installed = Installation::new();
    let temporary = tempfile::tempdir().unwrap();
    let local = temporary.path();
    let indexed = local.join("indexed");
    let dist = indexed.join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    for file in ["manifest.json", "bundle.js", "bundle.js.map", "api.ts"] {
        std::fs::copy(installed.0.join("a").join(file), dist.join(file)).unwrap();
    }
    let manifest = dist.join("manifest.json");
    let mut value: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    value["plugin"]["version"] = json!("1.0.1");
    std::fs::write(manifest, value.to_string()).unwrap();
    let unbuilt = local.join("unbuilt");
    std::fs::create_dir(&unbuilt).unwrap();
    std::fs::write(
        local.join("plugin-index.json"),
        json!({ "a": indexed, "missing": local.join("missing"), "unbuilt": unbuilt }).to_string(),
    )
    .unwrap();
    let mut process = start_index_test_server(local, &installed.0).await;
    let ready = local.join("server.json");
    let identity: Value = serde_json::from_slice(&std::fs::read(ready).unwrap()).unwrap();
    let base = identity["url"]
        .as_str()
        .unwrap()
        .replace("ws://", "http://");
    let base = base.trim_end_matches("/ws");
    let http = reqwest::Client::new();
    let body = http
        .get(format!("{base}/plugins"))
        .bearer_auth("b".repeat(64))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let catalog: Value = serde_json::from_slice(&body).unwrap();
    let plugins = catalog["plugins"].as_array().unwrap();
    assert_eq!(plugins.len(), 2);
    let indexed = plugins
        .iter()
        .find(|plugin| plugin["plugin"]["id"] == "a")
        .unwrap();
    let installed = plugins
        .iter()
        .find(|plugin| plugin["plugin"]["id"] == "b")
        .unwrap();
    assert_eq!(indexed["plugin"]["version"], "1.0.1");
    assert_eq!(indexed["fromIndex"], true);
    assert_eq!(installed["fromIndex"], false);
    // The server can close the connection before writing the shutdown reply.
    if let Ok(response) = http
        .post(format!("{base}/shutdown"))
        .bearer_auth("b".repeat(64))
        .send()
        .await
    {
        response.error_for_status().unwrap();
    }
    let status = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(status) = process.0.try_wait().unwrap() {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(status.success(), "server shutdown failed: {status}");
    assert!(!local.join("server.json").exists());
}

async fn start_index_test_server(local: &std::path::Path, installed: &std::path::Path) -> Process {
    let token = local.join("server.token");
    std::fs::write(&token, "b".repeat(64)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let mut process = Process(
        std::process::Command::new(env!("CARGO_BIN_EXE_tokamak-server"))
            .arg("--local-dir")
            .arg(local)
            .arg("--plugins")
            .arg(installed)
            .env_remove("TOKAMAK_WEB_DIR")
            .env_remove("TKM167_WORKER_TEST_MISSING")
            .spawn()
            .unwrap(),
    );
    let started = std::time::Instant::now();
    while !local.join("server.json").exists() {
        assert!(
            process.0.try_wait().unwrap().is_none(),
            "server exited before readiness"
        );
        assert!(
            started.elapsed() < Duration::from_secs(90),
            "startup timed out"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    process
}

#[tokio::test]
async fn local_server_falls_back_from_a_malformed_index() {
    let installed = Installation::new();
    let temporary = tempfile::tempdir().unwrap();
    let index = temporary.path().join("plugin-index.json");
    std::fs::write(&index, "{broken").unwrap();
    let catalog = index_test_catalog(temporary.path(), &installed.0).await;
    assert_eq!(catalog["plugins"].as_array().unwrap().len(), 2);
    assert!(
        catalog["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["fromIndex"] == false)
    );
}

#[tokio::test]
async fn local_server_keeps_installed_plugins_and_other_index_entries_when_candidates_fail() {
    let installed = Installation::new();
    let temporary = tempfile::tempdir().unwrap();
    let local = temporary.path();
    let bad_override = index_test_artifact(local, &installed, "bad-override", "a", |manifest| {
        manifest["plugin"]["depends"] = json!({"unavailable":"*"});
    });
    let wrong_id = index_test_artifact(local, &installed, "wrong-id", "wrong-id", |_| {});
    let malformed = local.join("malformed");
    std::fs::create_dir_all(malformed.join("dist")).unwrap();
    std::fs::write(malformed.join("dist/manifest.json"), "bad JSON").unwrap();
    let module = index_test_artifact(local, &installed, "module", "invalid-module", |manifest| {
        manifest["hashes"]["bundle.js"] = json!(format!(
            "{:x}",
            Sha256::digest(b"throw new Error('broken module');")
        ));
    });
    std::fs::write(
        module.join("dist/bundle.js"),
        "throw new Error('broken module');",
    )
    .unwrap();
    let valid = index_test_artifact(local, &installed, "valid", "valid", |_| {});
    std::fs::write(
        local.join("plugin-index.json"),
        json!({ "a": bad_override, "relative": "./bad", "mismatch": wrong_id, "malformed": malformed,
            "invalid-module": module, "valid": valid }).to_string(),
    ).unwrap();
    let catalog = index_test_catalog(local, &installed.0).await;
    let plugins = catalog["plugins"].as_array().unwrap();
    assert_eq!(plugins.len(), 3);
    for (id, from_index) in [("a", false), ("b", false), ("valid", true)] {
        assert_eq!(
            plugins
                .iter()
                .find(|plugin| plugin["plugin"]["id"] == id)
                .unwrap()["fromIndex"],
            from_index
        );
    }
}

fn index_test_artifact(
    local: &std::path::Path,
    installed: &Installation,
    folder: &str,
    id: &str,
    edit: impl FnOnce(&mut Value),
) -> PathBuf {
    let folder = local.join(folder);
    let dist = folder.join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    for file in ["manifest.json", "bundle.js", "bundle.js.map", "api.ts"] {
        std::fs::copy(installed.0.join("a").join(file), dist.join(file)).unwrap();
    }
    let manifest = dist.join("manifest.json");
    let mut value: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    value["plugin"]["id"] = json!(id);
    edit(&mut value);
    std::fs::write(manifest, value.to_string()).unwrap();
    folder
}

async fn index_test_catalog(local: &std::path::Path, installed: &std::path::Path) -> Value {
    let mut process = start_index_test_server(local, installed).await;
    let identity: Value =
        serde_json::from_slice(&std::fs::read(local.join("server.json")).unwrap()).unwrap();
    let url = identity["url"]
        .as_str()
        .unwrap()
        .replace("ws://", "http://");
    let base = url.trim_end_matches("/ws");
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let token = "b".repeat(64);
    let body = http
        .get(format!("{base}/plugins"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    if let Ok(reply) = http
        .post(format!("{base}/shutdown"))
        .bearer_auth(token)
        .send()
        .await
    {
        reply.error_for_status().unwrap();
    }
    let status = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Some(status) = process.0.try_wait().unwrap() {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(status.success());
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn local_server_skips_an_indexed_plugin_when_worker_setup_fails() {
    let fixture = Installation::new();
    let temporary = tempfile::tempdir().unwrap();
    let local = temporary.path();
    let installed = local.join("installed");
    std::fs::create_dir(&installed).unwrap();
    let worker = index_test_artifact(local, &fixture, "worker", "worker", |manifest| {
        manifest["plugin"]["depends"] = json!({});
        manifest["plugin"]["runtime"] = json!("worker");
        manifest["plugin"]["permissions"] = json!(["env:TKM167_WORKER_TEST_MISSING"]);
        manifest["entries"]["worker"] =
            json!({ "entry": "worker-entry.js", "code": "worker.js", "map": "worker.js.map" });
        for file in ["worker-entry.js", "worker.js", "worker.js.map"] {
            manifest["hashes"][file] = json!(format!("{:x}", Sha256::digest(b"test")));
        }
    });
    for file in ["worker-entry.js", "worker.js", "worker.js.map"] {
        std::fs::write(worker.join("dist").join(file), "test").unwrap();
    }
    let valid = index_test_artifact(local, &fixture, "valid", "valid", |manifest| {
        manifest["plugin"]["depends"] = json!({});
    });
    std::fs::write(local.join(".env.local"), "invalid environment file !").unwrap();
    std::fs::write(
        local.join("plugin-index.json"),
        json!({ "worker": worker, "valid": valid }).to_string(),
    )
    .unwrap();
    let catalog = index_test_catalog(local, &installed).await;
    let plugins = catalog["plugins"].as_array().unwrap();
    assert_eq!(plugins.len(), 1);
    assert_eq!(plugins[0]["plugin"]["id"], "valid");
}

#[tokio::test]
async fn local_server_keeps_an_installed_copy_when_indexed_grants_cannot_be_recorded() {
    let installed = Installation::new();
    let temporary = tempfile::tempdir().unwrap();
    let local = temporary.path();
    let first = index_test_catalog(local, &installed.0).await;
    assert_eq!(first["plugins"].as_array().unwrap().len(), 2);
    let replacement = index_test_artifact(local, &installed, "replacement", "a", |manifest| {
        manifest["plugin"]["permissions"] = json!(["env:TKM167_TEST_GRANT"]);
    });
    std::fs::write(
        local.join("plugin-index.json"),
        json!({ "a": replacement }).to_string(),
    )
    .unwrap();
    let catalog = index_test_catalog(local, &installed.0).await;
    let plugins = catalog["plugins"].as_array().unwrap();
    assert_eq!(plugins.len(), 2);
    assert!(plugins.iter().all(|plugin| plugin["fromIndex"] == false));
}
