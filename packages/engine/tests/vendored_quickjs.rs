//! Wiring check for the patched QuickJS bindings.
//!
//! The workspace routes `rquickjs-sys` to a pinned commit of a fork through
//! `[patch.crates-io]` to carry one upstream fix (QuickJS-NG `e22ce4de`, the
//! `Array.prototype.find*` double free that crashes the process when a deadline
//! fires inside the loop; see the comment in the workspace `Cargo.toml`). The
//! behavioural tests in `find_interrupt.rs` only prove the fix is active in the
//! build that runs them. This cheap file check names the cause directly when
//! the patch is dropped by accident, for example by a `cargo update` that
//! "cleans up" the entry.
//!
//! It reads `Cargo.lock` instead of running `cargo metadata`: the lockfile is
//! what `--locked` builds are held to, and that avoids a nested cargo process
//! inside a cargo test.
use std::path::{Path, PathBuf};

const FORK: &str = "https://github.com/JustKira/rquickjs";

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
// Array.find double free. If the `[patch.crates-io]` entry is removed, Cargo
// resolves the registry crate again and the lockfile entry for `rquickjs-sys`
// points back at crates.io.
#[test]
fn rquickjs_sys_resolves_to_the_patched_fork() {
    let root = workspace_root();

    let manifest = read(&root.join("Cargo.toml"));
    assert!(
        manifest.contains("[patch.crates-io]")
            && manifest.lines().any(|l| {
                let l = l.trim();
                l.starts_with("rquickjs-sys") && l.contains(FORK) && l.contains("rev =")
            }),
        "Cargo.toml must keep `[patch.crates-io] rquickjs-sys` pinned to a commit of {FORK}; \
         without it the QuickJS Array.find crash fix is lost"
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
        entry.contains(&format!("source = \"git+{FORK}")),
        "rquickjs-sys does not resolve to the patched fork; \
         the QuickJS Array.find crash fix is not in this build:\n{entry}"
    );
}
