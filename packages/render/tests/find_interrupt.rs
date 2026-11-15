//! Regression tests for a QuickJS-NG crash: `Array.prototype.find`, `findIndex`,
//! `findLast` and `findLastIndex` released the current element twice when the
//! interrupt handler fired at the top of their loop. The array later freed the
//! dangling element and the process segfaulted.
//!
//! Here the interrupt is the 250 ms UI deadline that `render` arms around every
//! JS entry (`Js::call`), so a UI handler that is stuck in a `find*` over many
//! objects must produce a deadline error, not take the desktop app down. The
//! fix is one line in QuickJS, carried by the `[patch.crates-io]` entry in the
//! workspace `Cargo.toml`.
//! A regression is a SIGSEGV that would kill the whole test harness, so each
//! method runs in a child process and the parent asserts no signal ended it.
use blitz_dom::Document;
use render::NativeDocument;
use serde_json::json;
use std::{
    process::{Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

const CHILD_ENV: &str = "TKM44_FIND_METHOD";

/// Array length. Deliberately NOT a multiple of 10000: QuickJS polls the
/// interrupt handler once per 10000 loop iterations, and `find*` costs one
/// iteration per element. With a length like 200000 every pass checks the
/// deadline at the same element, and when that element is index 0 nothing has
/// been released yet, so even the unpatched engine survives (observed: the same
/// code crashes or not depending only on how the call is made). An odd length
/// shifts the check position on every pass, so the deadline lands on an element
/// after the first, which is where the double free happens.
const ELEMENTS: u32 = 123_457;

/// Spawns this test binary again to run only `find_deadline_child` for one
/// method, kills it if it hangs, and fails on any non-success exit. A signal is
/// reported separately because it is the exact symptom of the upstream bug.
fn assert_child_survives(method: &str) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "find_deadline_child", "--nocapture"])
        .env(CHILD_ENV, method)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!(
                "{method}: child exceeded 30s watchdog\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        // Watchdog polling only; the test result never depends on this sleep.
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        !killed_by_signal(&output.status),
        "{method}: child process crashed ({}) when the UI deadline fired inside Array.prototype.{method}; \
         the vendored rquickjs-sys find* fix is missing or broken\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.status.success(),
        "{method}: child failed: {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
fn killed_by_signal(status: &ExitStatus) -> bool {
    use std::os::unix::process::ExitStatusExt;
    status.signal().is_some()
}

// Windows reports a crash as an NTSTATUS exit code instead of a signal; the
// `success()` assertion that follows still fails the test in that case.
#[cfg(not(unix))]
fn killed_by_signal(_: &ExitStatus) -> bool {
    false
}

// Purpose: guards against a process crash from the upstream QuickJS-NG
// Array.find double free. The UI deadline expires inside `find`.
#[test]
fn ui_deadline_inside_array_find_does_not_crash_the_process() {
    assert_child_survives("find");
}

// Purpose: guards against a process crash from the upstream QuickJS-NG
// Array.find double free. The UI deadline expires inside `findIndex`.
#[test]
fn ui_deadline_inside_array_find_index_does_not_crash_the_process() {
    assert_child_survives("findIndex");
}

// Purpose: guards against a process crash from the upstream QuickJS-NG
// Array.find double free. The UI deadline expires inside `findLast`.
#[test]
fn ui_deadline_inside_array_find_last_does_not_crash_the_process() {
    assert_child_survives("findLast");
}

// Purpose: guards against a process crash from the upstream QuickJS-NG
// Array.find double free. The UI deadline expires inside `findLastIndex`.
#[test]
fn ui_deadline_inside_array_find_last_index_does_not_crash_the_process() {
    assert_child_survives("findLastIndex");
}

/// A hand-written UI bundle with the four callbacks `render` requires. The
/// `spin` host event is the stuck handler; `mark` queues a visible DOM change
/// so the test can prove the document still renders after the deadline.
fn bundle(method: &str) -> String {
    format!(
        r#"
        // Built at load time (2 s budget), so only the event below can expire.
        const objects = Array.from({{ length: {ELEMENTS} }}, (_, i) => ({{ i }}));
        let pending = [];
        globalThis.__tokamak = {{
            dispatch() {{ return '{{"prevented":false,"stopped":false,"error":null}}'; }},
            host(json) {{
                const event = JSON.parse(json);
                // A native predicate never polls the interrupt itself, so the
                // deadline is only observed at the top of the built-in's loop.
                if (event.topic === 'spin') {{ while (true) objects.{method}(Array.isArray); }}
                if (event.topic === 'mark') {{
                    // Node ids are unique per round: the wire format rejects a reused id.
                    const n = event.payload.round;
                    const element = 1 + 2 * n, text = 2 + 2 * n;
                    pending.push(
                        {{ op: 'element', id: element, tag: 'p' }},
                        {{ op: 'attribute', id: element, name: 'id', value: 'marker' + n }},
                        {{ op: 'text', id: text, value: 'alive' + n }},
                        {{ op: 'insert', id: text, parent: element, before: null }},
                        {{ op: 'insert', id: element, parent: 0, before: null }},
                    );
                }}
            }},
            drain() {{ const batch = JSON.stringify(pending); pending = []; return batch; }},
            dispose() {{}},
        }};
        "#
    )
}

// Purpose: the body of the four tests above. It only runs in a child process,
// because with the upstream bug it segfaults instead of failing.
#[test]
#[ignore = "executed by the ui_deadline_inside_array_find_* tests in a subprocess"]
fn find_deadline_child() {
    let method = std::env::var(CHILD_ENV).expect(
        "run the ui_deadline_inside_array_find_* tests instead; this child needs their watchdog",
    );
    let mut doc = NativeDocument::new(
        "<!doctype html><html><body><div id=\"app\"></div></body></html>",
        &bundle(&method),
    )
    .unwrap();

    // Repeat so a lucky interrupt position cannot hide the bug.
    for round in 0..3 {
        let error = doc
            .host_event(doc.generation(), "spin", json!(null))
            .expect_err("spin never returns, so the UI deadline must expire");
        // `Js::finish_turn` latches an expired turn (including interrupts raised
        // inside promise hooks) into this one canonical deadline error, instead
        // of surfacing QuickJS's raw "interrupted" exception text.
        assert!(
            error
                .to_string()
                .contains("UI JavaScript deadline exceeded"),
            "{method} round {round}: expected a clean deadline error, got {error}"
        );
        // Only the spin handler failed: the document is still alive and a
        // later event can still change what is on screen.
        assert!(
            doc.host_event(doc.generation(), "mark", json!({ "round": round }))
                .unwrap(),
            "{method} round {round}: document refused events after the deadline"
        );
        let marker = doc
            .inner()
            .get_element_by_id(&format!("marker{round}"))
            .unwrap_or_else(|| panic!("{method} round {round}: no DOM update after the deadline"));
        assert_eq!(
            doc.inner().get_node(marker).unwrap().text_content(),
            format!("alive{round}")
        );
    }
}
