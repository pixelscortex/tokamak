use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn scratch() -> Scratch {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
        "dist/tests/plugins-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    Scratch(path)
}
fn write(root: &Path, directory: &str, definition: Value) -> PathBuf {
    let path = root.join(directory);
    std::fs::create_dir_all(&path).unwrap();
    let mut hashes = BTreeMap::new();
    for (name, bytes) in [
        ("ui.js", "export {};"),
        ("ui.js.map", "{}"),
        ("styles.css", "body {}"),
        ("shell.html", "<html></html>"),
    ] {
        std::fs::write(path.join(name), bytes).unwrap();
        hashes.insert(name, format!("{:x}", Sha256::digest(bytes)));
    }
    std::fs::write(path.join("manifest.json"), serde_json::to_vec(&json!({
        "formatVersion":1, "plugin":definition, "hashes":hashes,
        "entries":{"ui":{"code":"ui.js","map":"ui.js.map","css":"styles.css","shell":"shell.html"}}
    })).unwrap()).unwrap();
    path
}
fn error(root: &Path) -> String {
    Catalog::read(root)
        .err()
        .expect("invalid catalog")
        .to_string()
}
#[test]
fn resolves_dependencies_and_preserves_private_assets() {
    let root = scratch();
    write(&root.0, "z-core", json!({"id":"core","version":"0.1.0"}));
    write(
        &root.0,
        "a-notes",
        json!({"id":"notes","version":"1.0.0",
        "depends":{"core":"^0.1"}, "optional":{"missing":"*"},
        "permissions":["net:example.com"]}),
    );
    let catalog = Catalog::read(&root.0).unwrap();
    assert_eq!(catalog.order, ["core", "notes"]);
    assert!(catalog.can_call("notes", "core"));
    assert!(!catalog.can_call("core", "notes"));
    assert!(catalog.permits_network("notes", "example.com"));
    assert!(!catalog.permits_network("notes", "other.com"));
    assert!(catalog.plugins["notes"].ui_asset("ui.js").is_some());
    assert!(catalog.plugins["notes"].ui_asset("manifest.json").is_none());
    assert!(catalog.plugins["notes"].ui_asset("../ui.js").is_none());
    assert_eq!(Catalog::read(&root.0).unwrap().revision, catalog.revision);
    // Installed generations are snapshots, not files read again on requests.
    std::fs::write(root.0.join("a-notes/ui.js"), "changed").unwrap();
    assert_eq!(
        catalog.plugins["notes"]
            .ui_asset("ui.js")
            .unwrap()
            .read(0, 8192)
            .unwrap(),
        b"export {};"
    );
    assert!(error(&root.0).contains("hash mismatch"));
}
#[test]
fn runner_assets_follow_the_build() {
    let root = scratch();
    let path = write(
        &root.0,
        "with-local",
        json!({"id":"with-local","version":"1.0.0"}),
    );
    let manifest = path.join("manifest.json");
    let mut metadata: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    metadata["entries"]["local"] =
        json!({"entry":"local-entry.js","code":"local.js","map":"local.js.map"});
    for (name, bytes) in [
        ("local-entry.js", ""),
        ("local.js", "export {};"),
        ("local.js.map", "{}"),
    ] {
        std::fs::write(path.join(name), bytes).unwrap();
        metadata["hashes"][name] = format!("{:x}", Sha256::digest(bytes)).into();
    }
    std::fs::write(&manifest, metadata.to_string()).unwrap();

    let catalog = Catalog::read(&root.0).unwrap();
    let assets = &catalog.plugins["with-local"].assets;
    for name in ["local-entry.js", "local.js", "local.js.map"] {
        assert_eq!(
            assets.contains_key(name),
            cfg!(feature = "local-runtime"),
            "{name}"
        );
    }

    std::fs::remove_file(path.join("local.js")).unwrap();
    if cfg!(feature = "local-runtime") {
        let error = Artifact::read(&path)
            .err()
            .expect("missing local bundle accepted");
        assert!(error.to_string().contains("local.js"), "{error}");
    } else {
        assert_eq!(Catalog::read(&root.0).unwrap().revision, catalog.revision);
    }
}

