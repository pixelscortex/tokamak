//! TKM-11 native SDK write → awaited close → reopen → snapshot for headless.
//! Reuses the small SDK bridge fixture and production connection, not a second
//! copy of the app's input harness. Existing native.rs covers real UI controls.
#[path = "support/embedded.rs"]
mod connection;
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;

use engine::{Bundle, PoolConfig};
use render::{HostMailbox, NativeDocument};
use serde_json::{Value, json};
use server::{Backend, BackendConfig, data::Storage};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;

// Standalone cargo test also works after app:test has prepared the bundles.
// Only the Bun orchestrator retains this directory for the headless phase.
struct Scratch(Option<PathBuf>);
impl Drop for Scratch {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

fn native_roundtrip(root: &Path, write: bool) -> Value {
    // app:check compiles test targets before app:test prepares this fixture.
    // Read it only for execution, and fail before opening storage if absent.
    let bridge =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("dist/tests/bridge.js"))
            .expect(
                "native E2E requires the SDK bridge fixture; run moon run :e2e or app:test first",
            );
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let backend = rt
        .block_on(Backend::start(BackendConfig {
            storage: Storage::Disk(root.join("store")),
            bundle: Arc::new(
                Bundle::new(
                    include_str!("../dist/tests/record/dist/bundle.js"),
                    Some(include_str!("../dist/tests/record/dist/bundle.js.map")),
                )
                .unwrap(),
            ),
            javascript: PoolConfig::default(),
        }))
        .unwrap();
    let session = rt.block_on(backend.connect()).unwrap();
    let (send, receive) = connection::admission();
    let mut doc = NativeDocument::new_connected(
        include_str!("../dist/tests/record/dist/shell.html"),
        &bridge,
        Some(send),
    )
    .unwrap();
    let (host, mut mailbox) = HostMailbox::new(&doc, || {});
    let (ready, receiver) = oneshot::channel();
    assert!(ready.send(host).is_ok());
    let (stop, stopped) = oneshot::channel();
    let worker = rt.spawn(connection::serve(
        backend, session, receive, receiver, stopped,
    ));
    // No panic before the worker has been joined: failure must still release
    // the disk lock. Poll delays are pacing only; actual SDK replies are proof.
    let result = exercise_native_roundtrip(&mut doc, &mut mailbox, write);
    drop(doc);
    drop(mailbox);
    let _ = stop.send(());
    rt.block_on(async { tokio::time::timeout(Duration::from_secs(25), worker).await })
        .expect("native shutdown exceeded 25s")
        .unwrap()
        .unwrap();
    result.unwrap()
}

// Scenarios 3/4: disk bytes are authored through actual native SDK plumbing.
// Headless is started by Bun ONLY after both awaited native shutdowns return.
#[test]
fn native_sdk_persists_and_exports_exact_rows_after_reopen() {
    let target = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("target");
    let provided = std::env::var_os("TKM_E2E_ROOT").map(PathBuf::from);
    let root = provided.clone().unwrap_or_else(|| {
        target.join(format!(
            "e2e/native-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    });
    let _cleanup = Scratch(provided.is_none().then(|| root.clone()));
    let root = root.as_path();
    assert!(
        root.starts_with(&target),
        "native e2e storage must remain inside the worktree target"
    );
    std::fs::create_dir_all(root).unwrap();
    let written = native_roundtrip(root, true);
    assert_eq!(written.as_array().unwrap().len(), 1);
    assert_eq!(written[0]["title"], "TKM-11 native persisted ✓");
    assert_eq!(written[0]["done"], false);
    assert_eq!(native_roundtrip(root, false), written);
    std::fs::write(
        root.join("native-rows.json"),
        serde_json::to_vec(&written).unwrap(),
    )
    .unwrap();
}

fn exercise_native_roundtrip(
    doc: &mut NativeDocument,
    mailbox: &mut HostMailbox,
    write: bool,
) -> Result<Value, String> {
    {
        let mut wait = |predicate: &dyn Fn(&NativeDocument) -> bool| -> Result<(), String> {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                mailbox.drain(doc).map_err(|e| e.to_string())?;
                if let Some(error) = doc.take_error() {
                    return Err(error.to_string());
                }
                if predicate(doc) {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(format!(
                        "native SDK timeout: {}",
                        support::text(doc, "trace")
                    ));
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        };
        wait(&|doc| support::text(doc, "trace").contains("second"))?;
    }
    if write {
        doc.host_event(
            doc.generation(),
            "write:title",
            json!("TKM-11 native persisted ✓"),
        )
        .map_err(|e| e.to_string())?;
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        mailbox.drain(doc).map_err(|e| e.to_string())?;
        let trace = support::text(doc, "trace");
        if trace.contains("rejected") || trace.contains("error:") {
            return Err(format!("native SDK failed: {trace}"));
        }
        if !write || trace.contains("title:accepted") {
            break;
        }
        if Instant::now() >= deadline {
            return Err(format!("write outcome unknown: {trace}"));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    doc.host_event(doc.generation(), "read", Value::Null)
        .map_err(|e| e.to_string())?;
    loop {
        mailbox.drain(doc).map_err(|e| e.to_string())?;
        let trace = support::text(doc, "trace");
        if trace.contains("query:reply") {
            return serde_json::from_str(&support::text(doc, "readback"))
                .map_err(|e| e.to_string());
        }
        if Instant::now() >= deadline {
            return Err(format!("read timeout: {trace}"));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
