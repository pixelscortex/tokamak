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
                "public.d.ts",
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
        for id in ["b", "a"] {
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
    for file in [
        "manifest.json",
        "bundle.js",
        "bundle.js.map",
        "api.ts",
        "public.d.ts",
    ] {
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
    assert_indexed_catalog(&http, base).await;
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

async fn assert_indexed_catalog(http: &reqwest::Client, base: &str) {
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
    let refused = http
        .delete(format!("{base}/plugins/a"))
        .bearer_auth("b".repeat(64))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 400);
    let error: Value = serde_json::from_slice(&refused.bytes().await.unwrap()).unwrap();
    assert!(
        error["error"]
            .as_str()
            .unwrap()
            .contains("tokamak plugin remove a")
    );
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
    for file in [
        "manifest.json",
        "bundle.js",
        "bundle.js.map",
        "api.ts",
        "public.d.ts",
    ] {
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

mod package_upload {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use server::{
        Backend,
        identity::Identities,
        websocket::{self, HostedWeb, LocalAccess},
    };
    use std::{
        collections::BTreeMap,
        fs,
        io::{Cursor, Write},
        path::Path,
    };
    use tokio::{
        net::{TcpListener, TcpStream},
        sync::oneshot,
        task::JoinHandle,
    };
    use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

    const OWNER: &str = "0123456789abcdef0123456789abcdef";
    type Files = BTreeMap<String, Vec<u8>>;
    type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

    struct SharedServer {
        backend: Backend,
        serving: JoinHandle<std::io::Result<()>>,
        stop: oneshot::Sender<()>,
        http: String,
        client: reqwest::Client,
    }

    impl SharedServer {
        async fn start(data: &Path, root: &Path) -> Self {
            fs::write(data.join("index.html"), "test").unwrap();
            let backend =
                Backend::start_plugins(Storage::Disk(data.join("store")), Default::default(), root)
                    .await
                    .unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let web = HostedWeb::configure(Some(data.to_owned()), address).unwrap();
            let identities =
                Arc::new(Identities::hosted(data.join("members.json"), OWNER, "Owner").unwrap());
            let (stop, shutdown) = oneshot::channel();
            let serving = tokio::spawn(websocket::serve_with_identities(
                listener,
                backend.server().clone(),
                async {
                    let _ = shutdown.await;
                },
                Some(LocalAccess {
                    token: OWNER.into(),
                    identity: json!({}),
                }),
                web,
                identities,
            ));
            Self {
                backend,
                serving,
                stop,
                http: format!("http://{address}"),
                client: reqwest::Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(10))
                    .build()
                    .unwrap(),
            }
        }

        async fn close(self) {
            self.stop.send(()).unwrap();
            self.serving.await.unwrap().unwrap();
            self.backend.close().await.unwrap();
        }

        async fn socket(&self) -> Socket {
            tokio_tungstenite::connect_async(format!(
                "{}/ws?token={OWNER}",
                self.http.replace("http:", "ws:")
            ))
            .await
            .unwrap()
            .0
        }

        async fn upload(&self, token: &str, build: &str, body: Vec<u8>) -> reqwest::Response {
            self.client
                .put(format!("{}/plugins/a/package", self.http))
                .bearer_auth(token)
                .header("x-tokamak-build-id", build)
                .body(body)
                .send()
                .await
                .unwrap()
        }

        async fn remove(&self, token: &str, id: &str) -> reqwest::Response {
            self.client
                .delete(format!("{}/plugins/{id}", self.http))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
        }

        async fn get(&self, path: &str) -> Value {
            response_json(
                self.client
                    .get(format!("{}{path}", self.http))
                    .bearer_auth(OWNER)
                    .send()
                    .await
                    .unwrap()
                    .error_for_status()
                    .unwrap(),
            )
            .await
        }
    }

    async fn response_json(response: reqwest::Response) -> Value {
        serde_json::from_str(&response.text().await.unwrap()).unwrap()
    }

    async fn send(socket: &mut Socket, id: u64, kind: &str, name: &str, args: Value) {
        socket
            .send(Message::Text(
                json!({
                    "type":kind, "id":id, "name":name, "args":args
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
    }

    async fn event(socket: &mut Socket, matches: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let message = socket.next().await.unwrap().unwrap();
                let event: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                if matches(&event) {
                    return event;
                }
            }
        })
        .await
        .unwrap()
    }

    async fn result(socket: &mut Socket, id: u64) -> Value {
        let event = event(socket, |event| event["id"] == id).await;
        assert!(event["result"].get("Err").is_none(), "{event}");
        event["result"]["Ok"].clone()
    }

    async fn rows(socket: &mut Socket, plugin: &str) -> Value {
        send(socket, 1, "query", &format!("{plugin}/ops:list"), json!({})).await;
        result(socket, 1).await
    }

    async fn wait_for_rows(socket: &mut Socket, plugin: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut current = rows(socket, plugin).await;
            while current == json!([]) {
                tokio::time::sleep(Duration::from_millis(10)).await;
                current = rows(socket, plugin).await;
            }
            current
        })
        .await
        .unwrap()
    }

    fn fixture() -> (Installation, Files) {
        let installation = Installation::new();
        let path = installation.0.join("a");
        let files = package_files(&path);
        fs::remove_dir_all(path).unwrap();
        (installation, files)
    }

    fn package_files(path: &Path) -> Files {
        let manifest: Value =
            serde_json::from_slice(&fs::read(path.join("manifest.json")).unwrap()).unwrap();
        let mut files = Files::from([(
            "manifest.json".into(),
            fs::read(path.join("manifest.json")).unwrap(),
        )]);
        for name in manifest["hashes"].as_object().unwrap().keys() {
            files.insert(name.clone(), fs::read(path.join(name)).unwrap());
        }
        files
    }

    fn change_manifest(files: &mut Files, edit: impl FnOnce(&mut Value)) {
        let mut manifest = serde_json::from_slice(&files["manifest.json"]).unwrap();
        edit(&mut manifest);
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
    }

    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn archive(files: &Files) -> (String, Vec<u8>) {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in files {
            zip.start_file(name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        (
            digest(&files["manifest.json"]),
            zip.finish().unwrap().into_inner(),
        )
    }

    async fn upload_ok(
        server: &SharedServer,
        files: &Files,
        status: &str,
        version: &str,
    ) -> String {
        let (build, zip) = archive(files);
        let response = server.upload(OWNER, &build, zip).await;
        let code = response.status();
        let value = response_json(response).await;
        assert_eq!(code, 200, "{value}");
        assert_eq!(
            value,
            json!({"status":status, "id":"a", "version":version, "buildId":build})
        );
        build
    }

    fn revision(catalog: &Value, id: &str) -> Value {
        catalog["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|plugin| plugin["plugin"]["id"] == id)
            .unwrap()["revision"]
            .clone()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn package_swap_keeps_unrelated_action_and_build_then_recovers_on_restart() {
        let (installation, mut files) = fixture();
        let data = tempfile::tempdir().unwrap();
        let server = SharedServer::start(data.path(), &installation.0).await;
        let initial = upload_ok(&server, &files, "installed", "1.0.0").await;
        assert_eq!(revision(&server.get("/plugins").await, "a"), initial);
        upload_ok(&server, &files, "unchanged", "1.0.0").await;
        let health = server
            .client
            .get(format!("{}/health", server.http))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response_json(health).await["version"],
            env!("CARGO_PKG_VERSION")
        );

        let mut action = server.socket().await;
        let mut caller = server.socket().await;
        assert_eq!(rows(&mut caller, "a").await, json!([]));
        let old_b = revision(&server.get("/plugins").await, "b");
        send(
            &mut action,
            2,
            "action",
            "b/ops:waitForSecondRow",
            json!({}),
        )
        .await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while rows(&mut caller, "b").await == json!([]) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        let b_bundle = installation.0.join("b/bundle.js");
        let b_code = fs::read_to_string(&b_bundle)
            .unwrap()
            .replace("old action finished", "new action finished");
        fs::write(&b_bundle, &b_code).unwrap();
        installation.change("b", |manifest| {
            manifest["hashes"]["bundle.js"] = json!(digest(b_code.as_bytes()));
        });
        let code = std::str::from_utf8(&files["bundle.js"])
            .unwrap()
            .replace("private a", "updated a");
        assert_ne!(code.as_bytes(), files["bundle.js"]);
        let hash = digest(code.as_bytes());
        files.insert("bundle.js".into(), code.into_bytes());
        change_manifest(&mut files, |manifest| {
            manifest["plugin"]["api"] = json!(env!("CARGO_PKG_VERSION"));
            manifest["plugin"]["version"] = json!("1.0.1");
            manifest["hashes"]["bundle.js"] = json!(hash);
        });
        let updated = upload_ok(&server, &files, "updated", "1.0.1").await;
        let catalog = server.get("/plugins").await;
        assert_eq!(revision(&catalog, "a"), updated);
        assert_eq!(revision(&catalog, "b"), old_b);
        send(
            &mut caller,
            3,
            "mutation",
            "b/ops:add",
            json!({"fail":false}),
        )
        .await;
        result(&mut caller, 3).await;
        assert_eq!(result(&mut action, 2).await, "old action finished");
        send(&mut caller, 4, "mutation", "a/ops:privateWrite", json!({})).await;
        result(&mut caller, 4).await;
        assert_eq!(rows(&mut caller, "a").await[0]["source"], "updated a");
        drop((action, caller));
        server.close().await;

        assert_restart(data.path(), &installation.0, files, &updated).await;
    }

    async fn assert_restart(data: &Path, installed: &Path, mut files: Files, updated: &str) {
        let stored = data.join("plugins");
        let backup = stored.join(".package-backup-a");
        fs::rename(stored.join("a"), &backup).unwrap();
        let interrupted = stored.join(".package-stage-interrupted");
        fs::create_dir(&interrupted).unwrap();
        let server = SharedServer::start(data, installed).await;
        assert!(!backup.exists());
        assert!(!interrupted.exists());
        assert_eq!(revision(&server.get("/plugins").await, "a"), updated);
        assert_eq!(
            rows(&mut server.socket().await, "a").await[0]["source"],
            "updated a"
        );
        server.close().await;

        change_manifest(&mut files, |manifest| {
            manifest["plugin"]["api"] = json!("tokamak@0.2.0")
        });
        let (_, zip) = archive(&files);
        let package = stored.join("a");
        fs::write(package.join("package.zip"), zip).unwrap();
        fs::write(package.join("dist/manifest.json"), &files["manifest.json"]).unwrap();
        let server = SharedServer::start(data, installed).await;
        let catalog = server.get("/plugins").await;
        assert_eq!(catalog["skipped"]["a"], "needs rebuild");
        assert_eq!(catalog["plugins"].as_array().unwrap().len(), 1);
        assert_eq!(
            rows(&mut server.socket().await, "b")
                .await
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(package.join("package.zip").exists());
        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refused_packages_leave_the_running_and_stored_build_alone() {
        let (installation, files) = fixture();
        let data = tempfile::tempdir().unwrap();
        let server = SharedServer::start(data.path(), &installation.0).await;
        let active = upload_ok(&server, &files, "installed", "1.0.0").await;
        let stored = data.path().join("plugins/a/package.zip");
        let original = fs::read(&stored).unwrap();
        let member = response_json(
            server
                .client
                .post(format!("{}/members", server.http))
                .bearer_auth(OWNER)
                .body(json!({"name":"Member"}).to_string())
                .send()
                .await
                .unwrap(),
        )
        .await;
        let member = member["token"].as_str().unwrap();
        let mut socket = server.socket().await;
        let mut cases = vec![
            (OWNER, "0".repeat(64), original.clone(), 400, "Build id"),
            (
                OWNER,
                active.clone(),
                vec![0; 50 * 1024 * 1024 + 1],
                413,
                "50 MiB",
            ),
            (member, active.clone(), original.clone(), 403, ""),
            (
                OWNER,
                "0".repeat(64),
                b"not a zip".to_vec(),
                400,
                "Invalid ZIP",
            ),
        ];

        cases.extend(
            invalid_packages(&files)
                .into_iter()
                .map(|(build, zip, reason)| (OWNER, build, zip, 400, reason)),
        );
        for (token, build, zip, status, reason) in cases {
            let response = server.upload(token, &build, zip).await;
            assert_eq!(response.status(), status, "{reason}");
            if !reason.is_empty() {
                let error = response_json(response).await;
                assert!(error["error"].as_str().unwrap().contains(reason), "{error}");
            }
            assert_eq!(revision(&server.get("/plugins").await, "a"), active);
            assert_eq!(rows(&mut socket, "a").await, json!([]));
            assert_eq!(fs::read(&stored).unwrap(), original);
            assert_eq!(
                fs::read_dir(data.path().join("plugins")).unwrap().count(),
                1
            );
        }
        drop(socket);
        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn removing_a_shared_plugin_preserves_rows_and_another_plugins_action() {
        let (installation, files) = fixture();
        let data = tempfile::tempdir().unwrap();
        let server = SharedServer::start(data.path(), &installation.0).await;
        upload_ok(&server, &files, "installed", "1.0.0").await;
        let original_b = revision(&server.get("/plugins").await, "b");

        let mut caller = server.socket().await;
        let mut retiring = server.socket().await;
        send(
            &mut retiring,
            3,
            "action",
            "a/ops:waitForRemoval",
            json!({}),
        )
        .await;
        let original_rows = wait_for_rows(&mut caller, "a").await;
        assert_eq!(original_rows[0]["source"], "private a");

        let mut action = server.socket().await;
        send(
            &mut action,
            4,
            "action",
            "b/ops:waitForSecondRow",
            json!({}),
        )
        .await;
        wait_for_rows(&mut caller, "b").await;
        let bundle = installation.0.join("b/bundle.js");
        let updated = fs::read_to_string(&bundle)
            .unwrap()
            .replace("old action finished", "new action finished");
        fs::write(bundle, &updated).unwrap();
        installation.change("b", |m| {
            m["hashes"]["bundle.js"] = json!(digest(updated.as_bytes()))
        });

        let removed = server.remove(OWNER, "a").await.error_for_status().unwrap();
        assert_eq!(
            response_json(removed).await,
            json!({"id":"a", "removed":true})
        );
        let changed = event(&mut caller, |event| event["type"] == "pluginchanged").await;
        let catalog = server.get("/plugins").await;
        assert_eq!(changed["plugins"], json!(["a"]));
        assert_eq!(changed["catalog"]["revision"], catalog["revision"]);
        assert_eq!(catalog["plugins"].as_array().unwrap().len(), 1);
        assert_eq!(revision(&catalog, "b"), original_b);
        assert!(!data.path().join("plugins/a").exists());
        let retired = event(&mut retiring, |event| event["id"] == 3).await;
        assert_eq!(
            retired["result"]["Err"],
            "Plugin action cancelled by reload"
        );
        send(&mut caller, 5, "query", "a/ops:list", json!({})).await;
        let denied = event(&mut caller, |event| event["id"] == 5).await;
        assert_eq!(denied["result"]["Err"], "unknown function: a/ops:list");

        send(
            &mut caller,
            6,
            "mutation",
            "b/ops:add",
            json!({"fail":false}),
        )
        .await;
        result(&mut caller, 6).await;
        assert_eq!(result(&mut action, 4).await, "old action finished");
        drop((caller, action, retiring));
        server.close().await;

        let restarted = SharedServer::start(data.path(), &installation.0).await;
        let catalog = restarted.get("/plugins").await;
        assert_eq!(catalog["plugins"].as_array().unwrap().len(), 1);
        assert_eq!(catalog["plugins"][0]["plugin"]["id"], "b");
        upload_ok(&restarted, &files, "installed", "1.0.0").await;
        assert_eq!(
            rows(&mut restarted.socket().await, "a").await,
            original_rows
        );
        restarted.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn removal_refuses_members_unknown_ids_folder_plugins_and_dependencies() {
        let (installation, mut files) = fixture();
        let data = tempfile::tempdir().unwrap();
        let server = SharedServer::start(data.path(), &installation.0).await;
        change_manifest(&mut files, |m| m["plugin"]["depends"] = json!({}));
        let build = upload_ok(&server, &files, "installed", "1.0.0").await;
        let member = response_json(
            server
                .client
                .post(format!("{}/members", server.http))
                .bearer_auth(OWNER)
                .body(json!({"name":"Member"}).to_string())
                .send()
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(
            server
                .remove(member["token"].as_str().unwrap(), "a")
                .await
                .status(),
            403
        );

        installation.change("b", |m| m["plugin"]["depends"] = json!({"a":"^1.0"}));
        server
            .client
            .post(format!("{}/plugins/b/reload", server.http))
            .bearer_auth(OWNER)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        for (id, message) in [
            ("missing", "Plugin not found: missing"),
            ("b", "comes from the --plugins folder"),
            ("a", "plugin b depends on it"),
        ] {
            let response = server.remove(OWNER, id).await;
            assert_eq!(response.status(), 400);
            let value = response_json(response).await;
            assert!(
                value["error"].as_str().unwrap().contains(message),
                "{value}"
            );
        }
        assert_eq!(revision(&server.get("/plugins").await, "a"), build);
        assert!(data.path().join("plugins/a/package.zip").is_file());
        let mut caller = server.socket().await;
        assert_eq!(rows(&mut caller, "a").await, json!([]));
        assert_eq!(rows(&mut caller, "b").await, json!([]));
        drop(caller);
        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn removing_an_override_restores_the_folder_build_or_keeps_the_override() {
        let installation = Installation::new();
        let data = tempfile::tempdir().unwrap();
        let dir = installation.0.join("a");
        let mut files = package_files(&dir);
        let manifest = files["manifest.json"].clone();
        let code = std::str::from_utf8(&files["bundle.js"])
            .unwrap()
            .replace("private a", "shared a");
        let hash = digest(code.as_bytes());
        files.insert("bundle.js".into(), code.into_bytes());
        change_manifest(&mut files, |m| {
            m["plugin"]["version"] = json!("1.0.1");
            m["hashes"]["bundle.js"] = json!(hash);
        });

        let server = SharedServer::start(data.path(), &installation.0).await;
        let local = revision(&server.get("/plugins").await, "a");
        let shared = upload_ok(&server, &files, "updated", "1.0.1").await;
        let mut caller = server.socket().await;
        send(&mut caller, 3, "mutation", "a/ops:privateWrite", json!({})).await;
        result(&mut caller, 3).await;

        installation.change("a", |m| m["plugin"]["api"] = json!("tokamak@^99"));
        let refused = server.remove(OWNER, "a").await;
        assert_eq!(refused.status(), 400);
        assert!(
            response_json(refused).await["error"]
                .as_str()
                .unwrap()
                .contains("Incompatible host API")
        );
        assert_eq!(revision(&server.get("/plugins").await, "a"), shared);
        assert!(data.path().join("plugins/a/package.zip").is_file());
        assert_eq!(rows(&mut caller, "a").await[0]["source"], "shared a");

        fs::write(dir.join("manifest.json"), manifest).unwrap();
        let reverted = server.remove(OWNER, "a").await.error_for_status().unwrap();
        assert_eq!(
            response_json(reverted).await,
            json!({
                "id":"a", "removed":false, "reverted":true, "buildId":local,
            })
        );
        assert_eq!(revision(&server.get("/plugins").await, "a"), local);
        assert!(!data.path().join("plugins/a").exists());
        send(&mut caller, 4, "mutation", "a/ops:privateWrite", json!({})).await;
        result(&mut caller, 4).await;
        let restored_rows = rows(&mut caller, "a").await;
        let sources = restored_rows
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["source"].as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(sources, ["private a", "shared a"].into_iter().collect());
        drop(caller);
        server.close().await;

        let restarted = SharedServer::start(data.path(), &installation.0).await;
        assert_eq!(revision(&restarted.get("/plugins").await, "a"), local);
        assert_eq!(
            rows(&mut restarted.socket().await, "a").await,
            restored_rows
        );
        restarted.close().await;
    }

    fn invalid_packages(files: &Files) -> Vec<(String, Vec<u8>, &'static str)> {
        let mut cases = Vec::new();
        let mut variant = |message, edit: fn(&mut Files)| {
            let mut files = files.clone();
            edit(&mut files);
            let (build, zip) = archive(&files);
            cases.push((build, zip, message));
        };
        variant("hash mismatch", |files| {
            files.get_mut("bundle.js").unwrap().push(b' ');
        });
        variant("Missing package file", |files| {
            files.remove("bundle.js");
        });
        variant("not listed", |files| {
            files.insert("extra.js".into(), vec![]);
        });
        variant("stay inside", |files| {
            files.insert("../escape".into(), vec![]);
        });
        variant("Invalid plugin manifest", |files| {
            files.insert("manifest.json".into(), b"{".to_vec());
        });
        variant("differs from the address", |files| {
            change_manifest(files, |m| m["plugin"]["id"] = json!("wrong"))
        });
        variant("Upgrade the server", |files| {
            change_manifest(files, |m| m["plugin"]["api"] = json!("tokamak@0.1.99"))
        });
        variant("Rebuild with the current CLI", |files| {
            change_manifest(files, |m| m["plugin"]["api"] = json!("tokamak@0.2.0"))
        });
        variant("Missing dependency", |files| {
            change_manifest(files, |m| m["plugin"]["depends"]["missing"] = json!("*"))
        });
        variant(
            "Plugins with machine actions cannot be shared yet",
            |files| change_manifest(files, |m| m["plugin"]["runtime"] = json!("worker")),
        );
        variant("Could not inspect plugin", |files| {
            let code = b"throw new Error('candidate could not start');";
            files.insert("bundle.js".into(), code.to_vec());
            change_manifest(files, |m| m["hashes"]["bundle.js"] = json!(digest(code)));
        });
        cases
    }
}