#[test]
fn rejects_missing_incompatible_conflicting_cyclic_and_duplicate_plugins() {
    for (a, b, expected) in [
        (
            json!({"id":"a","version":"1.0.0","depends":{"missing":"*"}}),
            json!({"id":"b","version":"1.0.0"}),
            "Missing dependency",
        ),
        (
            json!({"id":"a","version":"1.0.0","depends":{"b":"^2"}}),
            json!({"id":"b","version":"1.0.0"}),
            "Incompatible dependency",
        ),
        (
            json!({"id":"a","version":"1.0.0","optional":{"b":"^2"}}),
            json!({"id":"b","version":"1.0.0"}),
            "Incompatible dependency",
        ),
        (
            json!({"id":"a","version":"1.0.0","breaks":{"b":"^1"}}),
            json!({"id":"b","version":"1.0.0"}),
            "Plugin conflict",
        ),
        (
            json!({"id":"a","version":"1.0.0","depends":{"b":"*"}}),
            json!({"id":"b","version":"1.0.0","depends":{"a":"*"}}),
            "cycle",
        ),
        (
            json!({"id":"a","version":"1.0.0"}),
            json!({"id":"a","version":"2.0.0"}),
            "Duplicate",
        ),
        (
            json!({"id":"a","version":"1.0.0","api":"tokamak@^9"}),
            json!({"id":"b","version":"1.0.0"}),
            "Incompatible host API",
        ),
    ] {
        let root = scratch();
        write(&root.0, "first", a);
        write(&root.0, "second", b);
        assert!(error(&root.0).contains(expected), "{expected}");
    }
}
#[test]
fn rejects_unbuilt_and_escaping_artifacts() {
    let root = scratch();
    let project = root.0.join("unbuilt");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("package.json"), "{}").unwrap();
    assert!(error(&root.0).contains("not been built"));
    let path = write(&root.0, "artifact", json!({"id":"a","version":"1.0.0"}));
    let manifest = path.join("manifest.json");
    let mut metadata: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    metadata["entries"]["ui"]["code"] = "../outside.js".into();
    std::fs::write(&manifest, metadata.to_string()).unwrap();
    assert!(
        Artifact::read(&path)
            .err()
            .unwrap()
            .to_string()
            .contains("inside")
    );
}

#[test]
fn catalog_refuses_a_plugin_with_the_reserved_auth_id() {
    let root = scratch();
    write(
        &root.0,
        "external-identity",
        json!({"id":"auth","version":"1.0.0"}),
    );
    assert!(error(&root.0).contains("auth is built into the server"));
}

#[cfg(unix)]
#[test]
fn rejects_asset_symlinks_outside_artifact() {
    let root = scratch();
    let path = write(&root.0, "artifact", json!({"id":"a","version":"1.0.0"}));
    let outside = root.0.join("outside.js");
    std::fs::write(&outside, "export {};").unwrap();
    std::fs::remove_file(path.join("ui.js")).unwrap();
    std::os::unix::fs::symlink(outside, path.join("ui.js")).unwrap();
    assert!(
        Artifact::read(&path)
            .err()
            .unwrap()
            .to_string()
            .contains("symlink")
    );
}

fn reference_generation(catalog: Catalog, target: &str) -> Loaded {
    let inspected = [
        ("owner", json!({"tables":{"items":{}}})),
        (
            "dependent",
            json!({"tables":{"links":{"description":{
                "kind":"object", "fields":{"item":{"kind":"ref","table":target}}
            }}}}),
        ),
    ]
    .into_iter()
    .filter(|(id, _)| catalog.plugins.contains_key(*id))
    .map(|(id, schema)| {
        (
            id.to_owned(),
            crate::service::InspectedBundle {
                descriptor: json!({"schema":schema}),
                kinds: BTreeMap::new(),
                visibility: BTreeMap::new(),
            },
        )
    })
    .collect();

    Loaded {
        triggers: Default::default(),
        query_hooks: BTreeMap::new(),
        transaction_bundles: BTreeMap::new(),
        catalog,
        inspected,
        targets: BTreeMap::new(),
        descriptor: Value::Null,
        catalog_text: String::new(),
        skipped: BTreeMap::new(),
        action_sources: BTreeMap::new(),
        contracts: BTreeMap::new(),
    }
}

