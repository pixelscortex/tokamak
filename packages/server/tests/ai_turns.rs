#[path = "support/local_driver.rs"]
mod local_driver;

/// ai's turns end to end with the fake agent: the real server binary, the real
/// builds of chat, ai and the fake agent plugin, real windows, the real local
/// part and the replay program (see ai-turns-driver.mjs and e2e/fake-agent).
#[test]
fn a_turn_streams_the_fake_agents_reply_into_the_thread() {
    local_driver::run("packages/server/tests/ai-turns-driver.mjs");
}
