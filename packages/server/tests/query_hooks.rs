use engine::{Limits, Pool, PoolConfig};
use serde_json::{Value, json};
use server::{
    Server, Session,
    data::{Database, Storage},
    identity::{Role, User},
};
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
}

#[tokio::test]
async fn query_hooks_apply_to_window_live_and_server_calls() {
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

    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            tokio::select! {
                line = lines.recv() => {
                    let message: Value = serde_json::from_str(&line.expect("SDK driver exited")).unwrap();
                    if message["done"] == true {
                        break;
                    }
                    if message["uninstall"] == true {
                        fs::rename(
                            installation.join("moderation"),
                            installation.join(".removed-moderation"),
                        ).unwrap();
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
