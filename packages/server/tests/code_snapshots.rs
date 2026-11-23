#[path = "support/local_driver.rs"]
mod local_driver;

#[test]
fn snapshots_capture_the_fake_agents_worktree_without_touching_the_persons_git_state() {
    local_driver::run("packages/server/tests/code-snapshots-driver.mjs");
}
