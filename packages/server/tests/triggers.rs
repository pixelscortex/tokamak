#[expect(dead_code, reason = "the script builds and loads its own fixtures")]
#[path = "support/sdk.rs"]
mod sdk;

#[test]
fn table_triggers_are_typed_scoped_and_atomic() {
    sdk::run(
        async {
            let status = tokio::process::Command::from(sdk::bun_script("triggers-driver.mjs"))
                .arg(env!("CARGO_BIN_EXE_tokamak-server"))
                .kill_on_drop(true)
                .status()
                .await
                .expect("start trigger acceptance driver");
            assert!(status.success(), "trigger driver exited: {status}");
        },
        120,
    );
}
