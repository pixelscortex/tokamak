#[path = "support/local_driver.rs"]
mod local_driver;

#[test]
fn codex_replays_through_the_server_and_local_worker() {
    // Exercise the installed provider over the same local worker and protocol path
    // as the desktop client, without requiring a real Codex login in CI.
    local_driver::run("plugins/codex/tests/e2e.mjs");
}
