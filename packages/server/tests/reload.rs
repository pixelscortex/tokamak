use engine::{Pool, PoolConfig};
use serde_json::{Value, json};
use server::{
    Event, Server,
    data::{DataSpace, Database, Id, Storage, Table, json_object},
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
    assert!(error.contains("is not a server function"), "{error}");
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

fn with_index(root: &Path, id: &str, unique: bool) {
    let schema = json!({"tables":{"records":{
        "description":{"kind":"object","fields":{"key":{"kind":"string"}}},
        "indexes":[{"name":"by_key","fields":["key"],"unique":unique}]
    }}});
    let source = std::fs::read_to_string(root.join(id).join("bundle.js")).unwrap();
    let empty_schema = "schemaMetadata(null)";
    assert_eq!(source.matches(empty_schema).count(), 1);
    write_asset(
        root,
        id,
        "bundle.js",
        &source.replace(empty_schema, &schema.to_string()),
    );
}

fn copy_worker(root: &Path, id: &str) {
    std::fs::create_dir(root.join(id)).unwrap();
    for name in [
        "manifest.json",
        "bundle.js",
        "bundle.js.map",
        "api.ts",
        "public.d.ts",
    ] {
        std::fs::copy(root.join("b").join(name), root.join(id).join(name)).unwrap();
    }
    edit_manifest(root, id, |m| m["plugin"]["id"] = json!(id));
    install_worker(root, id);
}

fn records(id: &str) -> Table {
    DataSpace::plugin(id)
        .unwrap()
        .table(&Table::new("records").unwrap())
        .unwrap()
}

async fn seed_rows(database: &Database, id: &str, keys: &[&str]) -> Vec<Id> {
    let mut tx = database.begin().await.unwrap();
    let mut ids = Vec::new();
    for key in keys {
        ids.push(
            tx.insert(&records(id), json_object(&json!({"key": key})).unwrap())
                .await
                .unwrap(),
        );
    }
    tx.commit().await.unwrap();
    ids
}

async fn load_with_database(root: &Path, database: Database) -> Server {
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    Server::load_plugins(database, pool, root).await.unwrap()
}

async fn worker_pid(session: &mut server::Session, id: u64, name: &str) -> u64 {
    invoke(session, id, name, json!({}));
    action_response(session, id)
        .await
        .unwrap()
        .as_u64()
        .unwrap()
}

fn plugin_entry<'a>(catalog: &'a Value, id: &str) -> &'a Value {
    catalog["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["plugin"]["id"] == id)
        .unwrap_or(&Value::Null)
}

async fn next_event(session: &mut server::Session) -> Event {
    tokio::time::timeout(Duration::from_secs(5), session.recv())
        .await
        .expect("session did not receive the reload event or action response")
        .unwrap()
        .unwrap()
}

