use engine::{Bundle, Json};
use std::{future::Future, path::PathBuf, process::Command, sync::{Arc, OnceLock}, time::Duration};

pub fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().into()
}

pub fn bun_script(name: &str) -> Command {
    let mut command = Command::new("proto");
    command.args(["run", "bun", "--"]).arg(format!("packages/server/tests/{name}")).current_dir(root());
    command
}

// Keep production-sized Tokio and QuickJS stacks.
pub fn run(f: impl Future<Output = ()>, seconds: u64) {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(seconds), f).await.expect("acceptance outer timeout");
        });
}

pub fn bundle() -> Arc<Bundle> {
    static BUILT: OnceLock<Arc<Bundle>> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            let output = bun_script("build-feature.mjs")
                .arg("--load")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "real SDK feature build failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            // The builder transfers the contents, then removes only its own
            // temporary directory, even if loading/parsing here subsequently fails.
            let stdout = String::from_utf8(output.stdout).unwrap();
            let built: Json = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
            Arc::new(
                Bundle::new(
                    built["code"].as_str().unwrap(),
                    Some(built["map"].as_str().unwrap()),
                )
                .unwrap(),
            )
        })
        .clone()
}

