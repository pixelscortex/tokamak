#[path = "support/local_driver.rs"]
mod local_driver;

#[test]
fn a_turns_change_card_review_panel_and_branch_come_from_local_git() {
    local_driver::run("packages/server/tests/code-changes-driver.mjs");
}
