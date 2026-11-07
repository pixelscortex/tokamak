//! Launch admission failures must return to the desktop owner before creating
//! an event loop/window, so it can drain its already-started backend. These are
//! deliberately headless; they do not prove GPU presentation or adapter policy.
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

struct Admission(Arc<AtomicUsize>);

impl Drop for Admission {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn rejected_launch(shell: &str, bundle: &str, diagnostic: &str, expected_disposals: usize) {
    let drops = Arc::new(AtomicUsize::new(0));
    let admission = Admission(drops.clone());
    let disposals = Arc::new(AtomicUsize::new(0));
    let observed_disposals = disposals.clone();
    let connected = Arc::new(AtomicBool::new(false));
    let observed = connected.clone();
    let error = render::launch_connected(
        shell,
        bundle,
        "must never open",
        Some(Box::new(move |message| {
            let _keep_owned_until_callback_drops = &admission;
            assert_eq!(message, "disposed");
            observed_disposals.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })),
        move |_| {
            observed.store(true, Ordering::SeqCst);
        },
    )
    .expect_err("invalid initial UI must return an error to the backend owner");
    assert!(
        error.to_string().contains(diagnostic),
        "expected {diagnostic:?}, got {error}"
    );
    assert!(
        !connected.load(Ordering::SeqCst),
        "a producer must not be connected to an unmounted UI"
    );
    assert_eq!(disposals.load(Ordering::SeqCst), expected_disposals);
    assert_eq!(
        drops.load(Ordering::SeqCst),
        1,
        "failed launch must release outward admission, including a callback already installed in QuickJS"
    );
}

#[test]
fn missing_mount_returns_without_connecting_or_retaining_admission() {
    rejected_launch(
        "<html><body></body></html>",
        "throw new Error('bundle must not run without a mount');",
        "Shell needs #app",
        0,
    );
}

#[test]
fn bundle_exception_returns_without_connecting_or_retaining_admission() {
    rejected_launch(
        "<html><body><div id='app'></div></body></html>",
        "throw new Error('independent launch failure');",
        "independent launch failure",
        0,
    );
}

#[test]
fn rejected_initial_mutations_dispose_ui_before_returning_to_owner() {
    // The bridge has been created successfully, but its first consumed batch
    // cannot be applied. Dispose calls the real outward admission callback,
    // allowing its execution to be checked without a test-only production hook.
    rejected_launch(
        "<html><body><div id='app'></div></body></html>",
        r#"
        globalThis.__tokamak = {
            dispatch() { return '{"prevented":false,"stopped":false,"error":null}'; },
            host() {},
            drain() { return 'not valid JSON'; },
            dispose() { __tokamakSend('disposed'); }
        };
        "#,
        "expected",
        1,
    );
}
