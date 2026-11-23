//! TKM-84 / TKM-89 acceptance: plugin schemas declared with the SDK reach the
//! server through the public builder, install indexes in the plugin's own data
//! space, and serve indexed JS queries from real QuickJS handlers.
//!
//! Fixture sources live in `fixtures/indexes/`. Every build copies them into an
//! owned directory under `target/`, optionally edits exact schema lines, and
//! runs the public builder, so changed generations are real artifacts rather
//! than hand-edited metadata. Expected query results are computed in Rust from
//! the rows the test inserted, never from another index read.
use engine::{Bundle, Pool, PoolConfig};
use serde_json::{Value, json};
use server::{
    Event, Server, Session,
    data::{DataSpace, Database, Id, Storage, Table, json_object},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

fn workspace() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

/// One generation of a fixture plugin: which source, which identity, and exact
/// line replacements in its schema. Each replacement must match, so a fixture
/// edit cannot silently turn a variant back into the base schema.
struct Variant {
    key: &'static str,
    fixture: &'static str,
    id: &'static str,
    version: &'static str,
    edits: &'static [(&'static str, &'static str)],
}

const ALPHA: Variant = Variant {
    key: "alpha",
    fixture: "alpha",
    id: "alpha",
    version: "1.0.0",
    edits: &[],
};
// Same declarations under a new version: forces a real new generation (and a
// grant write) whose schema is applied again to tables that already have rows.
const ALPHA_SAME_NEXT: Variant = Variant {
    key: "alpha-same-next",
    fixture: "alpha",
    id: "alpha",
    version: "1.0.1",
    edits: &[],
};
const ALPHA_ADDED: Variant = Variant {
    key: "alpha-added",
    fixture: "alpha",
    id: "alpha",
    version: "1.1.0",
    edits: &[
        (
            "  notes: defineTable(",
            "  tags: defineTable({ label: v.string() }).index(\"by_label\", [\"label\"]),\n  notes: defineTable(",
        ),
        (
            "    .unique(\"by_owner_text\", [\"owner\", \"text\"]),",
            "    .unique(\"by_owner_text\", [\"owner\", \"text\"])\n    .index(\"by_done\", [\"done\"]),",
        ),
    ],
};
const ALPHA_REBUILT: Variant = Variant {
    key: "alpha-rebuilt",
    fixture: "alpha",
    id: "alpha",
    version: "1.2.0",
    edits: &[
        (
            r#"unique("by_owner_text", ["owner", "text"])"#,
            r#"index("by_owner_text", ["text"])"#,
        ),
        (r#".index("by_topic", ["topic"])"#, ""),
    ],
};
const ALPHA_DUPLICATES: Variant = Variant {
    key: "alpha-duplicates",
    fixture: "alpha",
    id: "alpha",
    version: "1.1.0",
    edits: &[
        ALPHA_ADDED.edits[0],
        (r#"["owner", "created"]"#, r#"["owner", "created", "text"]"#),
        (
            r#"unique("by_owner_text", ["owner", "text"])"#,
            r#"unique("by_owner_only", ["owner"])"#,
        ),
        (r#".index("by_topic", ["topic"])"#, ""),
    ],
};
const BETA: Variant = Variant {
    key: "beta",
    fixture: "beta",
    id: "beta",
    version: "1.0.0",
    edits: &[],
};
const BETA_BY_OWNER: Variant = Variant {
    key: "beta-by-owner",
    version: "1.0.1",
    edits: &[(
        r#"index("by_owner_created", ["text"])"#,
        r#"index("by_owner_created", ["owner"])"#,
    )],
    ..BETA
};

/// Builds each variant once per test process; returns its `dist` directory.
fn artifact(variant: &Variant) -> PathBuf {
    static BUILT: Mutex<Option<HashMap<&'static str, PathBuf>>> = Mutex::new(None);
    let mut built = BUILT.lock().unwrap_or_else(|e| e.into_inner());
    let built = built.get_or_insert_with(HashMap::new);
    if let Some(path) = built.get(variant.key) {
        return path.clone();
    }
    let root = workspace();
    let source = root
        .join("packages/server/tests/fixtures/indexes")
        .join(variant.fixture);
    let target = root
        .join("packages/server/target/schema-index-builds")
        .join(format!("{}-{}", std::process::id(), variant.key));
    let _ = std::fs::remove_dir_all(&target);
    std::fs::create_dir_all(target.join("src/server")).unwrap();
    std::fs::create_dir_all(target.join("node_modules/@tokamak")).unwrap();
    std::os::unix::fs::symlink(
        root.join("packages/sdk"),
        target.join("node_modules/@tokamak/sdk"),
    )
    .unwrap();
    for entry in std::fs::read_dir(source.join("src/server")).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().into_string().unwrap();
        let mut text = std::fs::read_to_string(entry.path()).unwrap();
        if name == "schema.ts" {
            for (from, to) in variant.edits {
                assert!(
                    text.contains(from),
                    "{}: schema edit target missing: {from}",
                    variant.key
                );
                text = text.replace(from, to);
            }
        }
        std::fs::write(target.join("src/server").join(name), text).unwrap();
    }
    std::fs::write(
        target.join("package.json"),
        json!({"name":format!("schema-index-{}", variant.id),"version":variant.version,"private":true,"type":"module"}).to_string(),
    )
    .unwrap();
    std::fs::write(
        target.join("src/server/tsconfig.json"),
        json!({
            "extends": root.join("tsconfig.json")
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        target.join("vite.config.ts"),
        format!(
            "import {{tokamak}} from {}; export default {{plugins:[tokamak({})]}};",
            json!(root.join("packages/build/src/vite.ts")),
            json!({"ui":false,"plugin":{"id":variant.id,"version":variant.version}})
        ),
    )
    .unwrap();
    let output = std::process::Command::new("proto")
        .args(["run", "bun", "--", "packages/build/src/build.ts"])
        .arg(&target)
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}: build failed\n{}\n{}",
        variant.key,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let dist = target.join("dist");
    built.insert(variant.key, dist.clone());
    dist
}

/// A test-owned plugin installation root plus (optionally) disk storage.
struct Installation {
    root: PathBuf,
    disk: bool,
}
impl Installation {
    fn new(disk: bool) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
            "target/schema-index-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        Self { root, disk }
    }
    fn plugins(&self) -> PathBuf {
        self.root.join("plugins")
    }
    /// Replaces the installed files for one plugin id with a built artifact.
    fn install(&self, variant: &Variant) {
        let dist = artifact(variant);
        let target = self.plugins().join(variant.id);
        let _ = std::fs::remove_dir_all(&target);
        std::fs::create_dir(&target).unwrap();
        for file in [
            "manifest.json",
            "bundle.js",
            "bundle.js.map",
            "api.ts",
            "transactions.js",
            "transactions.js.map",
        ] {
            std::fs::copy(dist.join(file), target.join(file)).unwrap();
        }
    }
    /// Rewrites an installed bundle (and its manifest hash) the way a bundle
    /// built by an older SDK or a non-SDK tool would differ.
    fn rewrite_bundle(&self, id: &str, from: &str, to: &str) {
        let root = self.plugins().join(id);
        let manifest_path = root.join("manifest.json");
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        for name in ["bundle.js", "transactions.js"] {
            let path = root.join(name);
            let source = std::fs::read_to_string(&path).unwrap();
            assert!(
                source.contains(from),
                "{name}: bundle rewrite target missing: {from}"
            );
            let changed = source.replace(from, to);
            std::fs::write(&path, &changed).unwrap();
            manifest["hashes"][name] = format!("{:x}", Sha256::digest(changed.as_bytes())).into();
        }
        std::fs::write(manifest_path, manifest.to_string()).unwrap();
    }
    fn edit_manifest(&self, id: &str, edit: impl FnOnce(&mut Value)) {
        let path = self.plugins().join(id).join("manifest.json");
        let mut manifest = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        edit(&mut manifest);
        std::fs::write(path, manifest.to_string()).unwrap();
    }
    fn storage(&self) -> Storage {
        if self.disk {
            Storage::Disk(self.root.join("store"))
        } else {
            Storage::Memory
        }
    }
    async fn load(&self) -> Result<Server, String> {
        let database = Database::open(self.storage()).await.unwrap();
        let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
        Server::load_plugins(database, pool, &self.plugins())
            .await
            .map_err(|e| e.to_string())
    }
}
impl Drop for Installation {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

const BUNDLE_SCHEMA: &str = "var schema = schemaMetadata(schema_default);";

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

fn run<F: std::future::Future<Output = ()>>(scenario: F) {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(scenario);
}

macro_rules! backends {
    ($memory:ident, $disk:ident, $behavior:ident) => {
        #[test]
        fn $memory() {
            run($behavior(false));
        }
        #[test]
        fn $disk() {
            run($behavior(true));
        }
    };
}

async fn next(session: &mut Session) -> Event {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = session.recv().await.unwrap().unwrap();
            if !matches!(event, Event::PluginChanged { .. }) {
                return event;
            }
        }
    })
    .await
    .expect("timed out waiting for a server event")
}

struct Client {
    session: Session,
    next_id: u64,
}
impl Client {
    async fn connect(server: &Server) -> Self {
        Self {
            session: server.connect().await.unwrap(),
            next_id: 1,
        }
    }
    async fn call(&mut self, name: &str, args: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.session.call(id, name, args).unwrap();
        match next(&mut self.session).await {
            Event::Response { id: actual, result } => {
                assert_eq!(actual, id);
                result
            }
            event => panic!("unexpected {event:?}"),
        }
    }
    async fn ok(&mut self, name: &str, args: Value) -> Value {
        self.call(name, args)
            .await
            .unwrap_or_else(|e| panic!("{name} failed: {e}"))
    }
    async fn err(&mut self, name: &str, args: Value) -> String {
        match self.call(name, args).await {
            Ok(value) => panic!("{name} unexpectedly succeeded with {value}"),
            Err(error) => error,
        }
    }
}

fn todo(owner: &str, text: &str, created: i64) -> Value {
    json!({"owner":owner,"text":text,"done":false,"created":created})
}

fn ids(rows: &Value) -> Vec<String> {
    rows.as_array()
        .unwrap()
        .iter()
        .map(|row| row["_id"].as_str().unwrap().to_owned())
        .collect()
}

fn texts(rows: &Value) -> Vec<String> {
    let mut texts: Vec<_> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["text"].as_str().unwrap().to_owned())
        .collect();
    texts.sort();
    texts
}

