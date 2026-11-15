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
#[path = "../../engine/tests/support/find_watchdog.rs"]
mod watchdog;
use watchdog::{CHILD_ENV, ELEMENTS};

fn assert_child_survives(method: &str) {
    watchdog::assert_child_survives("find_deadline_child", method);
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
            error.to_string().contains("UI JavaScript deadline exceeded"),
            "{method} round {round}: expected a clean deadline error, got {error}"
        );
        // Only the spin handler failed: the document is still alive and a
        // later event can still change what is on screen.
        assert!(
            doc.host_event(doc.generation(), "mark", json!({ "round": round })).unwrap(),
            "{method} round {round}: document refused events after the deadline"
        );
        let marker = doc
            .inner()
            .get_element_by_id(&format!("marker{round}"))
            .unwrap_or_else(|| panic!("{method} round {round}: no DOM update after the deadline"));
        assert_eq!(doc.inner().get_node(marker).unwrap().text_content(), format!("alive{round}"));
    }
}
