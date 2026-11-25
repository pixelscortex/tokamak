use engine::{Limits, Pool, PoolConfig};
use serde_json::{Value, json};
use server::{
    Server, Session,
    data::{Database, Storage},
    identity::{Role, User},
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};

struct Driver(Child);

impl Drop for Driver {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn build_fixture(workspace: &Path, installation: &Path, id: &str) {
    let source = workspace
        .join("packages/server/tests/fixtures/query-hooks")
        .join(id);
    let output = Command::new("proto")
        .args(["run", "bun", "--", "packages/build/src/build.ts"])
        .arg(&source)
        .current_dir(workspace)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Build {id}:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let target = installation.join(id);
    fs::create_dir(&target).unwrap();
    for entry in fs::read_dir(source.join("dist")).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), target.join(entry.file_name())).unwrap();
    }

    if id == "moderation" {
        let path = target.join("transactions.js");
        let bundle = fs::read_to_string(&path).unwrap();
        // Send a write directly through the stage bridge, bypassing the SDK's database reader.
        let export = "  invoke_hook,";
        assert!(bundle.contains(export));
        let bundle = bundle.replace(export, "  test_invoke_hook as invoke_hook,");
        let bundle = bundle
            + r#"
function test_invoke_hook(request, host) {
  if (request.stage === "before" && request.args.mode === "raw-write")
    return host.op("db.insert", { table: "bans", value: { name: "Alice" } });
  return invoke_hook(request, host);
}
"#;
        fs::write(path, &bundle).unwrap();
        let path = target.join("manifest.json");
        let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        manifest["hashes"]["transactions.js"] = json!(format!("{:x}", Sha256::digest(bundle)));
        fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    }
}

#[tokio::test]
async fn query_hooks_apply_to_window_live_and_server_calls() {
    const CHILD: &str = "TOKAMAK_QUERY_HOOKS_CAPTURE";
    if std::env::var_os(CHILD).is_none() && std::env::var_os("TOKAMAK_HOOK_BENCHMARK").is_none() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "query_hooks_apply_to_window_live_and_server_calls",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "{}\n{stderr}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            stderr.contains(
                "Skipping hook moderation/policy:staleTarget: target team/users:renamed is missing"
            ),
            "{stderr}"
        );
        assert!(
            stderr.contains(
                "Skipping hook moderation/points:removedPoint: target team/points:readPoint#old is missing"
            ),
            "{stderr}"
        );
        return;
    }

    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let installation = tempfile::tempdir().unwrap();
    for id in ["team", "moderation", "z-extra"] {
        build_fixture(&workspace, installation.path(), id);
    }

    let pool = Arc::new(
        Pool::new(PoolConfig {
            workers: 1,
            limits: Limits {
                load_timeout: Duration::from_secs(5),
                call_timeout: Duration::from_secs(5),
                ..Limits::default()
            },
            ..PoolConfig::default()
        })
        .unwrap(),
    );
    let db = Database::open(Storage::Memory).await.unwrap();
    let server = Server::load_plugins(db, pool, installation.path())
        .await
        .unwrap();
    let mut session = server
        .connect_as(User {
            id: "member-1".into(),
            name: "Test Member".into(),
            role: Role::Member,
        })
        .await
        .unwrap();
    run_driver(&workspace, installation.path(), &server, &mut session).await;
    drop(session);
    server.close().await.unwrap();
}

async fn run_driver(workspace: &Path, installation: &Path, server: &Server, session: &mut Session) {
    let mut driver = Driver(
        Command::new("proto")
            .args([
                "run",
                "bun",
                "--",
                "packages/server/tests/query-hooks-driver.ts",
            ])
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut input = driver.0.stdin.take().unwrap();
    let output = driver.0.stdout.take().unwrap();
    let (send, mut lines) = tokio::sync::mpsc::unbounded_channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            if send.send(line.unwrap()).is_err() {
                break;
            }
        }
    });

    let timeout = if std::env::var("TOKAMAK_HOOK_BENCHMARK").as_deref() == Ok("1") {
        Duration::from_secs(120)
    } else {
        Duration::from_secs(30)
    };
    tokio::time::timeout(timeout, async {
        loop {
            tokio::select! {
                line = lines.recv() => {
                    let message: Value = serde_json::from_str(&line.expect("SDK driver exited")).unwrap();
                    if message["done"] == true {
                        break;
                    }
                    if message["uninstall"] == true || message["reinstall"] == true {
                        let installed = installation.join("moderation");
                        let removed = installation.join(".removed-moderation");
                        let extra = installation.join("z-extra");
                        let removed_extra = installation.join(".removed-z-extra");
                        if message["uninstall"] == true {
                            fs::rename(installed, removed).unwrap();
                            fs::rename(extra, removed_extra).unwrap();
                        } else {
                            fs::rename(removed, installed).unwrap();
                            fs::rename(removed_extra, extra).unwrap();
                        }
                        server.reload_plugin("moderation".into()).await.unwrap();
                        writeln!(input, "{}", json!({"reloaded":true})).unwrap();
                    } else {
                        session.sender().request(serde_json::from_value(message["request"].clone()).unwrap()).unwrap();
                    }
                }
                event = session.recv() => {
                    writeln!(input, "{}", json!({"event":event.unwrap().unwrap()})).unwrap();
                }
            }
        }
    })
    .await
    .expect("SDK query hooks driver timed out");

    drop(input);
    assert!(driver.0.wait().unwrap().success());
    reader.join().unwrap();
}