// ---------------------------------------------------------------------------
// 2. Schema reaches the server and indexes are installed
// ---------------------------------------------------------------------------

// The declared registry must arrive with the plugin (not a build-time copy),
// keyed by plugin id, and every declared index must exist in storage at load.
#[test]
fn declared_schema_reaches_the_server_and_its_indexes_are_installed_at_load() {
    run(async {
        let installation = Installation::new(false);
        installation.install(&ALPHA);
        let server = installation.load().await.unwrap();
        let metadata = server.plugins().await.unwrap();
        let tables = &metadata["schema"]["alpha"]["tables"];
        assert_eq!(
            tables["todos"]["indexes"],
            json!([
                {"name":"by_owner_created","fields":["owner","created"],"unique":false},
                {"name":"by_owner_text","fields":["owner","text"],"unique":true},
            ]),
            "{metadata}"
        );
        assert_eq!(
            tables["notes"]["indexes"],
            json!([{"name":"by_topic","fields":["topic"],"unique":false}])
        );
        assert_eq!(
            tables["todos"]["description"]["fields"]["created"],
            json!({"kind":"number"})
        );

        let mut client = Client::connect(&server).await;
        for (table, index) in [
            ("todos", "by_owner_created"),
            ("todos", "by_owner_text"),
            ("notes", "by_topic"),
        ] {
            assert_eq!(
                client
                    .ok("alpha/todos:probe", json!({"table":table,"index":index}))
                    .await,
                json!([])
            );
        }
        // The probe is a real control: an undeclared name is reported missing.
        let missing = client
            .err(
                "alpha/todos:probe",
                json!({"table":"todos","index":"by_done"}),
            )
            .await;
        assert!(missing.contains("does not exist"), "{missing}");
        drop(client);
        server.close().await.unwrap();
    });
}

// ---------------------------------------------------------------------------
// 5. Indexed query semantics through real JS
// ---------------------------------------------------------------------------

async fn indexed_queries_return_exactly_the_matching_rows_in_index_order(disk: bool) {
    let installation = Installation::new(disk);
    installation.install(&ALPHA);
    let server = installation.load().await.unwrap();
    let mut client = Client::connect(&server).await;
    // Duplicate `created` values make the ID tiebreak observable; bob's rows
    // fall inside every range and must never leak into ann's results.
    let mut rows: Vec<(String, String, i64)> = Vec::new();
    for (owner, created) in [
        ("ann", 15),
        ("bob", 10),
        ("ann", 10),
        ("ann", 25),
        ("ann", 5),
        ("bob", 20),
        ("ann", 10),
        ("ann", 20),
    ] {
        let text = format!("{owner}-{created}-{}", rows.len());
        let id = client
            .ok("alpha/todos:add", todo(owner, &text, created))
            .await;
        rows.push((id.as_str().unwrap().to_owned(), owner.to_owned(), created));
    }
    let lowers = [None, Some(("gt", 10)), Some(("gte", 10))];
    let uppers = [None, Some(("lt", 20)), Some(("lte", 20))];
    for lower in lowers {
        for upper in uppers {
            for desc in [false, true] {
                for limit in [None, Some(2)] {
                    assert_index_range_case(&mut client, &rows, (lower, upper, desc, limit)).await;
                }
            }
        }
    }
    // An upper bound alone, and an empty (inverted) range, and limit zero.
    assert_eq!(
        ids(&client
            .ok(
                "alpha/todos:range",
                json!({"owner":"ann","upper":{"op":"lt","value":10},"order":"asc"})
            )
            .await),
        expected_index_rows(&rows, "ann", None, Some(("lt", 10)), false, None)
    );
    assert_eq!(
        client
            .ok(
                "alpha/todos:range",
                json!({"owner":"ann","lower":{"op":"gt","value":20},"upper":{"op":"lt","value":10},"order":"asc"})
            )
            .await,
        json!([])
    );
    assert_eq!(
        client
            .ok(
                "alpha/todos:range",
                json!({"owner":"ann","order":"asc","limit":0})
            )
            .await,
        json!([])
    );
    assert_eq!(
        client
            .ok("alpha/todos:range", json!({"owner":"nobody","order":"asc"}))
            .await,
        json!([])
    );

    // The documented example: eq owner, gt created, desc, take 20.
    assert_eq!(
        ids(&client
            .ok("alpha/todos:recent", json!({"owner":"bob","since":0}))
            .await),
        expected_index_rows(&rows, "bob", Some(("gt", 0)), None, true, None)
    );

    assert_full_index_scan(&mut client, &rows).await;
    drop(client);
    server.close().await.unwrap();
}
backends!(
    indexed_queries_return_exactly_the_matching_rows_in_index_order_memory,
    indexed_queries_return_exactly_the_matching_rows_in_index_order_disk,
    indexed_queries_return_exactly_the_matching_rows_in_index_order
);

// A bundle that bypasses the SDK builder can send any db.query payload. The
// host must enforce the same index contract, not trust SDK-side validation.
#[test]
fn server_rejects_invalid_index_query_payloads_sent_without_the_sdk() {
    run(async {
        let installation = Installation::new(false);
        installation.install(&ALPHA);
        let server = installation.load().await.unwrap();
        let mut client = Client::connect(&server).await;
        client.ok("alpha/todos:add", todo("ann", "a", 10)).await;
        let query = |index: Value, wher: Value| json!({"payload":{"table":"todos","where":wher,"order":"asc","limit":null,"index":index}});
        let eq = |field: &str, value: Value| json!({"field":field,"value":value});
        let bound = |field: &str, op: &str, value: Value| json!({"field":field,"operator":op,"value":value});

        // Sanity: a well-formed raw payload succeeds, so rejections below are
        // caused by the payload, not by the raw function itself.
        let valid = client
            .ok(
                "alpha/todos:raw",
                query(
                    json!({"name":"by_owner_created","eq":[eq("owner",json!("ann"))],"range":[bound("created","gte",json!(10))]}),
                    json!([]),
                ),
            )
            .await;
        assert_eq!(valid.as_array().unwrap().len(), 1);

        let cases = invalid_index_payloads();
        for (case, index, wher, message) in cases {
            let error = client.err("alpha/todos:raw", query(index, wher)).await;
            assert!(error.contains(message), "{case}: {error}");
        }
        // Rejections are per call: the session and data remain usable.
        assert_eq!(
            client
                .ok("alpha/todos:unindexed", json!({"owner":"ann"}))
                .await
                .as_array()
                .unwrap()
                .len(),
            1
        );
        drop(client);
        server.close().await.unwrap();
    });
}

// ---------------------------------------------------------------------------
// 6. Unique indexes
// ---------------------------------------------------------------------------

