#[path = "support/local_driver.rs"]
mod local_driver;

/// ai's agent, model and session per thread, end to end with two fake agents:
/// the real server binary, the real builds, real windows, the real local part
/// and the replay program (see ai-threads-driver.mjs and e2e/fake-agent).
#[test]
fn a_thread_keeps_its_choices_and_carries_its_conversation_across_sessions_and_agents() {
    local_driver::run("packages/server/tests/ai-threads-driver.mjs");
}
