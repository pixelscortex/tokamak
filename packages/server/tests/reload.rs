use engine::{Pool, PoolConfig};
use serde_json::{Value, json};
use server::{
    Event, Server,
    data::{Database, Storage},
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, OnceLock},
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
fn installation() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugins");
    for (name, source) in artifacts() {
        if !name.starts_with("a/") && !name.starts_with("b/") {
            continue;
        }
        let path = root.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, source).unwrap();
    }
    dir
}
fn edit_manifest(root: &std::path::Path, id: &str, edit: impl FnOnce(&mut Value)) {
    let path = root.join(id).join("manifest.json");
    let mut manifest = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    edit(&mut manifest);
    std::fs::write(path, manifest.to_string()).unwrap();
}

async fn action_response(session: &mut server::Session, expected: u64) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match session.recv().await.unwrap().unwrap() {
                Event::Response { id, result } => {
                    assert_eq!(id, expected);
                    return result;
                }
                Event::PluginChanged { .. } => {}
                event => panic!("unexpected event: {event:?}"),
            }
        }
    })
    .await
    .expect("action caller must receive a response")
}

const A: &str = "a/ops:sleep";
const B: &str = "b/ops:callerAction";

fn install_worker(root: &Path, id: &str) {
    edit_manifest(root, id, |m| {
        m["plugin"]["runtime"] = json!("worker");
        m["entries"]["worker"] =
            json!({"entry":"worker-entry.js","code":"worker.js","map":"worker.js.map"});
    });
    write_asset(root, id, "worker.js", "");
    write_asset(root, id, "worker.js.map", "{}");
    // "hold" ignores abort for as long as the handler is busy, as the SDK does
    // when a handler never checks its signal and has no pending host operation.
    write_asset(
        root,
        id,
        "worker-entry.js",
        r#"
        import {createInterface} from "node:readline";
        import {existsSync, writeFileSync} from "node:fs";
        import {pathToFileURL} from "node:url";
        await import(pathToFileURL(process.argv[2]).href);
        const send = (frame) => console.log(JSON.stringify(frame));
        const result = (id, value) => send({type:"result", id, value});
        const host = (id, name, payload) => send({type:"op", call:id, id, name, payload});
        for await (const line of createInterface({input:process.stdin})) {
          const {type,id,args,error,value} = JSON.parse(line);
          if (type === "opResult") {
            if (error) send({type:"result", id, error});
            else result(id, value);
          }
          if (type !== "invoke") continue;
          if (!args.hold) { result(id, process.pid); continue; }
          writeFileSync(args.hold + ".started", "");
          const timer = setInterval(() => {
            if (!existsSync(args.hold + ".release")) return;
            clearInterval(timer);
            if (args.op) host(id, args.op, args.payload);
            else result(id, process.pid);
          }, 10);
        }
    "#,
    );
}

fn use_sdk_worker_for_b(root: &Path) {
    write_asset(
        root,
        "b",
        "worker-entry.js",
        &artifacts()["acp/worker-entry.js"],
    );
    write_asset(
        root,
        "b",
        "worker.js",
        r#"
        import {existsSync, writeFileSync} from "node:fs";
        export const functions = {
          "ops:callerAction": {
            kind: "action",
            args: {kind:"object", fields:{hold:{kind:"optional", inner:{kind:"string"}}}},
            async invoke({hold}) {
              if (hold) {
                writeFileSync(hold + ".started", "");
                // Ordinary asynchronous work that does not check the abort signal.
                while (!existsSync(hold + ".release"))
                  await new Promise(resolve => setTimeout(resolve, 10));
              }
              return process.pid;
            }
          }
        };
    "#,
    );
}

