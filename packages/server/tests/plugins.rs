//! Public builder -> manifest resolver -> real SDK/QuickJS -> one DB transaction.
use engine::{Pool, PoolConfig};
use serde_json::{Value, json};
use server::{
    Event, Server, Session,
    data::{Database, Storage},
};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::Duration,
};

struct Installation(PathBuf);
impl Installation {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
            "target/plugin-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        let source = built();
        for id in ["a", "b"] {
            let target = path.join(id);
            std::fs::create_dir(&target).unwrap();
            for file in ["manifest.json", "bundle.js", "bundle.js.map", "api.ts"] {
                std::fs::copy(source.join(id).join("dist").join(file), target.join(file)).unwrap();
            }
        }
        Self(path)
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
#[test]
fn public_ui_builder_hashes_final_assets_for_the_native_catalog() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("proto")
        .args(["run", "bun", "--", "packages/build/src/build.ts", "lab"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact = server::plugins::Artifact::read(&root.join("lab/dist")).unwrap();
    assert!(artifact.bundle.is_none());
    assert!(artifact.ui_asset("ui.js").is_some());
    assert!(artifact.ui_asset("ui.js.map").is_some());
}

async fn next(session: &mut Session) -> Event {
    tokio::time::timeout(Duration::from_secs(10), session.recv())
        .await
        .unwrap()
        .unwrap()
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
            // Child writes then throws; the parent deliberately catches it.
            assert!(
                call(&mut writer, 2, "a/ops:both", json!({"fail":true}))
                    .await
                    .unwrap_err()
                    .contains("child failure")
            );
            for (id, name) in [(3, "a/ops:list"), (4, "b/ops:list")] {
                assert_eq!(
                    call(&mut writer, id, name, json!({})).await.unwrap(),
                    json!([])
                );
            }
            call(&mut writer, 5, "a/ops:both", json!({"fail":false}))
                .await
                .unwrap();
            let result = call(&mut writer, 6, "a/ops:combined", json!({}))
                .await
                .unwrap();
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
                call(&mut writer, 7, "a/ops:illegal", json!({}))
                    .await
                    .unwrap_err()
                    .contains("Queries cannot call mutations")
            );
            assert!(
                call(&mut writer, 8, "a/ops:cycle", json!({}))
                    .await
                    .unwrap_err()
                    .contains("cycle")
            );
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
    let binary = env!("CARGO_BIN_EXE_tokamak");
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
                    .env("TOKAMAK_SERVER_DIR", &local)
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
