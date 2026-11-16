//! Task 1 acceptance through the real SDK, action lane and a scripted stdio peer.
use engine::{Pool, PoolConfig};
use serde_json::{Value, json};
use server::{
    Event, Server,
    data::{Database, Storage},
};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc, time::Duration};

const AGENT: &str = include_str!("support/acp_agent.py");

const PLUGIN: &str = r#"
import { action, query, mutation, createRegistry, invokeFunction, functionMetadata, v } from 'SDK';
const probe = action({ args: { mode: v.string() }, handler: async ({ acp }, { mode }) => {
  if (mode === 'agents') return acp.agents();
  const opened = await acp.open({ agent: mode === 'missing' ? 'absent' : mode === 'slow-initialize' ? 'slow' : 'fake', cwd: mode === 'cwd-relative' ? '.' : mode === 'cwd-missing' ? '/nonexistent-tokamak-acp-directory' : mode === 'cwd-file' ? '/etc/hosts' : '/tmp' });
  const events = [];
  for await (const event of acp.prompt({ agent: 'fake', sessionId: opened.sessionId, text: mode === 'blocked-write' ? 'x'.repeat(900000) : mode })) {
    events.push(event);
    if (mode === 'flood' && events.length === 1) {
      const until = Date.now() + 1000;
      while (Date.now() < until) {}
    }
    if (event.type === 'permission') {
      if (mode === 'cancel' || mode === 'ignore-cancel') await acp.cancel({ agent: 'fake', sessionId: opened.sessionId });
      else await acp.respond({ requestId: event.requestId, optionId: 'yes' });
    }
  }
  return { opened, events };
} });
const noAcp = ctx => !('acp' in ctx);
const registry = createRegistry({ ops: { probe, query: query({ handler: noAcp }), mutation: mutation({ handler: noAcp }) } });
export const describe = () => ({ schema: {}, functions: functionMetadata(registry) });
export const invoke = (args, host) => invokeFunction(registry, args, host);
"#;

struct Fixture {
    directory: tempfile::TempDir,
    server: Server,
    plugin: &'static str,
}

impl Fixture {
    async fn new(granted: bool) -> Self {
        Self::with_agent(granted, AGENT).await
    }

    async fn with_agent(granted: bool, agent_source: &str) -> Self {
        Self::with_launcher(granted, agent_source, false).await
    }

    async fn with_launcher(granted: bool, agent_source: &str, pass_path: bool) -> Self {
        Self::build(granted, agent_source, pass_path, None).await
    }