async fn unique_index_rejects_duplicates_and_the_failed_call_commits_nothing(disk: bool) {
    let installation = Installation::new(disk);
    installation.install(&ALPHA);
    let server = installation.load().await.unwrap();
    let mut client = Client::connect(&server).await;
    let a = client.ok("alpha/todos:add", todo("ann", "a", 1)).await;
    let b = client.ok("alpha/todos:add", todo("ann", "b", 2)).await;
    let c = client.ok("alpha/todos:add", todo("ann", "c", 3)).await;
    // Uniqueness is over the whole (owner, text) tuple, not each field.
    client.ok("alpha/todos:add", todo("bob", "a", 4)).await;
    let snapshot = client.ok("alpha/todos:scan", json!({"order":"asc"})).await;

    let error = client.err("alpha/todos:add", todo("ann", "a", 9)).await;
    assert!(error.contains("by_owner_text"), "{error}");

    // The host error is a JS exception the handler can catch; its first insert
    // in the same call must not survive the failed invocation.
    let error = client
        .err(
            "alpha/todos:addPairRethrow",
            json!({"first":todo("ann","new-1",5),"second":todo("ann","a",6)}),
        )
        .await;
    assert!(
        error.contains("caught in JS") && error.contains("by_owner_text"),
        "{error}"
    );

    // Documented: a unique violation aborts the invocation even when JS
    // swallows it, so the earlier insert must not commit either.
    let swallowed = client
        .call(
            "alpha/todos:addPairSwallow",
            json!({"first":todo("ann","new-2",7),"second":todo("ann","b",8)}),
        )
        .await;
    assert!(
        swallowed.is_err(),
        "swallowed unique violation committed: {swallowed:?}"
    );

    // patch and replace into an existing (owner, text) are rejected too, and
    // the preceding patch of another row in the same call is rolled back.
    let error = client
        .err(
            "alpha/todos:patchText",
            json!({"touch":b,"id":c,"text":"a"}),
        )
        .await;
    assert!(error.contains("by_owner_text"), "{error}");
    let error = client
        .err(
            "alpha/todos:replaceText",
            json!({"touch":b,"id":c,"value":todo("ann","a",3)}),
        )
        .await;
    assert!(error.contains("by_owner_text"), "{error}");

    assert_eq!(
        client.ok("alpha/todos:scan", json!({"order":"asc"})).await,
        snapshot
    );
    // Rewriting a row to its own unique value is not a duplicate.
    client
        .ok(
            "alpha/todos:patchText",
            json!({"touch":b,"id":a,"text":"a"}),
        )
        .await;
    drop(client);
    server.close().await.unwrap();
}
backends!(
    unique_index_rejects_duplicates_and_the_failed_call_commits_nothing_memory,
    unique_index_rejects_duplicates_and_the_failed_call_commits_nothing_disk,
    unique_index_rejects_duplicates_and_the_failed_call_commits_nothing
);

// ---------------------------------------------------------------------------
// 3. Identical reloads are no-ops
// ---------------------------------------------------------------------------

