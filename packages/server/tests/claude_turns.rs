#[path = "support/local_driver.rs"]
mod local_driver;

/// Runs the Claude stream-JSON recordings through the real server and provider.
#[test]
fn claude_turns_replay_locally_against_the_real_server() {
    local_driver::replay("plugins/claude/tests/turns.mjs");
}