fn write_asset(root: &Path, id: &str, name: &str, value: &str) {
    std::fs::write(root.join(id).join(name), value).unwrap();
    edit_manifest(root, id, |m| {
        m["hashes"][name] = json!(format!("{:x}", Sha256::digest(value)))
    });
}
fn bump(root: &Path, id: &str) {
    edit_manifest(root, id, |m| m["plugin"]["version"] = json!("1.0.1"));
}
async fn start(root: &Path) -> Server {
    let db = Database::open(Storage::Memory).await.unwrap();
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    Server::load_plugins(db, pool, root).await.unwrap()
}
fn invoke(session: &server::Session, id: u64, name: &str, args: Value) {
    session
        .sender()
        .request(
            serde_json::from_value(json!({"type":"action", "id": id, "name": name, "args": args}))
                .unwrap(),
        )
        .unwrap();
}
fn dir(root: &Path, id: &str) -> PathBuf {
    root.parent().unwrap().join("plugin-data").join(id)
}
async fn started(root: &Path, id: &str, hold: &str) {
    let path = dir(root, id).join(format!("{hold}.started"));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !path.is_file() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("action never started");
}
fn release(root: &Path, id: &str, hold: &str) {
    std::fs::write(dir(root, id).join(format!("{hold}.release")), "").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn surviving_action_can_call_current_dependency_action() {
    let installation = installation();
    let root = &installation.path().join("plugins");
    for id in ["a", "b"] {
        install_worker(root, id);
    }
    use_sdk_worker_for_b(root);
    let server = start(root).await;
    let mut a = server.connect().await.unwrap();
    let mut b = server.connect().await.unwrap();
    invoke(
        &a,
        1,
        A,
        json!({"hold":"a", "op":"plugin.call", "payload":{"name":B,"args":{}}}),
    );
    started(root, "a", "a").await;
    bump(root, "b");
    server.reload_plugin("b".into()).await.unwrap();
    invoke(&b, 1, B, json!({}));
    let new_pid = action_response(&mut b, 1).await.unwrap();
    release(root, "a", "a");
    assert_eq!(action_response(&mut a, 1).await, Ok(new_pid));
    drop((a, b));
    server.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn surviving_action_sees_providers_added_during_action() {
    let installation = installation();
    let root = &installation.path().join("plugins");
    install_worker(root, "a");
    edit_manifest(root, "a", |m| m["plugin"]["consumes"] = json!(["example"]));
    let server = start(root).await;
    let mut a = server.connect().await.unwrap();
    invoke(
        &a,
        1,
        A,
        json!({"hold":"a", "op":"plugin.providers", "payload":{"interface":"example"}}),
    );
    started(root, "a", "a").await;
    edit_manifest(root, "b", |m| m["plugin"]["provides"] = json!(["example"]));
    server.reload_plugin("b".into()).await.unwrap();
    release(root, "a", "a");
    assert_eq!(action_response(&mut a, 1).await, Ok(json!(["b"])));
    drop(a);
    server.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reloading_parent_does_not_kill_unchanged_callees_process() {
    let installation = installation();
    let root = &installation.path().join("plugins");
    for id in ["a", "b"] {
        install_worker(root, id);
    }
    use_sdk_worker_for_b(root);
    let server = start(root).await;
    let mut a = server.connect().await.unwrap();
    let mut b = server.connect().await.unwrap();
    invoke(&b, 1, B, json!({}));
    let old_pid = action_response(&mut b, 1).await.unwrap();
    invoke(&b, 2, B, json!({"hold":"independent"}));
    invoke(
        &a,
        1,
        A,
        json!({"hold":"parent", "op":"plugin.call", "payload":{"name":B,"args":{"hold":"nested"}}}),
    );
    started(root, "a", "parent").await;
    release(root, "a", "parent");
    started(root, "b", "nested").await;
    started(root, "b", "independent").await;
    bump(root, "a");
    server.reload_plugin("a".into()).await.unwrap();
    assert_eq!(
        action_response(&mut a, 1).await,
        Err("Plugin action cancelled by reload".into())
    );
    // Wait longer than the worker's cancel grace, while the child remains blocked.
    tokio::time::sleep(Duration::from_millis(800)).await;
    release(root, "b", "independent");
    let independent = action_response(&mut b, 2).await;
    invoke(&b, 3, B, json!({}));
    let new_pid = action_response(&mut b, 3).await.unwrap();
    assert_eq!((independent, new_pid), (Ok(old_pid.clone()), old_pid));
    release(root, "b", "nested");
    drop((a, b));
    server.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reloading_callee_returns_a_nested_error_without_restarting_parent() {
    let installation = installation();
    let root = &installation.path().join("plugins");
    for id in ["a", "b"] {
        install_worker(root, id);
    }
    let server = start(root).await;
    let mut a = server.connect().await.unwrap();
    invoke(&a, 1, A, json!({}));
    let old_pid = action_response(&mut a, 1).await.unwrap();
    invoke(
        &a,
        2,
        A,
        json!({"hold":"parent", "op":"plugin.call", "payload":{"name":B,"args":{"hold":"nested"}}}),
    );
    started(root, "a", "parent").await;
    release(root, "a", "parent");
    started(root, "b", "nested").await;
    bump(root, "b");
    server.reload_plugin("b".into()).await.unwrap();
    let error = action_response(&mut a, 2).await.unwrap_err();
    assert_eq!(error, "Plugin action cancelled by reload");
    invoke(&a, 3, A, json!({}));
    assert_eq!(action_response(&mut a, 3).await.unwrap(), old_pid);
    drop(a);
    server.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn broken_worker_candidate_keeps_both_old_builds() {
    let installation = installation();
    let root = &installation.path().join("plugins");
    for id in ["a", "b"] {
        install_worker(root, id);
    }
    use_sdk_worker_for_b(root);
    let server = start(root).await;
    let mut s = server.connect().await.unwrap();
    invoke(&s, 1, A, json!({}));
    let a_pid = action_response(&mut s, 1).await.unwrap();
    invoke(&s, 2, B, json!({}));
    let b_pid = action_response(&mut s, 2).await.unwrap();
    let before = server.plugins().await.unwrap();
    write_asset(
        root,
        "a",
        "worker.js",
        r#"import { writeFileSync } from "node:fs"; writeFileSync("candidate-started", "");"#,
    );
    write_asset(root, "b", "worker.js", "export const broken = ;");
    let error = server
        .reload_plugin("b".into())
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("Plugin b") && error.contains("Unexpected"),
        "{error}"
    );
    assert_eq!(server.plugins().await.unwrap(), before);
    assert!(!dir(root, "a").join("candidate-started").exists());
    invoke(&s, 3, A, json!({}));
    let a_after = action_response(&mut s, 3).await;
    invoke(&s, 4, B, json!({}));
    let b_after = action_response(&mut s, 4).await;
    assert_eq!(a_after, Ok(a_pid));
    assert_eq!(b_after, Ok(b_pid));
    drop(s);
    server.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_inspected_candidate_keeps_other_pending_change_and_workers() {
    let installation = installation();
    let root = &installation.path().join("plugins");
    for id in ["a", "b"] {
        install_worker(root, id);
    }
    let server = start(root).await;
    let mut s = server.connect().await.unwrap();
    invoke(&s, 1, A, json!({}));
    let a_pid = action_response(&mut s, 1).await.unwrap();
    invoke(&s, 2, B, json!({}));
    let b_pid = action_response(&mut s, 2).await.unwrap();
    let before = server.plugins().await.unwrap();
    bump(root, "a");
    edit_manifest(root, "b", |m| {
        m["publicFunctions"] = json!(["ops:doesNotExist"])
    });
    let error = server
        .reload_plugin("b".into())
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("is not a backend function"), "{error}");
    assert_eq!(server.plugins().await.unwrap(), before);
    invoke(&s, 3, A, json!({}));
    assert_eq!(action_response(&mut s, 3).await.unwrap(), a_pid);
    invoke(&s, 4, B, json!({}));
    assert_eq!(action_response(&mut s, 4).await.unwrap(), b_pid);
    drop(s);
    server.close().await.unwrap();
}

async fn subscription(session: &mut server::Session) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match session.recv().await.unwrap().unwrap() {
                Event::PluginChanged { .. } => {}
                Event::Subscription { id: 10, result } => return result,
                other => panic!("{other:?}"),
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_missing_on_reload_errors_and_recovers_on_same_subscription() {
    let installation = installation();
    let root = &installation.path().join("plugins");
    let server = start(root).await;
    let before = server.plugins().await.unwrap();
    let mut s = server.connect().await.unwrap();
    s.subscribe(10, "a/ops:list", json!({})).unwrap();
    assert_eq!(subscription(&mut s).await.unwrap(), json!([]));
    std::fs::rename(root.join("a"), root.join(".saved-a")).unwrap();
    server.reload_plugin("a".into()).await.unwrap();
    let error = subscription(&mut s).await.unwrap_err();
    assert_eq!(
        error,
        "Subscription query is not registered in this plugin generation"
    );
    std::fs::rename(root.join(".saved-a"), root.join("a")).unwrap();
    assert_eq!(server.reload_plugin("a".into()).await.unwrap(), before);
    assert_eq!(subscription(&mut s).await.unwrap(), json!([]));
    drop(s);
    server.close().await.unwrap();
}
