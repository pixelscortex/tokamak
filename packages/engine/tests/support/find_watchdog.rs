use std::{
    process::{Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

pub const CHILD_ENV: &str = "TKM44_FIND_METHOD";

/// Array length. Deliberately NOT a multiple of 10000: QuickJS polls the
/// interrupt handler once per 10000 loop iterations, and `find*` costs one
/// iteration per element. With a length like 200000 every pass checks the
/// deadline at the same element, and when that element is index 0 nothing has
/// been released yet, so even the unpatched engine survives (observed: the same
/// code crashes or not depending only on how the call is made). An odd length
/// shifts the check position on every pass, so the deadline lands on an element
/// after the first, which is where the double free happens.
pub const ELEMENTS: u32 = 123_457;

/// Spawns this test binary again to run only `find_interrupt_child` for one
/// method, kills it if it hangs, and fails on any non-success exit. A signal is
/// reported separately because it is the exact symptom of the upstream bug.
pub fn assert_child_survives(child_test: &str, method: &str) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            child_test,
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

