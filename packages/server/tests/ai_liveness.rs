#[path = "support/local_driver.rs"]
mod local_driver;

/// A turn whose app went away, end to end with the fake agent: the real server
/// binary, the real builds, real windows and local parts (see
/// ai-liveness-driver.mjs). Waits out the real 45-second limit, so it is slow.
#[test]
fn a_silent_turn_is_interrupted_and_a_slow_one_is_not() {
    local_driver::run("packages/server/tests/ai-liveness-driver.mjs");
}