async fn reloading_identical_definitions_is_a_no_op_and_rows_survive(disk: bool) {
    let installation = Installation::new(disk);
    installation.install(&ALPHA);
    let server = installation.load().await.unwrap();
    let mut client = Client::connect(&server).await;
    client.ok("alpha/todos:add", todo("ann", "a", 10)).await;
    client.ok("alpha/todos:add", todo("ann", "b", 20)).await;
    client
        .ok("alpha/todos:addNote", json!({"topic":"t","body":"x"}))
        .await;
    let before = client.ok("alpha/todos:scan", json!({"order":"asc"})).await;

    // A new generation (version bump) re-applies the same declarations to
    // tables that now have rows; this must not be mistaken for a new index.
    installation.install(&ALPHA_SAME_NEXT);
    let revision = server.plugins().await.unwrap()["revision"].clone();
    let reloaded = server
        .reload_plugin("alpha".into())
        .await
        .unwrap_or_else(|e| panic!("identical schema reload failed: {e}"));
    assert_ne!(
        reloaded["revision"], revision,
        "reload did not publish a generation"
    );
    assert_eq!(
        client.ok("alpha/todos:scan", json!({"order":"asc"})).await,
        before
    );
    let error = client.err("alpha/todos:add", todo("ann", "a", 30)).await;
    assert!(error.contains("by_owner_text"), "{error}");
    drop(client);
    server.close().await.unwrap();

    if disk {
        // Restart over persisted rows and catalog: the startup load applies the
        // registry again and must accept the already-installed indexes.
        let server = installation
            .load()
            .await
            .unwrap_or_else(|e| panic!("restart with identical schema failed: {e}"));
        let mut client = Client::connect(&server).await;
        assert_eq!(
            client.ok("alpha/todos:scan", json!({"order":"asc"})).await,
            before
        );
        assert_eq!(
            ids(&client
                .ok("alpha/todos:recent", json!({"owner":"ann","since":10}))
                .await),
            vec![before[1]["_id"].as_str().unwrap().to_owned()]
        );
        assert_eq!(
            client
                .ok(
                    "alpha/todos:probe",
                    json!({"table":"notes","index":"by_topic"})
                )
                .await
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let error = client.err("alpha/todos:add", todo("ann", "b", 30)).await;
        assert!(error.contains("by_owner_text"), "{error}");
        drop(client);
        server.close().await.unwrap();
    }
}
backends!(
    reloading_identical_definitions_is_a_no_op_and_rows_survive_memory,
    reloading_identical_definitions_is_a_no_op_and_rows_survive_disk,
    reloading_identical_definitions_is_a_no_op_and_rows_survive
);

// ---------------------------------------------------------------------------
// 4. Backfill and rollback
// ---------------------------------------------------------------------------

/// Restoring the previous build serves its rows and indexes again, with no
/// partial indexes from the skipped build.
async fn assert_base_generation_intact(client: &mut Client, rows: &Value) {
    assert_eq!(
        &client.ok("alpha/todos:scan", json!({"order":"asc"})).await,
        rows
    );
    let error = client.err("alpha/todos:add", todo("ann", "a", 99)).await;
    assert!(error.contains("by_owner_text"), "uniqueness lost: {error}");
    for (table, index) in [("tags", "by_label"), ("todos", "by_owner_only")] {
        let error = client
            .err("alpha/todos:probe", json!({"table":table,"index":index}))
            .await;
        assert!(
            error.contains("does not exist"),
            "partial index {table}.{index}: {error}"
        );
    }
    let error = client
        .err(
            "alpha/todos:raw",
            json!({"payload": {
                "table": "todos", "where": [], "order": "asc", "limit": null,
                "index": {"name": "by_owner_created", "range": [], "eq": [
                    {"field": "owner", "value": "ann"},
                    {"field": "created", "value": 10},
                    {"field": "text", "value": "a"}
                ]}
            }}),
        )
        .await;
    assert!(
        error.contains("leading field order"),
        "changed definition survived: {error}"
    );
    let notes = client
        .ok(
            "alpha/todos:probe",
            json!({"table":"notes","index":"by_topic"}),
        )
        .await;
    assert_eq!(notes.as_array().unwrap().len(), 1);
}

async fn grant_exists(database: &Database, key: &str) -> bool {
    let table = DataSpace::plugin("tokamak.host")
        .unwrap()
        .table(&Table::new("grants").unwrap())
        .unwrap();
    let id = Id::new(table, format!("{:x}", Sha256::digest(key.as_bytes()))).unwrap();
    let mut tx = database.begin().await.unwrap();
    let found = Box::pin(tx.get(&id)).await.unwrap().is_some();
    tx.rollback().await.unwrap();
    found
}

async fn duplicate_backfill_skips_changed_plugin_and_rolls_back_schema(disk: bool) {
    let installation = Installation::new(disk);
    installation.install(&ALPHA);
    let server = installation.load().await.unwrap();
    let mut client = Client::connect(&server).await;
    client.ok("alpha/todos:add", todo("ann", "a", 10)).await;
    client
        .ok("alpha/todos:addNote", json!({"topic":"t","body":"x"}))
        .await;
    client.ok("alpha/todos:add", todo("ann", "b", 15)).await;
    let rows = client.ok("alpha/todos:scan", json!({"order":"asc"})).await;
    installation.install(&ALPHA_DUPLICATES);
    let catalog = server.reload_plugin("alpha".into()).await.unwrap();
    assert!(plugin_ids(&catalog).is_empty());
    assert_backfill_skip(&catalog, "alpha");
    assert_plugin_unloaded(&mut client, "alpha").await;

    if !disk {
        installation.install(&ALPHA);
        let catalog = server.reload_plugin("alpha".into()).await.unwrap();
        assert_eq!(catalog["skipped"], json!({}));
        assert_base_generation_intact(&mut client, &rows).await;
    }
    drop(client);
    server.close().await.unwrap();

    if disk {
        assert_failed_index_reload_persistence(&installation, &rows).await;
    }
}
backends!(
    duplicate_backfill_skips_changed_plugin_and_rolls_back_schema_memory,
    duplicate_backfill_skips_changed_plugin_and_rolls_back_schema_disk,
    duplicate_backfill_skips_changed_plugin_and_rolls_back_schema
);

async fn reload_backfills_rebuilds_and_drops_indexes_without_touching_rows(disk: bool) {
    let installation = Installation::new(disk);
    installation.install(&ALPHA);
    let server = installation.load().await.unwrap();
    let mut client = Client::connect(&server).await;
    let first = client.ok("alpha/todos:add", todo("ann", "z", 1)).await;
    let second = client.ok("alpha/todos:add", todo("bob", "a", 2)).await;
    client
        .ok("alpha/todos:addNote", json!({"topic":"t","body":"x"}))
        .await;

    installation.install(&ALPHA_ADDED);
    server.reload_plugin("alpha".into()).await.unwrap();
    let rows = client
        .ok(
            "alpha/todos:probe",
            json!({"table":"todos","index":"by_done"}),
        )
        .await;
    let mut expected = [
        first.as_str().unwrap().to_owned(),
        second.as_str().unwrap().to_owned(),
    ];
    expected.sort();
    assert_eq!(ids(&rows), expected);

    installation.install(&ALPHA_REBUILT);
    server.reload_plugin("alpha".into()).await.unwrap();
    assert_eq!(
        texts(
            &client
                .ok(
                    "alpha/todos:probe",
                    json!({"table":"todos","index":"by_owner_text"})
                )
                .await
        ),
        ["a", "z"]
    );
    for (table, index) in [
        ("todos", "by_done"),
        ("notes", "by_topic"),
        ("tags", "by_label"),
    ] {
        let error = client
            .err("alpha/todos:probe", json!({"table":table,"index":index}))
            .await;
        assert!(error.contains("does not exist"), "{table}.{index}: {error}");
    }
    let notes = client.ok("alpha/todos:notes", json!({})).await;
    assert_eq!(notes.as_array().unwrap().len(), 1);
    assert_eq!(notes[0]["body"], "x");
    drop(client);
    server.close().await.unwrap();

    if disk {
        let mut database = Database::open(installation.storage()).await.unwrap();
        let space = DataSpace::plugin("alpha").unwrap();
        let notes = space.table(&Table::new("notes").unwrap()).unwrap();
        let mut tx = database.read_only().await.unwrap();
        assert_eq!(
            tx.query(&notes).collect().await.unwrap()[0]
                .clone()
                .into_json()["body"],
            "x"
        );
        tx.commit().await.unwrap();
        database.close().await.unwrap();
    }
}
backends!(
    reload_backfills_rebuilds_and_drops_indexes_without_touching_rows_memory,
    reload_backfills_rebuilds_and_drops_indexes_without_touching_rows_disk,
    reload_backfills_rebuilds_and_drops_indexes_without_touching_rows
);

#[test]
fn startup_skips_duplicate_backfill_and_serves_other_plugins() {
    run(async {
        let installation = Installation::new(true);
        installation.install(&ALPHA);
        installation.install(&BETA);
        let server = installation.load().await.unwrap();
        let mut client = Client::connect(&server).await;
        client.ok("alpha/todos:add", todo("ann", "a", 10)).await;
        client.ok("alpha/todos:add", todo("ann", "b", 20)).await;
        client
            .ok(
                "beta/todos:add",
                json!({"owner":"bob","text":"c","created":30}),
            )
            .await;
        drop(client);
        server.close().await.unwrap();

        installation.install(&ALPHA_DUPLICATES);
        installation.edit_manifest("beta", |m| m["plugin"]["version"] = json!("1.0.1"));
        let log = local_startup_log(&installation).await;
        assert!(
            log.lines().any(|line| {
                line.contains("Skipping plugin alpha:")
                    && line.contains("by_owner_only")
                    && line.contains("ann")
            }),
            "{log}"
        );
        let server = installation.load().await.unwrap();
        let mut client = Client::connect(&server).await;
        assert_plugin_unloaded(&mut client, "alpha").await;
        assert_eq!(
            texts(&client.ok("beta/todos:byText", json!({})).await),
            ["c"]
        );
        let catalog = server.plugins().await.unwrap();
        assert_eq!(plugin_ids(&catalog), ["beta"]);
        assert_eq!(catalog["plugins"][0]["plugin"]["version"], "1.0.1");
        drop(client);
        server.close().await.unwrap();

        installation.install(&ALPHA);
        let server = installation.load().await.unwrap();
        let mut client = Client::connect(&server).await;
        assert_eq!(
            texts(&client.ok("alpha/todos:scan", json!({"order":"asc"})).await),
            ["a", "b"]
        );
        drop(client);
        server.close().await.unwrap();
    });
}

fn plugin_ids(catalog: &Value) -> Vec<&str> {
    catalog["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .map(|manifest| manifest["plugin"]["id"].as_str().unwrap())
        .collect()
}

fn assert_backfill_skip(catalog: &Value, id: &str) {
    let reason = catalog["skipped"][id].as_str().unwrap();
    assert!(
        reason.contains(&format!("Plugin {id} schema index todos.by_owner_only"))
            && reason.contains("ann"),
        "{reason}"
    );
}

async fn assert_plugin_unloaded(client: &mut Client, id: &str) {
    let name = format!("{id}/todos:scan");
    let error = client.err(&name, json!({"order":"asc"})).await;
    assert!(
        error.contains(&format!("unknown function: {name}")),
        "{error}"
    );
}

#[test]
fn reload_skips_readded_plugin_and_updates_its_sibling() {
    run(async {
        let installation = Installation::new(true);
        installation.install(&ALPHA);
        installation.install(&BETA);
        let server = installation.load().await.unwrap();
        let mut client = Client::connect(&server).await;
        client.ok("alpha/todos:add", todo("ann", "a", 10)).await;
        client.ok("alpha/todos:add", todo("ann", "b", 20)).await;
        let mut rows = client.ok("alpha/todos:scan", json!({"order":"asc"})).await;

        std::fs::rename(
            installation.plugins().join("alpha"),
            installation.root.join("old-alpha"),
        )
        .unwrap();
        let catalog = server.reload_plugin("alpha".into()).await.unwrap();
        assert_eq!(plugin_ids(&catalog), ["beta"]);

        installation.install(&ALPHA_DUPLICATES);
        installation.edit_manifest("beta", |m| m["plugin"]["version"] = json!("1.0.1"));
        let catalog = server.reload_plugin("alpha".into()).await.unwrap();
        assert_eq!(plugin_ids(&catalog), ["beta"]);
        assert_eq!(catalog["plugins"][0]["plugin"]["version"], "1.0.1");
        assert_eq!(
            server.plugins().await.unwrap()["plugins"],
            catalog["plugins"]
        );
        assert_backfill_skip(&catalog, "alpha");
        assert_plugin_unloaded(&mut client, "alpha").await;
        drop(client);
        server.close().await.unwrap();

        let mut database = Database::open(installation.storage()).await.unwrap();
        let space = DataSpace::plugin("alpha").unwrap();
        let mut tx = database.begin().await.unwrap();
        let persisted: Vec<_> = tx
            .query(&physical_table("alpha", "todos"))
            .with_index("by_owner_created")
            .collect()
            .await
            .unwrap()
            .into_iter()
            .map(|row| space.document(row).unwrap())
            .collect();
        assert_eq!(json!(persisted), rows);
        let duplicate = space.id(rows[1]["_id"].as_str().unwrap()).unwrap();
        tx.patch(&duplicate, json_object(&json!({"owner":"bob"})).unwrap())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        database.close().await.unwrap();

        rows[1]["owner"] = json!("bob");
        let server = installation.load().await.unwrap();
        let mut client = Client::connect(&server).await;
        assert_eq!(
            plugin_ids(&server.plugins().await.unwrap()),
            ["alpha", "beta"]
        );
        assert_eq!(
            client
                .ok(
                    "alpha/todos:probe",
                    json!({"table":"todos","index":"by_owner_only"})
                )
                .await,
            rows
        );
        drop(client);
        server.close().await.unwrap();
    });
}

#[test]
fn reload_reports_both_failed_backfills_and_updates_the_plugin_between_them() {
    run(async {
        let installation = Installation::new(true);
        let zeta = Variant {
            key: "zeta-duplicates",
            id: "zeta",
            ..ALPHA_DUPLICATES
        };
        installation.install(&ALPHA);
        installation.install(&BETA);
        let database = Database::open(installation.storage()).await.unwrap();
        for id in ["alpha", "zeta"] {
            seed_duplicate_owners_for(&database, id).await;
        }
        let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
        let server = Server::load_plugins(database, pool, &installation.plugins())
            .await
            .unwrap();
        let mut client = Client::connect(&server).await;
        client
            .ok(
                "beta/todos:add",
                json!({"owner":"ann","text":"c","created":30}),
            )
            .await;

        installation.install(&ALPHA_DUPLICATES);
        installation.install(&zeta);
        installation.install(&BETA_BY_OWNER);
        let catalog = server.reload_plugin("beta".into()).await.unwrap();
        assert_eq!(plugin_ids(&catalog), ["beta"]);
        assert_eq!(catalog["plugins"][0]["plugin"]["version"], "1.0.1");
        for id in ["alpha", "zeta"] {
            assert_backfill_skip(&catalog, id);
            assert_plugin_unloaded(&mut client, id).await;
        }
        assert_eq!(
            texts(&client.ok("beta/todos:byText", json!({})).await),
            ["c"]
        );
        drop(client);
        server.close().await.unwrap();

        let mut database = Database::open(installation.storage()).await.unwrap();
        let mut tx = database.read_only().await.unwrap();
        let rows = tx
            .query(&physical_table("beta", "todos"))
            .with_index("by_owner_created")
            .eq("owner", "ann")
            .collect()
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].clone().into_json()["text"], "c");
        tx.rollback().await.unwrap();
        database.close().await.unwrap();
    });
}

