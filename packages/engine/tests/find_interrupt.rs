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
use std::{
    process::{Command, ExitStatus, Stdio},
    sync::Arc,
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

/// Spawns this test binary again to run only `find_interrupt_child` for one
/// method, kills it if it hangs, and fails on any non-success exit. A signal is
/// reported separately because it is the exact symptom of the upstream bug.
fn assert_child_survives(method: &str) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "find_interrupt_child",
            "--nocapture",
        ])
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
        "{method}: child process crashed ({}) when the deadline fired inside Array.prototype.{method}; \
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
