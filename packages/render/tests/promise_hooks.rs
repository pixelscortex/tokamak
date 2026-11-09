//! QuickJS promise hooks run native code *inside* JavaScript's own machinery:
//! after a thenable job throws, while a native turn's deadline is armed, and
//! while a hook may itself create promises. These tests drive the public
//! `NativeDocument` API with a hand-written bundle whose `__tokamak` object has
//! hostile hooks, because no well-behaved renderer bundle can reach these paths.
//!
//! The bundle reports what plugin code observed through `__tokamakSend`, so an
//! assertion failure shows the value that JavaScript actually received.
use render::NativeDocument;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

// `host` is the scenario entry point; `promiseHook` misbehaves according to the
// armed mode. `drain` returns an empty mutation batch so the bridge stays valid.
const BUNDLE: &str = r#"
let mode = "plain";
let hookCalls = 0;
const report = value => __tokamakSend(JSON.stringify(value));
// A thenable whose `then` throws makes QuickJS call the AFTER hook with the
// thenable's exception still pending, then reject with whatever is pending.
const failingThenable = { then() { throw new Error("thenable failure"); } };
async function observeRejection() {
  try { await failingThenable; report({ settled: "resolved" }); }
  catch (error) {
    report({ reason: String(error), isError: error instanceof Error, message: error && error.message });
  }
}
globalThis.__tokamak = Object.freeze({
  dispatch() { return "{}"; },
  drain() { return "[]"; },
  dispose() {},
  host(json) {
    mode = JSON.parse(json).payload.mode;
    hookCalls = 0;
    if (mode === "hook-throws" || mode === "hook-consumes") void observeRejection();
    // One promise creation is enough to enter the INIT hook from plain code.
    if (mode === "hook-spins" || mode === "hook-reenters") Promise.resolve();
    report({ reached: mode });
  },
  promiseHook(kind) {
    hookCalls++;
    if (mode === "hook-throws" && kind === "after") throw new Error("hook failure");
    // A caught throw inside the hook consumes QuickJS' single pending-exception
    // slot, which is exactly what an uncareful native wrapper would then read.
    if (mode === "hook-consumes" && kind === "after") { try { throw 0; } catch {} }
    if (mode === "hook-spins" && kind === "init") for (;;) {}
    if (mode === "hook-reenters" && kind === "init" && hookCalls < 1000) Promise.resolve();
    if (mode === "hook-reenters") report({ hookCalls });
  },
});
"#;

struct Harness {
    doc: NativeDocument,
    sent: Arc<Mutex<Vec<Value>>>,
}

fn harness() -> Harness {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let captured = sent.clone();
    let doc = NativeDocument::new_connected(
        "<!doctype html><html><body><div id=\"app\"></div></body></html>",
        BUNDLE,
        Some(Box::new(move |message| {
            captured
                .lock()
                .unwrap()
                .push(serde_json::from_str(&message).unwrap());
            Ok(())
        })),
    )
    .unwrap();
    Harness { doc, sent }
}

impl Harness {
    fn drive(&mut self, mode: &str) -> render::Result<bool> {
        self.sent.lock().unwrap().clear();
        let generation = self.doc.generation();
        self.doc
            .host_event(generation, "scenario", json!({ "mode": mode }))
    }
    fn reports(&self) -> Vec<Value> {
        self.sent.lock().unwrap().clone()
    }
    /// The one rejection reason the plugin's `catch` block observed.
    fn rejection(&self) -> Value {
        let reports = self.reports();
        reports
            .iter()
            .find(|report| report.get("reason").is_some() || report.get("settled").is_some())
            .unwrap_or_else(|| panic!("plugin never observed the rejection: {reports:?}"))
            .clone()
    }
}

// Prevents a failing promise hook from replacing the error that was already
// pending. Without isolation, QuickJS rejects the awaiting plugin code with the
// *hook's* exception, so a native bookkeeping failure masquerades as the
// plugin's own error and the real cause is lost.
#[test]
fn a_throwing_hook_does_not_replace_the_pending_thenable_error() {
    let mut harness = harness();
    assert!(harness.drive("hook-throws").unwrap());
    let rejection = harness.rejection();
    assert_eq!(rejection["message"], "thenable failure", "{rejection}");
    assert_eq!(rejection["isError"], true, "{rejection}");
}

// Prevents QuickJS' internal "uninitialized" marker reaching plugin code. A hook
// that merely catches its own exception empties the pending-exception slot;
// unless the native wrapper saves and restores it, the engine rejects the
// awaiting code with that marker instead of the thenable's real error.
#[test]
fn a_hook_that_consumes_the_pending_exception_never_leaks_an_uninitialized_value() {
    let mut harness = harness();
    assert!(harness.drive("hook-consumes").unwrap());
    let rejection = harness.rejection();
    assert_eq!(rejection["message"], "thenable failure", "{rejection}");
    assert_eq!(rejection["isError"], true, "{rejection}");
    assert_ne!(rejection["reason"], "undefined", "{rejection}");
}

// Prevents an interrupt that fires *inside* a hook from being swallowed. A void
// C hook cannot return the engine's interrupt, so the budget must be latched and
// fail the whole native turn quickly; otherwise a spinning hook only costs its
// own slice and the turn reports success after blowing its deadline.
#[test]
fn an_interrupt_inside_a_hook_fails_the_turn_with_bounded_overrun() {
    let mut harness = harness();
    let started = Instant::now();
    let error = harness.drive("hook-spins").unwrap_err();
    let elapsed = started.elapsed();
    assert!(
        error.0.contains("deadline exceeded"),
        "turn must fail on the blown deadline, got: {error}"
    );
    // The native turn budget is 250 ms; allow generous scheduling slack but
    // reject an unbounded spin.
    assert!(
        elapsed < Duration::from_secs(3),
        "hook interrupt overran its bounded budget: {elapsed:?}"
    );
    // The latch belongs to that turn only: the same window keeps working.
    assert!(harness.drive("plain").unwrap());
    assert_eq!(harness.reports(), vec![json!({ "reached": "plain" })]);
}

// Prevents recursive hook invocation: a hook that creates promises re-enters the
// hook. Native state is handed out as `&mut`, so re-entrancy must be suppressed
// (one level runs, nested creations are skipped) rather than recursing until the
// stack overflows.
#[test]
fn promise_creation_inside_a_hook_does_not_recurse_into_the_hook() {
    let mut harness = harness();
    assert!(harness.drive("hook-reenters").unwrap());
    let calls = harness
        .reports()
        .iter()
        .filter_map(|report| report["hookCalls"].as_u64())
        .max()
        .expect("hook reported its call count");
    assert!(calls <= 8, "hook re-entered itself {calls} times");
}
