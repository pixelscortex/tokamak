#[path = "support/local_driver.rs"]
mod local_driver;

/// Chat on the new API through the real server binary, the real chat build,
/// two real clients and chat's real local part (see chat-threads-driver.mjs).
#[test]
fn chat_threads_start_on_first_send_and_reach_a_second_window() {
    local_driver::run("packages/server/tests/chat-threads-driver.mjs");
}
