//! Wiring checks for the vendored QuickJS bindings.
//!
//! The workspace routes `rquickjs-sys` to `vendor/rquickjs-sys` through
//! `[patch.crates-io]` to carry one upstream fix (QuickJS-NG `e22ce4de`, the
//! `Array.prototype.find*` double free that crashes the process when a deadline
//! fires inside the loop; see `vendor/rquickjs-sys/TOKAMAK_PATCHES.md`). The
//! behavioural tests in `find_interrupt.rs` only prove the fix is active in the
//! build that runs them. These cheap file checks name the cause directly when
//! the patch is dropped by accident, for example by a `cargo update` that
//! "cleans up" the entry or by re-vendoring the crate without the change.
//!
//! They read `Cargo.lock` instead of running `cargo metadata`: for a path
//! dependency Cargo records no `source` or `checksum`, and the lockfile is what
//! `--locked` builds are held to. That avoids a nested cargo process inside a
//! cargo test.
use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

// Purpose: guards against a process crash from the upstream QuickJS-NG
// Array.find double free. If the `[patch.crates-io]` entry is removed or
// repointed, Cargo resolves the registry crate again and the lockfile entry
// for `rquickjs-sys` regains a `source`.
#[test]
fn rquickjs_sys_resolves_to_the_vendored_path() {
    let root = workspace_root();

    let manifest = read(&root.join("Cargo.toml"));
    assert!(
        manifest.contains("[patch.crates-io]")
            && manifest.lines().any(
                |l| l.trim().replace(' ', "") == r#"rquickjs-sys={path="vendor/rquickjs-sys"}"#
            ),
        "Cargo.toml must keep `[patch.crates-io] rquickjs-sys = {{ path = \"vendor/rquickjs-sys\" }}`; \
         without it the QuickJS Array.find crash fix is lost (see vendor/rquickjs-sys/TOKAMAK_PATCHES.md)"
    );

    let lock = read(&root.join("Cargo.lock"));
    let entry = lock
        .split("[[package]]")
        .find(|block| {
            block
                .lines()
                .any(|l| l.trim() == r#"name = "rquickjs-sys""#)
        })
        .expect("Cargo.lock has no rquickjs-sys package");
    assert!(
        !entry.contains("source =") && !entry.contains("checksum ="),
        "rquickjs-sys resolves to a registry crate, not vendor/rquickjs-sys; \
         the QuickJS Array.find crash fix is not in this build:\n{entry}"
    );

    assert!(
        root.join("vendor/rquickjs-sys/Cargo.toml").is_file(),
        "vendor/rquickjs-sys is missing"
    );
}

// Purpose: guards against a process crash from the upstream QuickJS-NG
// Array.find double free. The vendored C source must still reset `val` after
// releasing it inside `js_array_find` (the function behind find, findIndex,
// findLast and findLastIndex).
#[test]
fn vendored_quickjs_resets_the_released_find_value() {
    let source = read(&workspace_root().join("vendor/rquickjs-sys/quickjs/quickjs.c"));
    let start = source
        .find("static JSValue js_array_find(")
        .expect("js_array_find not found in vendored quickjs.c");
    // A top-level function ends at the first closing brace in column 0.
    let body = &source[start..];
    let body = &body[..body.find("\n}\n").expect("js_array_find has no end")];
    let squashed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        squashed.contains("JS_FreeValue(ctx, val); val = JS_UNDEFINED;"),
        "vendored quickjs.c lost the upstream e22ce4de fix: js_array_find must set \
         `val = JS_UNDEFINED;` right after freeing it; otherwise a deadline firing inside \
         Array.prototype.find* double-frees the element and crashes the process"
    );
}
