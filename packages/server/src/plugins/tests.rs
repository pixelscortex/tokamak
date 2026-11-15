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
fn resolves_dependencies_optional_providers_and_private_assets() {
    let root = scratch();
    write(
        &root.0,
        "z-core",
        json!({"id":"core","version":"0.1.0","provides":["ai"]}),
    );
    write(
        &root.0,
        "a-notes",
        json!({"id":"notes","version":"1.0.0",
        "depends":{"core":"^0.1"}, "optional":{"missing":"*"}, "consumes":["ai"],
        "permissions":["net:example.com"]}),
    );
    let catalog = Catalog::read(&root.0).unwrap();
    assert_eq!(catalog.order, ["core", "notes"]);
    assert_eq!(catalog.providers("notes", "ai").unwrap(), ["core"]);
    assert!(catalog.providers("notes", "private").is_err());
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
    let mut metadata: Value =
        serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
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
