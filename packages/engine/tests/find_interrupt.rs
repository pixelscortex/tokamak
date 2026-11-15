//! Regression tests for a QuickJS-NG crash: `Array.prototype.find`, `findIndex`,
//! `findLast` and `findLastIndex` released the current element twice when the
//! interrupt handler (our call deadline) fired at the top of their loop. The
//! array later freed the dangling element and the process segfaulted.
//!
//! The fix is a one-line patch carried in `vendor/rquickjs-sys` (see
//! `TOKAMAK_PATCHES.md` there). A regression is a SIGSEGV, which would kill the
//! whole test harness and hide every other result, so each method runs in a
//! child process and the parent asserts the child was not killed by a signal.
use engine::{Bundle, Error, Limits, OpRegistry, Pool, PoolConfig};
use serde_json::json;
#[path = "support/find_watchdog.rs"]
mod watchdog;
use std::{sync::Arc, time::Duration};
use watchdog::{CHILD_ENV, ELEMENTS};

fn assert_child_survives(method: &str) {
    watchdog::assert_child_survives("find_interrupt_child", method);
}

// Purpose: guards against a process crash from the upstream QuickJS-NG
// Array.find double free. The deadline expires inside `find`.
#[test]
fn deadline_inside_array_find_does_not_crash_the_process() {
    assert_child_survives("find");
}

// Purpose: guards against a process crash from the upstream QuickJS-NG
// Array.find double free. The deadline expires inside `findIndex`.
#[test]
fn deadline_inside_array_find_index_does_not_crash_the_process() {
    assert_child_survives("findIndex");
}

// Purpose: guards against a process crash from the upstream QuickJS-NG
// Array.find double free. The deadline expires inside `findLast`.
#[test]
fn deadline_inside_array_find_last_does_not_crash_the_process() {
    assert_child_survives("findLast");
}

// Purpose: guards against a process crash from the upstream QuickJS-NG
// Array.find double free. The deadline expires inside `findLastIndex`.
#[test]
fn deadline_inside_array_find_last_index_does_not_crash_the_process() {
    assert_child_survives("findLastIndex");
}

// Purpose: the body of the four tests above. It only runs in a child process,
// because with the upstream bug it segfaults instead of failing.
#[test]
#[ignore = "executed by the deadline_inside_array_find_* tests in a subprocess"]
fn find_interrupt_child() {
    let method = std::env::var(CHILD_ENV).expect(
        "run the deadline_inside_array_find_* tests instead; this child needs their watchdog",
    );
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(async {
            // One worker, so every invocation after the interrupted one reuses
            // the worker whose heap held the damaged array.
            let pool = Pool::new(PoolConfig {
                workers: 1,
                queue_capacity: 1,
                limits: Limits {
                    heap_bytes: 128 * 1024 * 1024,
                    // Building the array happens at load time and must not hit
                    // the budget; only the call below is meant to expire.
                    load_timeout: Duration::from_secs(10),
                    call_timeout: Duration::from_millis(150),
                },
            })
            .unwrap();
            // The array is built while loading. `spin` then repeats the search
            // with a native predicate (`Array.isArray` never polls the
            // interrupt itself), so the deadline is only observed at the top of
            // the built-in's own loop with an element already released.
            let spin = Arc::new(
                Bundle::new(
                    format!(
                        "const objects = Array.from({{ length: {ELEMENTS} }}, (_, i) => ({{ i }}));
                         export function spin() {{ while (true) objects.{method}(Array.isArray); }}"
                    ),
                    None,
                )
                .unwrap(),
            );
            let ok = Arc::new(Bundle::new("export function ok(x) { return x; }", None).unwrap());
            let ops = Arc::new(OpRegistry::new());

            // Repeat so a lucky interrupt position cannot hide the bug.
            for round in 0..3 {
                let error = pool
                    .submit(spin.clone(), "spin", json!(null), ops.clone())
                    .unwrap()
                    .await
                    .expect_err("spin never returns, so the call budget must expire");
                assert_eq!(
                    error,
                    Error::Timeout { phase: "call" },
                    "{method} round {round}: expected a clean deadline error"
                );
                assert_eq!(
                    pool.submit(ok.clone(), "ok", json!({ "round": round }), ops.clone())
                        .unwrap()
                        .await
                        .unwrap(),
                    json!({ "round": round }),
                    "{method} round {round}: pool did not recover after the deadline"
                );
            }
        });
}