    async fn build(granted: bool, agent_source: &str, pass_path: bool, real: Option<&str>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let plugin = if real.is_some() {
            "acp"
        } else {
            "probe"
        };
        let plugins = root.join("plugins");
        let artifact = plugins.join(plugin);
        std::fs::create_dir_all(&artifact).unwrap();
        let sdk = Path::new(env!("CARGO_MANIFEST_DIR")).join("../sdk/src/index.ts");
        let source = root.join("plugin.ts");
        let code = if let Some(agent) = real {
            REAL_PLUGIN.replace("AGENT", agent)
        } else {
            PLUGIN.to_owned()
        };
        std::fs::write(&source, code.replace("SDK", sdk.to_str().unwrap())).unwrap();
        let output = std::process::Command::new("proto")
            .args(["run", "bun", "--", "build"])
            .arg(&source)
            .args(["--target", "browser", "--format", "esm", "--outfile"])
            .arg(artifact.join("bundle.js"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        std::fs::write(artifact.join("bundle.js.map"), "{}").unwrap();
        std::fs::write(artifact.join("api.ts"), "export {};").unwrap();
        let mut hashes = serde_json::Map::new();
        for file in ["bundle.js", "bundle.js.map", "api.ts"] {
            hashes.insert(
                file.into(),
                json!(format!(
                    "{:x}",
                    Sha256::digest(std::fs::read(artifact.join(file)).unwrap())
                )),
            );
        }
        std::fs::write(artifact.join("manifest.json"), json!({
            "formatVersion":1, "plugin":{"id":plugin,"version":"1.0.0", "permissions":if granted {vec!["acp"]} else {vec![]}},
            "entries":{"backend":{"code":"bundle.js","map":"bundle.js.map","api":"api.ts"}}, "hashes":hashes
        }).to_string()).unwrap();
        std::fs::write(
            root.join(".env.local"),
            "ACP_TEST_PASSTHROUGH=from-dotenv\nACP_TEST_HANG_INITIALIZE=1\nACP_TEST_UNLISTED=not-visible\n",
        )
        .unwrap();
        let agent = root.join("agent.py");
        std::fs::write(&agent, agent_source).unwrap();
        let command = if pass_path {
            "acp-path-only-launcher"
        } else {
            "/usr/bin/python3"
        };
        let env = if pass_path {
            json!(["ACP_TEST_PASSTHROUGH", "PATH"])
        } else {
            json!(["ACP_TEST_PASSTHROUGH"])
        };
        std::fs::write(
            root.join("agents.toml"),
            format!(
                "[agents.fake]\ncommand = {}\nargs = [{}]\nenv = {}\nplugins = [\"probe\"]\n",
                json!(command),
                json!(agent.to_str().unwrap()),
                env
            ),
        )
        .unwrap();
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new().append(true).open(root.join("agents.toml")).unwrap(),
            "[agents.slow]\ncommand = \"/usr/bin/python3\"\nargs = [{}]\nenv = [\"ACP_TEST_PASSTHROUGH\", \"ACP_TEST_HANG_INITIALIZE\"]\nplugins = [\"probe\"]",
            json!(agent.to_str().unwrap())
        ).unwrap();
        if real.is_some() {
            std::fs::remove_file(root.join("agents.toml")).unwrap();
            std::fs::remove_file(root.join(".env.local")).unwrap();
            if let Some(config) = std::env::var_os("TOKAMAK_ACP_AGENTS") {
                assert!(Path::new(&config).is_absolute());
                std::fs::copy(&config, root.join("agents.toml")).unwrap();
                let environment = Path::new(&config).parent().unwrap().join(".env.local");
                if environment.is_file() {
                    std::fs::copy(environment, root.join(".env.local")).unwrap();
                }
            }
            // A detached snapshot of tracked repo files keeps agent access away
            // from the owner's working tree, with no persistent git worktree.
            let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            let archive = root.join("repo.tar");
            assert!(
                std::process::Command::new("git")
                    .current_dir(repo)
                    .args(["archive", "HEAD", "-o"])
                    .arg(&archive)
                    .status()
                    .unwrap()
                    .success()
            );
            let cwd = root.join("repo");
            std::fs::create_dir(&cwd).unwrap();
            assert!(
                std::process::Command::new("tar")
                    .arg("-xf")
                    .arg(archive)
                    .arg("-C")
                    .arg(cwd)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let database = Database::open(Storage::Memory).await.unwrap();
        let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
        let server = Server::load_plugins(database, pool, &plugins)
            .await
            .unwrap();
        Self {
            directory,
            server,
            plugin,
        }
    }

    async fn call(&self, kind: &str, name: &str, args: Value) -> Result<Value, String> {
        let mut session = self.server.connect().await.unwrap();
        session
            .sender()
            .request(
                serde_json::from_value(
                    json!({"type":kind,"id":1,"name":format!("{}/ops:{name}", self.plugin),"args":args}),
                )
                .unwrap(),
            )
            .unwrap();
        loop {
            match tokio::time::timeout(
                Duration::from_secs(if self.plugin == "acp" {
                    360
                } else {
                    45
                }),
                session.recv(),
            )
            .await
            .expect("ACP call timed out")
            .unwrap()
            .unwrap()
            {
                Event::Response { result, .. } => return result.map_err(|e| format!("{e:?}")),
                _ => continue,
            }
        }
    }

    async fn action(&self, mode: &str) -> Result<Value, String> {
        self.call("action", "probe", json!({"mode":mode})).await
    }

    async fn close(self) {
        self.server.close().await.unwrap();
        drop(self.directory);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_prompt_and_done_round_trip() {
    let fixture = Fixture::new(true).await;
    assert_eq!(
        fixture.action("agents").await.unwrap(),
        json!([{"id":"fake","title":"fake"},{"id":"slow","title":"slow"}])
    );
    let result = fixture.action("hello").await.unwrap();
    assert_eq!(
        result["opened"],
        json!({"sessionId":"session","restored":false})
    );
    assert_eq!(result["events"][0]["update"]["content"]["text"], "hello");
    assert_eq!(
        result["events"][1],
        json!({"type":"done","stopReason":"end_turn"})
    );
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_request_is_answered() {
    let fixture = Fixture::new(true).await;
    let result = fixture.action("permission").await.unwrap();
    assert_eq!(result["events"][0]["type"], "permission");
    assert_eq!(result["events"][1]["stopReason"], "end_turn");
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_notifies_agent_and_cancels_pending_permission() {
    let fixture = Fixture::new(true).await;
    let result = fixture.action("cancel").await.unwrap();
    assert_eq!(result["events"][1]["stopReason"], "cancelled");
    // A second request proves the fake observed cancellation without crashing.
    assert!(fixture.action("hello").await.is_ok());
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn non_granted_plugin_and_missing_agent_are_refused() {
    let fixture = Fixture::new(false).await;
    assert!(
        fixture
            .action("hello")
            .await
            .unwrap_err()
            .contains("requires acp")
    );
    fixture.close().await;
    let fixture = Fixture::new(true).await;
    assert!(
        fixture
            .action("missing")
            .await
            .unwrap_err()
            .contains("Unknown ACP agent")
    );
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_fails_turn_with_stderr_tail() {
    let fixture = Fixture::new(true).await;
    let error = fixture.action("crash").await.unwrap_err();
    assert!(error.contains("ACP_CRASH_TAIL"), "{error}");
    assert!(!error.contains(&"x".repeat(2049)));
    assert!(
        fixture.action("hello").await.is_ok(),
        "crashed process must restart"
    );
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queries_and_mutations_have_no_acp() {
    let fixture = Fixture::new(true).await;
    for kind in ["query", "mutation"] {
        assert_eq!(fixture.call(kind, kind, json!({})).await.unwrap(), true);
    }
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_frame_and_event_backlog_fail_turns() {
    let fixture = Fixture::new(true).await;
    for (mode, error) in [
        ("huge-line", "frame exceeds 1 MiB"),
        ("flood", "event queue exceeds 4 MiB"),
    ] {
        assert!(fixture.action(mode).await.unwrap_err().contains(error));
    }
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blocked_stdin_has_a_write_deadline() {
    let agent = AGENT.replace(
        "response(request, dict(sessionId=params.get('sessionId', 'session')))",
        "response(request, dict(sessionId=params.get('sessionId', 'session')))\n        import time; time.sleep(60)",
    );
    let fixture = Fixture::with_agent(true, &agent).await;
    let error = fixture.action("blocked-write").await.unwrap_err();
    assert!(error.contains("stdin write timed out"), "{error}");
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ignored_cancel_kills_agent_and_allows_restart() {
    let fixture = Fixture::new(true).await;
    let error = fixture.action("ignore-cancel").await.unwrap_err();
    assert!(error.contains("cancellation timed out"), "{error}");
    assert!(fixture.action("hello").await.is_ok());
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initialize_deadline_does_not_block_other_agents() {
    let fixture = Fixture::new(true).await;
    let (slow, fast) = tokio::join!(fixture.action("slow-initialize"), async {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !fixture
                .directory
                .path()
                .join("agent.py.initializing")
                .exists()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("slow agent entered initialize");
        tokio::time::timeout(Duration::from_secs(5), fixture.action("hello")).await
    });
    assert!(fast.unwrap().is_ok());
    let error = slow.unwrap_err();
    assert!(error.contains("initialize timed out"), "{error}");
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cwd_must_be_an_absolute_existing_directory() {
    let fixture = Fixture::new(true).await;
    for mode in ["cwd-relative", "cwd-missing", "cwd-file"] {
        let error = fixture.action(mode).await.unwrap_err();
        assert!(error.contains("Agent folder"), "{mode}: {error}");
    }
    fixture.close().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_reports_tail_even_when_descendant_holds_stderr() {
    let fixture = Fixture::new(true).await;
    let started = std::time::Instant::now();
    let error = fixture.action("stderr-held").await.unwrap_err();
    let pid: i32 = error
        .split("ACP_STDERR_CHILD:")
        .nth(1)
        .unwrap()
        .split(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    // The deliberately detached descendant is outside the agent's process group.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
    assert!(started.elapsed() < Duration::from_secs(3), "{error}");
    assert!(error.contains("ACP_HELD_TAIL"), "{error}");
    fixture.close().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn launcher_resolves_command_from_allowed_path() {
    // Set PATH only in an isolated test process; never mutate the test runner's
    // environment while other tests are launching agents.
    if std::env::var_os("ACP_TEST_PATH_CHILD").is_none() {
        let directory = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        let launcher = directory.path().join("acp-path-only-launcher");
        std::fs::write(&launcher, "#!/bin/sh\nexec /usr/bin/python3 \"$@\"\n").unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!(
            "{}:{}",
            directory.path().display(),
            std::env::var("PATH").unwrap()
        );
        let output = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "launcher_resolves_command_from_allowed_path",
                "--nocapture",
            ])
            .env("ACP_TEST_PATH_CHILD", "1")
            .env("PATH", path)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let agent = AGENT.replace(
        "assert 'PATH' not in os.environ",
        "assert 'PATH' in os.environ",
    );
    let fixture = Fixture::with_launcher(true, &agent, true).await;
    fixture.action("hello").await.unwrap();
    let bin = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .next()
        .unwrap();
    std::fs::remove_file(bin.join("acp-path-only-launcher")).unwrap();
    assert_eq!(
        fixture.action("agents").await.unwrap(),
        json!([{"id":"slow","title":"slow"}])
    );
    // Open, prompt and cancel continue using the already running process.
    let result = fixture.action("cancel").await.unwrap();
    assert_eq!(result["events"][1]["stopReason"], "cancelled");
    assert!(fixture.action("hello").await.is_ok());
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn launcher_does_not_pass_unlisted_variables() {
    let fixture = Fixture::new(true).await;
    // The fake agent asserts the dotenv-only ACP_TEST_UNLISTED is absent.
    assert!(fixture.action("hello").await.is_ok());
    fixture.close().await;
}

const REAL_PLUGIN: &str = r#"
import { action, createRegistry, invokeFunction, functionMetadata, v } from 'SDK';
const probe = action({ args: { cwd: v.string() }, handler: async ({ acp }, { cwd }) => {
  const { sessionId } = await acp.open({ agent: 'AGENT', cwd });
  let text = '';
  let stopReason;
  for await (const event of acp.prompt({ agent: 'AGENT', sessionId, text: 'Reply with the single word: ready' })) {
    if (event.type === 'update' && event.update.sessionUpdate === 'agent_message_chunk' && event.update.content.type === 'text') text += event.update.content.text;
    if (event.type === 'permission') await acp.respond({ requestId: event.requestId, optionId: null });
    if (event.type === 'done') stopReason = event.stopReason;
  }
  return { text, stopReason };
} });
const registry = createRegistry({ ops: { probe } });
export const describe = () => ({ schema: {}, functions: functionMetadata(registry) });
export const invoke = (args, host) => invokeFunction(registry, args, host);
"#;

async fn real_smoke(agent: &str) {
    let fixture = Fixture::build(true, AGENT, false, Some(agent)).await;
    let result = fixture
        .call(
            "action",
            "probe",
            json!({"cwd": fixture.directory.path().join("repo")}),
        )
        .await
        .unwrap();
    assert_eq!(result["stopReason"], "end_turn", "{result}");
    assert!(
        result["text"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("ready"),
        "{result}"
    );
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "owner credentials and installed adapter required; optional TOKAMAK_ACP_AGENTS"]
async fn acp_real_claude_smoke() {
    real_smoke("claude").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "owner credentials and installed adapter required; optional TOKAMAK_ACP_AGENTS"]
async fn acp_real_codex_smoke() {
    real_smoke("codex").await;
}