#[test]
fn startup_skips_both_failed_backfills_and_loads_the_plugin_between_them() {
    run(async {
        let installation = Installation::new(true);
        let zeta = Variant {
            key: "zeta-duplicates",
            id: "zeta",
            ..ALPHA_DUPLICATES
        };
        for variant in [&ALPHA_DUPLICATES, &BETA, &zeta] {
            installation.install(variant);
        }
        let mut database = Database::open(installation.storage()).await.unwrap();
        for id in ["alpha", "zeta"] {
            seed_duplicate_owners_for(&database, id).await;
        }
        database.close().await.unwrap();

        let log = local_startup_log(&installation).await;
        for id in ["alpha", "zeta"] {
            assert!(
                log.lines().any(|line| {
                    line.contains(&format!("Skipping plugin {id}:"))
                        && line.contains("by_owner_only")
                        && line.contains("ann")
                }),
                "{log}"
            );
        }
        let server = installation.load().await.unwrap();
        assert_eq!(plugin_ids(&server.plugins().await.unwrap()), ["beta"]);
        let mut client = Client::connect(&server).await;
        for id in ["alpha", "zeta"] {
            assert_plugin_unloaded(&mut client, id).await;
        }
        assert_eq!(client.ok("beta/todos:byText", json!({})).await, json!([]));
        drop(client);
        server.close().await.unwrap();
    });
}

#[test]
fn startup_skips_required_dependents_before_applying_their_schemas_and_grants() {
    run(async {
        let installation = Installation::new(true);
        let gamma = Variant {
            key: "gamma",
            id: "gamma",
            ..BETA
        };
        let delta = Variant {
            key: "delta",
            id: "delta",
            ..BETA
        };
        let optional = Variant {
            key: "optional",
            id: "optional",
            ..BETA
        };
        let mut db = Database::open(installation.storage()).await.unwrap();
        seed_duplicate_owners(&db).await;
        db.close().await.unwrap();
        for variant in [&ALPHA_DUPLICATES, &BETA, &gamma, &delta, &optional] {
            installation.install(variant);
        }
        installation.edit_manifest("beta", |m| m["plugin"]["depends"] = json!({"alpha":"*"}));
        installation.edit_manifest("delta", |m| m["plugin"]["depends"] = json!({"beta":"*"}));
        installation.edit_manifest("optional", |m| {
            m["plugin"]["optional"] = json!({"alpha":"*"})
        });

        let log = local_startup_log(&installation).await;
        for line in [
            "Skipping plugin alpha:",
            "Skipping plugin beta: requires alpha, which did not load",
            "Skipping plugin delta: requires beta, which did not load",
        ] {
            assert!(log.contains(line), "{log}");
        }
        let mut db = Database::open(installation.storage()).await.unwrap();
        for id in ["beta", "delta"] {
            assert!(!grant_exists(&db, &format!("{id}@1.0.0")).await);
            assert_missing_index(&db, id, "todos", "by_owner_created").await;
        }
        db.close().await.unwrap();

        let server = installation.load().await.unwrap();
        let catalog = server.plugins().await.unwrap();
        assert_eq!(plugin_ids(&catalog), ["gamma", "optional"]);
        let mut client = Client::connect(&server).await;
        for id in ["gamma", "optional"] {
            assert_eq!(
                client.ok(&format!("{id}/todos:byText"), json!({})).await,
                json!([])
            );
        }
        drop(client);
        server.close().await.unwrap();
    });
}

#[test]
fn reload_isolates_skipped_plugins_and_recovers_them_after_row_repair() {
    run(async {
        let installation = Installation::new(true);
        let dependent = Variant {
            key: "dependent",
            id: "dependent",
            ..BETA
        };
        for variant in [&ALPHA, &BETA, &dependent] {
            installation.install(variant);
        }
        installation.edit_manifest("dependent", |m| {
            m["plugin"]["depends"] = json!({"alpha":"*"})
        });
        installation.load().await.unwrap().close().await.unwrap();
        installation.install(&ALPHA_DUPLICATES);
        let database = Database::open(installation.storage()).await.unwrap();
        let duplicate = seed_duplicate_owners(&database).await;
        let mut repair = database.begin().await.unwrap();
        let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
        let server = Server::load_plugins(database, pool, &installation.plugins())
            .await
            .unwrap();

        installation.edit_manifest("beta", |m| m["plugin"]["version"] = json!("1.0.1"));
        let catalog = server.reload_plugin("beta".into()).await.unwrap();
        assert_eq!(plugin_ids(&catalog), ["beta"]);
        assert_eq!(catalog["plugins"][0]["plugin"]["version"], "1.0.1");
        let reason = catalog["skipped"]["alpha"].as_str().unwrap();
        assert!(
            reason.contains("by_owner_only") && reason.contains("ann"),
            "{reason}"
        );
        assert_eq!(
            catalog["skipped"]["dependent"],
            "requires alpha, which did not load"
        );

        repair
            .patch(&duplicate, json_object(&json!({"owner":"bob"})).unwrap())
            .await
            .unwrap();
        repair.commit().await.unwrap();
        let catalog = server.reload_plugin("beta".into()).await.unwrap();
        assert_eq!(plugin_ids(&catalog), ["alpha", "beta", "dependent"]);
        assert_eq!(catalog["skipped"], json!({}));
        let mut client = Client::connect(&server).await;
        let rows = client
            .ok(
                "alpha/todos:probe",
                json!({"table":"todos","index":"by_owner_only"}),
            )
            .await;
        assert_eq!(texts(&rows), ["a", "b"]);
        assert_eq!(
            client.ok("dependent/todos:byText", json!({})).await,
            json!([])
        );
        drop(client);
        server.close().await.unwrap();
    });
}

#[test]
fn changed_skipped_build_reports_inspection_failure_without_blocking_reload() {
    run(async {
        let installation = Installation::new(false);
        installation.install(&ALPHA_DUPLICATES);
        installation.install(&BETA);
        let database = Database::open(installation.storage()).await.unwrap();
        seed_duplicate_owners(&database).await;
        let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
        let server = Server::load_plugins(database, pool, &installation.plugins())
            .await
            .unwrap();

        installation.rewrite_bundle("alpha", BUNDLE_SCHEMA, "var schema = 42;");
        let catalog = server.reload_plugin("beta".into()).await.unwrap();
        assert_eq!(plugin_ids(&catalog), ["beta"]);
        assert!(
            catalog["skipped"]["alpha"]
                .as_str()
                .unwrap()
                .contains("Invalid plugin schema")
        );

        installation.install(&ALPHA_ADDED);
        let catalog = server.reload_plugin("beta".into()).await.unwrap();
        assert_eq!(plugin_ids(&catalog), ["alpha", "beta"]);
        assert_eq!(catalog["skipped"], json!({}));
        let mut client = Client::connect(&server).await;
        let rows = client
            .ok(
                "alpha/todos:probe",
                json!({"table":"todos","index":"by_done"}),
            )
            .await;
        let mut result = texts(&rows);
        result.sort_unstable();
        assert_eq!(result, ["a", "b"]);
        drop(client);
        server.close().await.unwrap();
    });
}

async fn seed_duplicate_owners(db: &Database) -> Id {
    seed_duplicate_owners_for(db, "alpha").await
}

async fn seed_duplicate_owners_for(db: &Database, id: &str) -> Id {
    let table = physical_table(id, "todos");
    let mut tx = db.begin().await.unwrap();
    tx.insert(&table, json_object(&todo("ann", "a", 1)).unwrap())
        .await
        .unwrap();
    let duplicate = tx
        .insert(&table, json_object(&todo("ann", "b", 2)).unwrap())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    duplicate
}

fn physical_table(owner: &str, name: &str) -> Table {
    DataSpace::plugin(owner)
        .unwrap()
        .table(&Table::new(name).unwrap())
        .unwrap()
}