async fn assert_changed(session: &mut server::Session, expected: &[&str], result: &Value) {
    let Event::PluginChanged { plugins, catalog } = next_event(session).await else {
        panic!("expected a plugin change event");
    };
    assert_eq!(plugins, expected);
    assert_eq!(catalog["revision"], result["revision"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changed_worker_swaps_while_skipped_index_is_retried() {
    let installation = installation();
    let root = &installation.path().join("plugins");
    for id in ["a", "b"] {
        install_worker(root, id);
    }
    copy_worker(root, "indexed");
    with_index(root, "indexed", true);
    let db = Database::open(Storage::Memory).await.unwrap();
    let rows = seed_rows(&db, "indexed", &["old-collision", "old-collision"]).await;
    let mut edit = db.begin().await.unwrap();
    let server = load_with_database(root, db).await;
    let before = server.plugins().await.unwrap();
    assert!(plugin_entry(&before, "indexed").is_null());
    for row in rows {
        edit.patch(&row, json_object(&json!({"key":"new-collision"})).unwrap())
            .await
            .unwrap();
    }
    edit.commit().await.unwrap();

    let mut session = server.connect().await.unwrap();
    let a_pid = worker_pid(&mut session, 1, A).await;
    let b_pid = worker_pid(&mut session, 2, B).await;
    invoke(&session, 3, B, json!({"hold":"survives"}));
    started(root, "b", "survives").await;

    bump(root, "a");
    let result = server.reload_plugin("a".into()).await.unwrap();
    assert_changed(&mut session, &["a"], &result).await;
    assert_eq!(plugin_entry(&result, "a")["plugin"]["version"], "1.0.1");
    assert_eq!(plugin_entry(&result, "b"), plugin_entry(&before, "b"));
    assert!(plugin_entry(&result, "indexed").is_null());
    let reason = result["skipped"]["indexed"].as_str().unwrap();
    assert!(
        reason.contains("by_key") && reason.contains("new-collision"),
        "{reason}"
    );

    release(root, "b", "survives");
    assert_eq!(action_response(&mut session, 3).await, Ok(json!(b_pid)));
    assert_eq!(worker_pid(&mut session, 4, B).await, b_pid);
    assert_ne!(worker_pid(&mut session, 5, A).await, a_pid);
    drop(session);
    server.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repaired_index_restores_only_skipped_plugin_and_required_dependent() {
    let installation = installation();
    let root = &installation.path().join("plugins");
    for id in ["a", "b"] {
        install_worker(root, id);
    }
    for id in ["indexed", "dependent"] {
        copy_worker(root, id);
    }
    edit_manifest(root, "dependent", |m| {
        m["plugin"]["depends"] = json!({"indexed":"*"})
    });
    with_index(root, "indexed", true);

    let db = Database::open(Storage::Memory).await.unwrap();
    let rows = seed_rows(&db, "indexed", &["duplicate", "duplicate"]).await;
    let mut repair = db.begin().await.unwrap();
    let server = load_with_database(root, db).await;
    let before = server.plugins().await.unwrap();
    for id in ["indexed", "dependent"] {
        assert!(plugin_entry(&before, id).is_null());
    }

    let mut session = server.connect().await.unwrap();
    let a_pid = worker_pid(&mut session, 1, A).await;
    let b_pid = worker_pid(&mut session, 2, B).await;
    repair
        .patch(&rows[1], json_object(&json!({"key":"repaired"})).unwrap())
        .await
        .unwrap();
    repair.commit().await.unwrap();

    // No file is rewritten. Reloading the skipped id itself retries both builds.
    let result = server.reload_plugin("indexed".into()).await.unwrap();
    assert_changed(&mut session, &["dependent", "indexed"], &result).await;
    assert_eq!(result["skipped"], json!({}));
    let indexed = worker_pid(&mut session, 3, "indexed/ops:callerAction").await;
    let dependent = worker_pid(&mut session, 4, "dependent/ops:callerAction").await;
    assert_ne!(indexed, dependent);
    assert_eq!(worker_pid(&mut session, 5, A).await, a_pid);
    assert_eq!(worker_pid(&mut session, 6, B).await, b_pid);
    drop(session);
    server.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_backfill_or_readiness_keeps_live_builds_and_indexes() {
    let installation = installation();
    let root = &installation.path().join("plugins");
    for id in ["a", "b"] {
        install_worker(root, id);
    }
    let storage = Storage::Disk(installation.path().join("store"));
    let db = Database::open(storage.clone()).await.unwrap();
    seed_rows(&db, "a", &["duplicate", "duplicate"]).await;
    seed_rows(&db, "b", &["kept"]).await;
    let server = load_with_database(root, db).await;
    let before = server.plugins().await.unwrap();
    let mut session = server.connect().await.unwrap();
    let a_pid = worker_pid(&mut session, 1, A).await;
    let b_pid = worker_pid(&mut session, 2, B).await;
    invoke(&session, 3, B, json!({"hold":"survives"}));
    started(root, "b", "survives").await;

    // Dependencies load first. Stage B's valid index, then fail A's backfill.
    with_index(root, "b", false);
    with_index(root, "a", true);
    let err = server
        .reload_plugin("a".into())
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("by_key") && err.contains("duplicate"), "{err}");
    assert_eq!(server.plugins().await.unwrap(), before);

    // Allow both indexes to be staged, then make A fail the readiness probe.
    write_asset(root, "a", "bundle.js", &artifacts()["a/bundle.js"]);
    with_index(root, "a", false);
    write_asset(root, "a", "worker.js", "export const broken = ;");
    let err = server
        .reload_plugin("a".into())
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("Plugin a worker failed readiness"), "{err}");
    assert_eq!(server.plugins().await.unwrap(), before);
    release(root, "b", "survives");
    let Event::Response { id: 3, result } = next_event(&mut session).await else {
        panic!("refused reload published a plugin change");
    };
    assert_eq!(result, Ok(json!(b_pid)));
    assert_eq!(worker_pid(&mut session, 4, A).await, a_pid);
    assert_eq!(worker_pid(&mut session, 5, B).await, b_pid);

    drop(session);
    server.close().await.unwrap();
    let mut db = Database::open(storage).await.unwrap();
    for id in ["a", "b"] {
        let mut tx = db.read_only().await.unwrap();
        let err = tx
            .query(&records(id))
            .with_index("by_key")
            .collect()
            .await
            .unwrap_err();
        assert!(err.to_string().contains("does not exist"), "{err}");
        tx.rollback().await.unwrap();
    }
    db.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn index_only_build_changes_revision_and_restarts_only_its_worker() {
    let installation = installation();
    let root = &installation.path().join("plugins");
    for id in ["a", "b"] {
        install_worker(root, id);
    }
    let storage = Storage::Disk(installation.path().join("store"));
    let db = Database::open(storage.clone()).await.unwrap();
    let rows = seed_rows(&db, "a", &["kept"]).await;
    let server = load_with_database(root, db).await;
    let before = server.plugins().await.unwrap();
    let mut session = server.connect().await.unwrap();
    let a_pid = worker_pid(&mut session, 1, A).await;
    let b_pid = worker_pid(&mut session, 2, B).await;

    with_index(root, "a", false);
    let result = server.reload_plugin("a".into()).await.unwrap();
    assert_changed(&mut session, &["a"], &result).await;
    let (old, new) = (plugin_entry(&before, "a"), plugin_entry(&result, "a"));
    assert_eq!(old["plugin"], new["plugin"]);
    assert_eq!(old["hashes"]["worker.js"], new["hashes"]["worker.js"]);
    assert_ne!(old["hashes"]["bundle.js"], new["hashes"]["bundle.js"]);
    assert_ne!(old["revision"], new["revision"]);
    assert_ne!(worker_pid(&mut session, 3, A).await, a_pid);
    assert_eq!(worker_pid(&mut session, 4, B).await, b_pid);

    drop(session);
    server.close().await.unwrap();
    let mut db = Database::open(storage).await.unwrap();
    let mut tx = db.read_only().await.unwrap();
    assert_eq!(
        tx.query(&records("a"))
            .with_index("by_key")
            .collect()
            .await
            .unwrap(),
        vec![tx.get(&rows[0]).await.unwrap().unwrap()]
    );
    tx.rollback().await.unwrap();
    db.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_op_reload_preserves_running_actions_and_worker_pids() {
    let installation = installation();
    let root = &installation.path().join("plugins");
    for id in ["a", "b"] {
        install_worker(root, id);
    }
    let server = start(root).await;
    let before = server.plugins().await.unwrap();
    let mut session = server.connect().await.unwrap();
    let a_pid = worker_pid(&mut session, 1, A).await;
    let b_pid = worker_pid(&mut session, 2, B).await;
    invoke(&session, 3, A, json!({"hold":"a"}));
    invoke(&session, 4, B, json!({"hold":"b"}));
    started(root, "a", "a").await;
    started(root, "b", "b").await;

    let result = server.reload_plugin("a".into()).await.unwrap();
    assert_eq!(result, before);
    // Release one at a time and check for an action response before any event.
    for (id, hold, request, pid) in [("a", "a", 3, a_pid), ("b", "b", 4, b_pid)] {
        release(root, id, hold);
        let Event::Response { id, result } = next_event(&mut session).await else {
            panic!("no-op reload published a plugin change");
        };
        assert_eq!((id, result), (request, Ok(json!(pid))));
    }
    assert_eq!(worker_pid(&mut session, 5, A).await, a_pid);
    assert_eq!(worker_pid(&mut session, 6, B).await, b_pid);
    drop(session);
    server.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_dependent_keeps_old_build_when_required_plugin_is_skipped() {
    let tmp = installation();
    let root = &tmp.path().join("plugins");
    for id in ["a", "b"] {
        install_worker(root, id);
    }
    copy_worker(root, "indexed");
    with_index(root, "indexed", true);
    let db = Database::open(Storage::Memory).await.unwrap();
    seed_rows(&db, "indexed", &["dup", "dup"]).await;
    let server = load_with_database(root, db).await;
    let before = server.plugins().await.unwrap();
    assert!(plugin_entry(&before, "indexed").is_null());
    let mut session = server.connect().await.unwrap();
    let a_pid = worker_pid(&mut session, 1, A).await;
    let b_pid = worker_pid(&mut session, 2, B).await;
    invoke(&session, 3, A, json!({"hold":"survives"}));
    started(root, "a", "survives").await;

    edit_manifest(root, "a", |m| {
        m["plugin"]["depends"]["indexed"] = json!("*")
    });
    let result = server.reload_plugin("a".into()).await;
    let after = server.plugins().await.unwrap();
    release(root, "a", "survives");
    let action = action_response(&mut session, 3).await;
    let Err(error) = result else {
        panic!(
            "reload accepted; active plugin disappeared: {}, action: {action:?}",
            plugin_entry(&after, "a").is_null(),
        );
    };
    let error = error.to_string();
    assert!(
        error.contains("active plugin a") && error.contains("requires indexed"),
        "{error}"
    );
    assert_eq!(after, before);
    assert_eq!(action, Ok(json!(a_pid)));
    assert_eq!(worker_pid(&mut session, 4, A).await, a_pid);
    assert_eq!(worker_pid(&mut session, 5, B).await, b_pid);
    drop(session);
    server.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_artifact_is_isolated_only_for_an_identified_skipped_plugin() {
    let tmp = installation();
    let root = &tmp.path().join("plugins");
    for id in ["indexed", "dependent"] {
        copy_worker(root, id);
    }
    edit_manifest(root, "dependent", |m| {
        m["plugin"]["depends"] = json!({"indexed":"*"})
    });
    with_index(root, "indexed", true);
    let db = Database::open(Storage::Memory).await.unwrap();
    seed_rows(&db, "indexed", &["dup", "dup"]).await;
    let server = load_with_database(root, db).await;

    std::fs::write(root.join("indexed/worker.js"), "export const partial = ;").unwrap();
    bump(root, "a");
    let result = server
        .reload_plugin("a".into())
        .await
        .expect("a bad artifact for a skipped plugin must not block A");
    let reason = result["skipped"]["indexed"].as_str().unwrap();
    assert!(
        reason.contains("Artifact hash mismatch for worker.js"),
        "{reason}"
    );
    assert_eq!(
        result["skipped"]["dependent"],
        "requires indexed, which did not load"
    );
    let active = server.plugins().await.unwrap();
    assert_eq!(plugin_entry(&active, "a")["plugin"]["version"], "1.0.1");
    for id in ["indexed", "dependent"] {
        assert!(plugin_entry(&active, id).is_null());
    }

    // The same verification failure for an active plugin is fatal.
    let bundle = root.join("b/bundle.js");
    let original = std::fs::read(&bundle).unwrap();
    std::fs::write(&bundle, "export const partial = ;").unwrap();
    let error = server
        .reload_plugin("a".into())
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("Artifact hash mismatch for bundle.js"),
        "{error}"
    );
    assert_eq!(server.plugins().await.unwrap(), active);
    std::fs::write(&bundle, original).unwrap();

    // A directory name alone cannot identify a plugin to skip.
    std::fs::write(root.join("indexed/manifest.json"), "{").unwrap();
    let error = server
        .reload_plugin("a".into())
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("Invalid plugin manifest"), "{error}");
    assert_eq!(server.plugins().await.unwrap(), active);
    server.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skipped_only_edit_preserves_active_catalog_and_provider_order() {
    let tmp = installation();
    let root = &tmp.path().join("plugins");
    install_worker(root, "a");
    edit_manifest(root, "a", |m| m["plugin"]["consumes"] = json!(["example"]));
    for id in ["c", "d", "z"] {
        copy_worker(root, id);
    }
    for id in ["d", "z"] {
        edit_manifest(root, id, |m| m["plugin"]["provides"] = json!(["example"]));
    }
    edit_manifest(root, "c", |m| m["plugin"]["depends"] = json!({"z":"*"}));
    with_index(root, "c", true);
    let db = Database::open(Storage::Memory).await.unwrap();
    seed_rows(&db, "c", &["dup", "dup"]).await;
    let server = load_with_database(root, db).await;
    let before = server.plugins().await.unwrap();
    let mut session = server.connect().await.unwrap();

    edit_manifest(root, "c", |m| m["plugin"]["depends"] = json!({"d":"*"}));
    let after = server.reload_plugin("c".into()).await.unwrap();
    assert_eq!(after["revision"], before["revision"]);
    assert_eq!(after["plugins"], before["plugins"]);
    let order: Vec<_> = after["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["plugin"]["id"].as_str().unwrap())
        .collect();
    assert_eq!(order, ["b", "a", "d", "z"]);

    invoke(
        &session,
        1,
        A,
        json!({"hold":"providers", "op":"plugin.providers", "payload":{"interface":"example"}}),
    );
    started(root, "a", "providers").await;
    release(root, "a", "providers");
    let Event::Response { id: 1, result } = next_event(&mut session).await else {
        panic!("a skipped-only edit published a catalog change");
    };
    assert_eq!(result, Ok(json!(["d", "z"])));

    bump(root, "d");
    let changed = server.reload_plugin("d".into()).await.unwrap();
    assert_ne!(changed["revision"], after["revision"]);
    assert_changed(&mut session, &["d"], &changed).await;
    drop(session);
    server.close().await.unwrap();
}