fn reference_catalog(root: &Path, depends: Value) -> Catalog {
    write(root, "owner", json!({"id":"owner","version":"1.0.0"}));
    write(
        root,
        "dependent",
        json!({"id":"dependent","version":"1.0.0","depends":depends}),
    );
    Catalog::read(root).unwrap()
}

#[tokio::test]
async fn installed_schemas_cannot_reference_undeclared_targets() {
    use crate::data::{Database, Storage};

    let root = scratch();
    let mut database = Database::open(Storage::Memory).await.unwrap();
    for (depends, target, reason) in [
        (json!({}), "owner.items", "the owner must be in depends"),
        (json!({}), "tokamak.host.grants", "the host is reserved"),
        (
            json!({"owner":"*"}),
            "owner.missing",
            "the owner does not declare that table",
        ),
    ] {
        let mut loaded = reference_generation(reference_catalog(&root.0, depends), target);
        let error = loaded
            .record_startup_grants(&database)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(&format!(
                "Plugin dependent cannot reference {target}: {reason}"
            )),
            "{error}"
        );
    }
    database.close().await.unwrap();
}

async fn seed_ref_rows(database: &crate::data::Database) -> (crate::data::Id, crate::data::Id) {
    use crate::data::{Table, json_object};

    let owner = DataSpace::plugin("owner").unwrap();
    let items = owner.table(&Table::new("items").unwrap()).unwrap();
    let dependent = DataSpace::plugin("dependent").unwrap();
    let links = dependent.table(&Table::new("links").unwrap()).unwrap();

    let mut tx = database.begin().await.unwrap();
    let item = tx.insert(&items, Default::default()).await.unwrap();
    let value = json_object(&json!({"item": owner.present_id(&item).unwrap()})).unwrap();
    let link = tx.insert(&links, value).await.unwrap();
    tx.commit().await.unwrap();

    (item, link)
}

#[tokio::test]
async fn resetting_schema_cascades_through_the_normal_delete_path() {
    use crate::data::{Database, Storage};

    let root = scratch();
    let store = tempfile::tempdir().unwrap();
    let storage = || Storage::Disk(store.path().join("store"));
    let mut database = Database::open(storage()).await.unwrap();
    let (item, link) = seed_ref_rows(&database).await;
    database.close().await.unwrap();

    let mut database = Database::open(storage()).await.unwrap();
    let mut loaded = reference_generation(
        reference_catalog(&root.0, json!({"owner":"*"})),
        "owner.items",
    );
    assert_eq!(loaded.catalog.order, ["owner", "dependent"]);
    loaded.record_startup_grants(&database).await.unwrap();
    loaded
        .reset_startup_schema(&database, "owner", "incompatible owner schema")
        .await
        .unwrap();

    let mut read = database.read_only().await.unwrap();
    assert!(read.get(&item).await.unwrap().is_none());
    assert!(read.get(&link).await.unwrap().is_none());
    read.commit().await.unwrap();
    database.close().await.unwrap();
}

#[tokio::test]
async fn reload_clears_references_of_a_removed_plugin() {
    use crate::data::{Database, Storage};

    let root = scratch();
    let mut database = Database::open(Storage::Memory).await.unwrap();
    let mut previous = reference_generation(
        reference_catalog(&root.0, json!({"owner":"*"})),
        "owner.items",
    );
    previous.record_startup_grants(&database).await.unwrap();
    let (item, link) = seed_ref_rows(&database).await;

    std::fs::rename(root.0.join("dependent"), root.0.join(".disabled")).unwrap();
    let mut current = reference_generation(Catalog::read(&root.0).unwrap(), "owner.items");
    assert_eq!(current.catalog.order, ["owner"]);
    current
        .record_grants(&database, Some(&previous))
        .await
        .unwrap();

    let mut tx = database.begin().await.unwrap();
    tx.delete(&item).await.unwrap();
    assert!(tx.get(&link).await.unwrap().is_some());
    tx.commit().await.unwrap();
    database.close().await.unwrap();
}