async fn assert_missing_index(db: &Database, owner: &str, table: &str, index: &str) {
    let mut tx = db.read_only().await.unwrap();
    let error = tx
        .query(&physical_table(owner, table))
        .with_index(index)
        .collect()
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("does not exist"),
        "{owner}/{table}.{index}: {error}"
    );
    tx.rollback().await.unwrap();
}

// A new index is only refused because of existing rows: on still-empty tables
// the same reload succeeds and the new indexes become queryable.
#[test]
fn new_indexes_on_empty_tables_install_on_reload() {
    run(async {
        let installation = Installation::new(false);
        installation.install(&ALPHA);
        let server = installation.load().await.unwrap();
        installation.install(&ALPHA_ADDED);
        server
            .reload_plugin("alpha".into())
            .await
            .unwrap_or_else(|e| panic!("new indexes on empty tables refused: {e}"));
        let mut client = Client::connect(&server).await;
        client.ok("alpha/todos:add", todo("ann", "a", 1)).await;
        for (table, index, count) in [("tags", "by_label", 0), ("todos", "by_done", 1)] {
            let rows = client
                .ok("alpha/todos:probe", json!({"table":table,"index":index}))
                .await;
            assert_eq!(rows.as_array().unwrap().len(), count, "{table}.{index}");
        }
        drop(client);
        server.close().await.unwrap();
    });
}

#[test]
fn startup_backfills_without_resetting_any_plugin() {
    run(async {
        let installation = Installation::new(true);
        installation.install(&ALPHA);
        installation.install(&BETA);
        installation.load().await.unwrap().close().await.unwrap();

        let mut database = Database::open(installation.storage()).await.unwrap();
        let mut tx = database.begin().await.unwrap();
        let mut seeded = Vec::new();
        for (plugin, table) in [
            ("alpha", "todos"),
            ("alpha", "notes"),
            ("alpha", "old"),
            ("beta", "todos"),
        ] {
            let table = DataSpace::plugin(plugin)
                .unwrap()
                .table(&Table::new(table).unwrap())
                .unwrap();
            if table.as_str().ends_with("__old") {
                tx.define_index(&table, "by_owner", &["owner"], false)
                    .await
                    .unwrap();
            }
            let value = json_object(&todo("ann", "existing", 1)).unwrap();
            seeded.push((plugin, tx.insert(&table, value).await.unwrap()));
        }
        tx.commit().await.unwrap();
        database.close().await.unwrap();
        installation.install(&ALPHA_ADDED);
        let log = local_startup_log(&installation).await;
        assert!(!log.contains("Schema hard reset:"), "{log}");

        let mut database = Database::open(installation.storage()).await.unwrap();
        let mut tx = database.read_only().await.unwrap();
        for (_, id) in &seeded {
            assert!(tx.get(id).await.unwrap().is_some(), "{id}");
        }
        assert_eq!(
            tx.query(seeded[0].1.table())
                .with_index("by_done")
                .collect()
                .await
                .unwrap()[0]
                .id,
            seeded[0].1
        );
        assert_eq!(
            tx.query(seeded[3].1.table())
                .with_index("by_owner_created")
                .collect()
                .await
                .unwrap()[0]
                .id,
            seeded[3].1
        );
        assert!(
            tx.query(seeded[2].1.table())
                .with_index("by_owner")
                .collect()
                .await
                .unwrap_err()
                .to_string()
                .contains("does not exist")
        );
        tx.rollback().await.unwrap();
        assert!(grant_exists(&database, "alpha@1.0.0").await);
        database.close().await.unwrap();
    });
}

async fn local_startup_log(installation: &Installation) -> String {
    use std::os::unix::fs::PermissionsExt;
    let log = installation.root.join("server.log");
    let token_path = installation.root.join("server.token");
    let token = "a".repeat(64);
    std::fs::write(&token_path, &token).unwrap();
    std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_tokamak-server"))
        .arg("--local-dir")
        .arg(&installation.root)
        .arg("--plugins")
        .arg(installation.plugins())
        .stdout(std::process::Stdio::null())
        .stderr(std::fs::File::create(&log).unwrap())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let descriptor = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(installation.root.join("server.json")) {
                break serde_json::from_str::<Value>(&text).unwrap();
            }
            assert!(
                child.try_wait().unwrap().is_none(),
                "{}",
                std::fs::read_to_string(&log).unwrap()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("local server did not become ready");
    let log = std::fs::read_to_string(log).unwrap();
    assert_eq!(std::fs::read_to_string(token_path).unwrap(), token);

    let url = descriptor["url"]
        .as_str()
        .unwrap()
        .replace("ws://", "http://")
        .replace("/ws", "/shutdown");
    let _ = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
        .post(url)
        .bearer_auth(token)
        .send()
        .await;
    assert!(
        tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    log
}

#[test]
fn chat_starts_with_current_schema_and_keeps_legacy_messages() {
    let output = std::process::Command::new("proto")
        .args([
            "run",
            "bun",
            "--",
            "-e",
            r#"
            import { schemaMetadata } from './packages/sdk/src/index';
            import previous from './plugins/chat/tests/fixtures/schema-before-local-turns';
            import current from './plugins/chat/src/server/schema';
            console.log(JSON.stringify([schemaMetadata(previous), schemaMetadata(current)]));
        "#,
        ])
        .current_dir(workspace())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let [previous, current]: [Value; 2] = serde_json::from_slice(&output.stdout).unwrap();

    run(async {
        let installation = Installation::new(true);
        let space = DataSpace::plugin("chat").unwrap();
        let messages = space.table(&Table::new("messages").unwrap()).unwrap();
        start_chat_schema(&installation, &space, previous).await;

        let mut database = Database::open(installation.storage()).await.unwrap();
        let mut tx = database.begin().await.unwrap();
        tx.insert(
            &messages,
            json_object(&json!({
                "threadId": "chat/threads:legacy", "role":"assistant", "createdAt":1,
                "status":"complete","parts":[{"type":"text","text":"Earlier reply"}],
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        database.close().await.unwrap();

        start_chat_schema(&installation, &space, current).await;
        let mut database = Database::open(installation.storage()).await.unwrap();
        let mut tx = database.read_only().await.unwrap();
        let rows = tx.query(&messages).collect().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].fields.get("role"),
            Some(&server::data::Value::String("assistant".into()))
        );
        assert_eq!(
            rows[0].fields.get("parts"),
            json_object(&json!({ "parts": [{"type":"text","text":"Earlier reply"}] }))
                .unwrap()
                .get("parts")
        );
        tx.commit().await.unwrap();
        database.close().await.unwrap();
    });
}

async fn start_chat_schema(installation: &Installation, space: &DataSpace, schema: Value) {
    let source =
        format!("export function describe() {{ return {{ schema: {schema}, functions: [] }}; }}");
    let bundle = || Bundle::new(source.clone(), None).unwrap();
    let bundle = Arc::new(bundle().with_transactions(bundle()));
    let database = Database::open(installation.storage()).await.unwrap();
    let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
    let server = Server::load_in_space(database, pool, bundle, space.clone())
        .await
        .unwrap();
    server.close().await.unwrap();
}

// ---------------------------------------------------------------------------
// 7. Live updates and isolation
// ---------------------------------------------------------------------------

/// Waits for the subscription to deliver `expected` row IDs. Conservative
/// invalidation may deliver extra unchanged results first; a missing rerun
/// times out.
async fn until(reader: &mut Session, id: u64, expected: &[String]) {
    loop {
        match next(reader).await {
            Event::Subscription {
                id: actual,
                result: Ok(value),
            } if actual == id => {
                if ids(&value) == expected {
                    return;
                }
            }
            event => panic!("unexpected {event:?}"),
        }
    }
}

// Writes that move a row into or out of an indexed range must re-run the
// subscription; otherwise live UIs would show stale indexed results.
#[test]
fn indexed_subscriptions_rerun_when_rows_enter_or_leave_the_range() {
    run(async {
        let installation = Installation::new(false);
        installation.install(&ALPHA);
        let server = installation.load().await.unwrap();
        let mut writer = Client::connect(&server).await;
        let mut reader = server.connect().await.unwrap();
        reader
            .subscribe(7, "alpha/todos:recent", json!({"owner":"ann","since":10}))
            .unwrap();
        until(&mut reader, 7, &[]).await;

        let first = writer.ok("alpha/todos:add", todo("ann", "a", 20)).await;
        let first = first.as_str().unwrap().to_owned();
        until(&mut reader, 7, std::slice::from_ref(&first)).await;

        let second = writer.ok("alpha/todos:add", todo("ann", "b", 30)).await;
        let second = second.as_str().unwrap().to_owned();
        until(&mut reader, 7, &[second.clone(), first.clone()]).await;

        // Leave the range (created 20 -> 5), then re-enter at the top.
        writer
            .ok("alpha/todos:move", json!({"id":first,"created":5}))
            .await;
        until(&mut reader, 7, std::slice::from_ref(&second)).await;
        writer
            .ok("alpha/todos:move", json!({"id":first,"created":40}))
            .await;
        until(&mut reader, 7, &[first.clone(), second.clone()]).await;

        // A row in range for another owner does not join the result.
        writer.ok("alpha/todos:add", todo("bob", "z", 50)).await;
        let third = writer.ok("alpha/todos:add", todo("ann", "c", 35)).await;
        let third = third.as_str().unwrap().to_owned();
        until(&mut reader, 7, &[first, third, second]).await;
        drop(reader);
        drop(writer);
        server.close().await.unwrap();
    });
}

// Two plugins declare the same logical table and index names with different
// fields and uniqueness. Each must get its own physical table and indexes.
#[test]
fn plugins_with_the_same_table_and_index_names_stay_isolated() {
    run(async {
        let installation = Installation::new(false);
        installation.install(&ALPHA);
        installation.install(&BETA);
        let server = installation
            .load()
            .await
            .unwrap_or_else(|e| panic!("colliding logical names failed to load: {e}"));
        let metadata = server.plugins().await.unwrap();
        assert_eq!(
            metadata["schema"]["beta"]["tables"]["todos"]["indexes"],
            json!([
                {"name":"by_owner_created","fields":["text"],"unique":false},
                {"name":"by_owner_text","fields":["created"],"unique":true},
            ])
        );
        assert_eq!(
            metadata["schema"]["alpha"]["tables"]["todos"]["indexes"][1]["fields"],
            json!(["owner", "text"])
        );
        let mut client = Client::connect(&server).await;
        client.ok("alpha/todos:add", todo("ann", "x", 1)).await;
        // Same (owner, text) as alpha's row: only alpha's unique index covers it.
        client
            .ok(
                "beta/todos:add",
                json!({"owner":"ann","text":"x","created":1}),
            )
            .await;
        // beta's unique index is on `created`; alpha's rows never count.
        client
            .ok(
                "beta/todos:add",
                json!({"owner":"bob","text":"a","created":2}),
            )
            .await;
        let error = client
            .err(
                "beta/todos:add",
                json!({"owner":"cy","text":"b","created":2}),
            )
            .await;
        assert!(error.contains("by_owner_text"), "{error}");
        client.ok("alpha/todos:add", todo("bob", "y", 2)).await;

        let beta = client.ok("beta/todos:byText", json!({})).await;
        let order: Vec<_> = beta
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["text"].as_str().unwrap())
            .collect();
        assert_eq!(
            order,
            ["a", "x"],
            "beta's by_owner_created must order by text"
        );
        assert!(
            ids(&beta).iter().all(|id| id.starts_with("beta/todos:")),
            "{beta}"
        );
        let alpha = client.ok("alpha/todos:scan", json!({"order":"asc"})).await;
        assert_eq!(texts(&alpha), ["x", "y"]);
        assert!(
            ids(&alpha).iter().all(|id| id.starts_with("alpha/todos:")),
            "{alpha}"
        );
        drop(client);
        server.close().await.unwrap();
    });
}

// ---------------------------------------------------------------------------
// 9. Bundles without a schema registry
// ---------------------------------------------------------------------------

// Bundles from before the registry exported `schema = null`; an empty object
// is the other legacy shape. Both must load and serve un-indexed queries.
#[test]
fn bundles_with_a_null_or_empty_schema_load_and_serve_unindexed_queries() {
    run(async {
        for legacy in ["null", "{}"] {
            let installation = Installation::new(false);
            installation.install(&ALPHA);
            installation.rewrite_bundle("alpha", BUNDLE_SCHEMA, &format!("var schema = {legacy};"));
            let server = installation
                .load()
                .await
                .unwrap_or_else(|e| panic!("schema {legacy} failed to load: {e}"));
            let mut client = Client::connect(&server).await;
            client.ok("alpha/todos:add", todo("ann", "a", 1)).await;
            // No registry, so no uniqueness: the duplicate is an ordinary row.
            client.ok("alpha/todos:add", todo("ann", "a", 2)).await;
            client.ok("alpha/todos:add", todo("bob", "b", 3)).await;
            let rows = client
                .ok("alpha/todos:unindexed", json!({"owner":"ann"}))
                .await;
            assert_eq!(rows.as_array().unwrap().len(), 2, "schema {legacy}: {rows}");
            let error = client
                .err("alpha/todos:recent", json!({"owner":"ann","since":0}))
                .await;
            assert!(error.contains("does not exist"), "schema {legacy}: {error}");
            drop(client);
            server.close().await.unwrap();
        }
    });
}

// A bundle not produced by the SDK can carry an invalid registry. The server
// validates it itself and refuses the plugin before installing anything.
#[test]
fn server_rejects_invalid_schema_registries_from_non_sdk_bundles() {
    run(async {
        let description =
            json!({"kind":"object","fields":{"owner":{"kind":"string"},"text":{"kind":"string"}}});
        let index = |name: &str, fields: Value| json!({"name":name,"fields":fields,"unique":false});
        let cases = [
            (
                "undeclared field",
                json!([index("by_x", json!(["missing"]))]),
            ),
            (
                "system field",
                json!([index("by_x", json!(["_creationTime"]))]),
            ),
            ("empty fields", json!([index("by_x", json!([]))])),
            (
                "repeated field",
                json!([index("by_x", json!(["owner", "owner"]))]),
            ),
            ("bad name", json!([index("by-x", json!(["owner"]))])),
            (
                "duplicate name",
                json!([
                    index("by_x", json!(["owner"])),
                    index("by_x", json!(["text"]))
                ]),
            ),
        ];
        for (case, indexes) in cases {
            let installation = Installation::new(false);
            installation.install(&ALPHA);
            let schema = json!({"tables":{"todos":{"description":description,"indexes":indexes}}});
            installation.rewrite_bundle("alpha", BUNDLE_SCHEMA, &format!("var schema = {schema};"));
            let error = installation
                .load()
                .await
                .map(|_| panic!("{case}: invalid registry accepted"))
                .unwrap_err();
            assert!(error.contains("Invalid schema index"), "{case}: {error}");
        }
    });
}

// The schema is plugin-controlled and is installed natively, outside the JS
// execution budget and under the catalog gate. Without caps a bundle declaring
// tens of thousands of indexes was accepted and installed. Each oversized shape
// must be refused at load, before anything is installed.
#[test]
fn server_refuses_oversized_schema_registries() {
    run(async {
        let index = |name: &str, fields: Value| json!({"name":name,"fields":fields,"unique":false});
        let table = |fields: &[String], indexes: Value| {
            let fields: serde_json::Map<String, Value> = fields
                .iter()
                .map(|f| (f.clone(), json!({"kind":"string"})))
                .collect();
            json!({"description":{"kind":"object","fields":fields},"indexes":indexes})
        };
        let owner = ["owner".to_owned()];
        let many_fields: Vec<String> = (0..17).map(|i| format!("f{i}")).collect();
        let long = "a".repeat(65);
        let cases = [
            (
                "too many indexes on a table",
                json!({"todos": table(&owner, Value::Array(
                    (0..33).map(|i| index(&format!("by_{i}"), json!(["owner"]))).collect(),
                ))}),
                "at most 32 indexes",
            ),
            (
                "too many fields in an index",
                json!({"todos": table(&many_fields, json!([index("by_all", json!(many_fields))]))}),
                "at most 16 fields",
            ),
            (
                "index name too long",
                json!({"todos": table(&owner, json!([index(&long, json!(["owner"]))]))}),
                "index names are at most 64 bytes",
            ),
            (
                "table name too long",
                json!({long.clone(): table(&owner, json!([]))}),
                "table names are at most 64 bytes",
            ),
            (
                "too many tables",
                Value::Object(
                    (0..257)
                        .map(|i| (format!("t{i}"), table(&owner, json!([]))))
                        .collect(),
                ),
                "at most 256 tables",
            ),
        ];
        for (case, tables, expected) in cases {
            let installation = Installation::new(false);
            installation.install(&ALPHA);
            let schema = json!({"tables": tables});
            installation.rewrite_bundle("alpha", BUNDLE_SCHEMA, &format!("var schema = {schema};"));
            let error = installation
                .load()
                .await
                .map(|_| panic!("{case}: oversized registry accepted"))
                .unwrap_err();
            assert!(error.contains(expected), "{case}: {error}");
        }

        // The caps themselves are allowed: 32 indexes of up to 16 fields load.
        let installation = Installation::new(false);
        installation.install(&ALPHA);
        let fields: Vec<String> = (0..16).map(|i| format!("f{i}")).collect();
        let indexes: Vec<Value> = (0..32)
            .map(|i| index(&format!("by_{i}"), json!(fields[..=i % 16])))
            .collect();
        let schema = json!({"tables": {"todos": table(&fields, Value::Array(indexes))}});
        installation.rewrite_bundle("alpha", BUNDLE_SCHEMA, &format!("var schema = {schema};"));
        if let Err(error) = installation.load().await {
            panic!("schema at the caps was refused: {error}");
        }
    });
}

fn expected_index_rows(
    rows: &[(String, String, i64)],
    owner: &str,
    lower: Option<(&str, i64)>,
    upper: Option<(&str, i64)>,
    desc: bool,
    limit: Option<usize>,
) -> Vec<String> {
    let mut matching: Vec<_> = rows
        .iter()
        .filter(|(_, o, c)| {
            o == owner
                && lower.is_none_or(|(op, v)| {
                    if op == "gt" {
                        *c > v
                    } else {
                        *c >= v
                    }
                })
                && upper.is_none_or(|(op, v)| {
                    if op == "lt" {
                        *c < v
                    } else {
                        *c <= v
                    }
                })
        })
        .map(|(id, _, c)| (*c, id.clone()))
        .collect();
    matching.sort();
    if desc {
        matching.reverse();
    }
    let mut result: Vec<String> = matching.into_iter().map(|(_, id)| id).collect();
    if let Some(limit) = limit {
        result.truncate(limit);
    }
    result
}

async fn assert_index_range_case(
    client: &mut Client,
    rows: &[(String, String, i64)],
    bounds: RangeBounds<'_>,
) {
    let (lower, upper, desc, limit) = bounds;
    let mut args = json!({"owner":"ann","order":if desc {"desc"} else {"asc"}});
    if let Some((op, value)) = lower {
        args["lower"] = json!({"op":op,"value":value});
    }
    if let Some((op, value)) = upper {
        args["upper"] = json!({"op":op,"value":value});
    }
    if let Some(limit) = limit {
        args["limit"] = json!(limit);
    }
    let actual = client.ok("alpha/todos:range", args.clone()).await;
    assert_eq!(
        ids(&actual),
        expected_index_rows(rows, "ann", lower, upper, desc, limit),
        "range {args}"
    );
}

fn invalid_index_payloads() -> Vec<(&'static str, Value, Value, &'static str)> {
    let eq = |field: &str, value: Value| json!({"field":field,"value":value});

    let cases = [
        (
            "unknown index",
            json!({"name":"by_missing","eq":[],"range":[]}),
            json!([]),
            "does not exist",
        ),
        (
            "eq out of index order",
            json!({"name":"by_owner_created","eq":[eq("created",json!(10))],"range":[]}),
            json!([]),
            "leading field order",
        ),
        (
            "eq skipping the leading field",
            json!({"name":"by_owner_created","eq":[eq("owner",json!("ann")),eq("text",json!("a"))],"range":[]}),
            json!([]),
            "leading field order",
        ),
        (
            "eq beyond the index fields",
            json!({"name":"by_owner_created","eq":[eq("owner",json!("ann")),eq("created",json!(10)),eq("done",json!(false))],"range":[]}),
            json!([]),
            "leading field order",
        ),
    ];

    cases.into_iter().chain(invalid_range_payloads()).collect()
}

async fn assert_failed_index_reload_persistence(installation: &Installation, rows: &Value) {
    // Inspect persisted state directly: the refused 1.1.0 generation must
    // not have recorded its grant (it is written in the same transaction).
    let database = Database::open(installation.storage()).await.unwrap();
    assert!(grant_exists(&database, "alpha@1.0.0").await);
    assert!(
        !grant_exists(&database, "alpha@1.1.0").await,
        "refused generation left its grant"
    );
    assert_persisted_old_indexes(&database, rows).await;
    let mut database = database;
    database.close().await.unwrap();

    installation.install(&ALPHA);
    let server = installation.load().await.unwrap();
    let mut client = Client::connect(&server).await;
    assert_base_generation_intact(&mut client, rows).await;
    drop(client);
    server.close().await.unwrap();
}

async fn assert_persisted_old_indexes(database: &Database, rows: &Value) {
    let space = DataSpace::plugin("alpha").unwrap();
    let todos = physical_table("alpha", "todos");
    let mut tx = database.read_only().await.unwrap();
    let persisted: Vec<_> = tx
        .query(&todos)
        .with_index("by_owner_created")
        .collect()
        .await
        .unwrap()
        .into_iter()
        .map(|row| space.document(row).unwrap())
        .collect();
    assert_eq!(json!(persisted), *rows);
    assert_eq!(
        tx.query(&todos)
            .with_index("by_owner_text")
            .eq("owner", "ann")
            .eq("text", "a")
            .collect()
            .await
            .unwrap()
            .len(),
        1
    );
    let notes = physical_table("alpha", "notes");
    assert_eq!(
        tx.query(&notes)
            .with_index("by_topic")
            .eq("topic", "t")
            .collect()
            .await
            .unwrap()
            .len(),
        1
    );
    let error = tx
        .query(&todos)
        .with_index("by_owner_created")
        .eq("owner", "ann")
        .eq("created", 10i64)
        .eq("text", "a")
        .collect()
        .await
        .unwrap_err();
    assert!(error.to_string().contains("leading field order"), "{error}");
    tx.rollback().await.unwrap();
    assert_missing_index(database, "alpha", "tags", "by_label").await;
    assert_missing_index(database, "alpha", "todos", "by_owner_only").await;
}

async fn assert_full_index_scan(client: &mut Client, rows: &[(String, String, i64)]) {
    // A full index scan is ordered by (owner, created, _id) in both directions.
    let mut all: Vec<_> = rows
        .iter()
        .map(|(id, owner, created)| (owner.clone(), *created, id.clone()))
        .collect();
    all.sort();
    let ascending: Vec<String> = all.iter().map(|(_, _, id)| id.clone()).collect();
    assert_eq!(
        ids(&client.ok("alpha/todos:scan", json!({"order":"asc"})).await),
        ascending
    );
    let mut descending = ascending.clone();
    descending.reverse();
    assert_eq!(
        ids(&client.ok("alpha/todos:scan", json!({"order":"desc"})).await),
        descending
    );

    // Returned rows are complete documents, not index entries.
    let first = client
        .ok(
            "alpha/todos:range",
            json!({"owner":"ann","order":"asc","limit":1}),
        )
        .await;
    assert_eq!(first[0]["owner"], "ann");
    assert_eq!(first[0]["created"], 5);
    assert_eq!(first[0]["done"], false);
    assert!(first[0]["_creationTime"].is_number());
}

type RangeBounds<'a> = (
    Option<(&'a str, i64)>,
    Option<(&'a str, i64)>,
    bool,
    Option<usize>,
);

fn invalid_range_payloads() -> Vec<(&'static str, Value, Value, &'static str)> {
    let eq = |field: &str, value: Value| json!({"field":field,"value":value});
    let bound =
        |field: &str, op: &str, value: Value| json!({"field":field,"operator":op,"value":value});
    vec![
        (
            "range not on the next field",
            json!({"name":"by_owner_created","eq":[],"range":[bound("created","gt",json!(1))]}),
            json!([]),
            "after the equality prefix",
        ),
        (
            "range on an equality field",
            json!({"name":"by_owner_created","eq":[eq("owner",json!("ann"))],"range":[bound("owner","gt",json!("a"))]}),
            json!([]),
            "after the equality prefix",
        ),
        (
            // The raw form of "eq after range": the equality prefix covers
            // the field the range constrains.
            "eq after range",
            json!({"name":"by_owner_created","eq":[eq("owner",json!("ann")),eq("created",json!(10))],"range":[bound("created","gt",json!(1))]}),
            json!([]),
            "after the equality prefix",
        ),
        (
            "two lower bounds",
            json!({"name":"by_owner_created","eq":[eq("owner",json!("ann"))],"range":[bound("created","gt",json!(1)),bound("created","gte",json!(2))]}),
            json!([]),
            "one lower and one upper",
        ),
        (
            "two upper bounds",
            json!({"name":"by_owner_created","eq":[eq("owner",json!("ann"))],"range":[bound("created","lt",json!(9)),bound("created","lte",json!(8))]}),
            json!([]),
            "one lower and one upper",
        ),
        (
            "where combined with an index",
            json!({"name":"by_owner_created","eq":[],"range":[]}),
            json!([eq("owner", json!("ann"))]),
            "empty where",
        ),
        (
            "unknown range operator",
            json!({"name":"by_owner_created","eq":[eq("owner",json!("ann"))],"range":[bound("created","ne",json!(1))]}),
            json!([]),
            "index must contain",
        ),
        (
            "unknown index payload key",
            json!({"name":"by_owner_created","eq":[],"range":[],"where":[]}),
            json!([]),
            "index must contain",
        ),
        (
            "missing range array",
            json!({"name":"by_owner_created","eq":[]}),
            json!([]),
            "index must contain",
        ),
    ]
}
