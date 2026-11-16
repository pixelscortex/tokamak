//! Task 1 acceptance through the real SDK, action lane and a scripted stdio peer.
use engine::{Pool, PoolConfig};
use serde_json::{Value, json};
use server::{
    Event, Server,
    data::{Database, Storage},
};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc, time::Duration};

const AGENT: &str = r#"
import sys, json, os
assert os.environ.get('ACP_TEST_PASSTHROUGH') == 'from-dotenv'
assert 'HOME' not in os.environ
assert 'PATH' not in os.environ
pending = None
cancelled = False

def send(value):
    print(json.dumps(dict(jsonrpc='2.0', **value)), flush=True)

def response(request, result):
    send(dict(id=request['id'], result=result))

for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    params = request.get('params', {})
    if method == 'initialize':
        if os.environ.get('ACP_TEST_HANG_INITIALIZE'):
            import time; time.sleep(60)
        assert not params.get('clientCapabilities', {}).get('terminal', False)
        assert not params.get('clientCapabilities', {}).get('fs', {}).get('readTextFile', False)
        response(request, dict(protocolVersion=1, agentCapabilities=dict(loadSession=True, sessionCapabilities=dict(resume={}))))
        send(dict(id='fs', method='fs/read_text_file', params=dict(path='/tmp/file')))
        send(dict(id='terminal', method='terminal/create', params=dict(command='echo')))
    elif request.get('id') in ['fs', 'terminal']:
        assert request['error']['code'] == -32601
    elif method in ['session/new', 'session/resume', 'session/load']:
        response(request, dict(sessionId=params.get('sessionId', 'session')))
    elif method == 'session/prompt':
        text = params['prompt'][0]['text']
        if text == 'huge-line':
            sys.stdout.write('x' * (1024 * 1024 + 1))
            sys.stdout.flush()
            continue
        if text == 'flood':
            for _ in range(20):
                send(dict(method='session/update', params=dict(sessionId='session', update=dict(sessionUpdate='agent_message_chunk', content=dict(type='text', text='x' * 600000)))))
            continue
        if text == 'crash':
            sys.stderr.write('x' * 3000 + 'ACP_CRASH_TAIL')
            sys.stderr.flush()
            sys.exit(9)
        if text in ['permission', 'cancel', 'ignore-cancel']:
            pending = request
            send(dict(id='permission', method='session/request_permission', params=dict(sessionId='session', toolCall=dict(toolCallId='call', title='Run command'), options=[dict(optionId='yes', name='Allow once', kind='allow_once')])))
        else:
            send(dict(method='session/update', params=dict(sessionId='session', update=dict(sessionUpdate='agent_message_chunk', content=dict(type='text', text='hello')))))
            response(request, dict(stopReason='end_turn'))
    elif method == 'session/cancel':
        if pending['params']['prompt'][0]['text'] == 'ignore-cancel':
            continue
        assert cancelled, 'pending permission must be cancelled before notification'
        response(pending, dict(stopReason='cancelled'))
    elif request.get('id') == 'permission':
        outcome = request['result']['outcome']
        cancelled = outcome['outcome'] == 'cancelled'
        if not cancelled:
            assert outcome == dict(outcome='selected', optionId='yes')
            response(pending, dict(stopReason='end_turn'))
"#;

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
}

impl Fixture {
    async fn new(granted: bool) -> Self {
        Self::with_agent(granted, AGENT).await
    }

    async fn with_agent(granted: bool, agent_source: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let plugins = root.join("plugins");
        let artifact = plugins.join("probe");
        std::fs::create_dir_all(&artifact).unwrap();
        let sdk = Path::new(env!("CARGO_MANIFEST_DIR")).join("../sdk/src/index.ts");
        let source = root.join("plugin.ts");
        std::fs::write(&source, PLUGIN.replace("SDK", sdk.to_str().unwrap())).unwrap();
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
            "formatVersion":1, "plugin":{"id":"probe","version":"1.0.0", "permissions":if granted {vec!["acp"]} else {vec![]}},
            "entries":{"backend":{"code":"bundle.js","map":"bundle.js.map","api":"api.ts"}}, "hashes":hashes
        }).to_string()).unwrap();
        std::fs::write(
            root.join(".env.local"),
            "ACP_TEST_PASSTHROUGH=from-dotenv\nACP_TEST_HANG_INITIALIZE=1\n",
        )
        .unwrap();
        let agent = root.join("agent.py");
        std::fs::write(&agent, agent_source).unwrap();
        std::fs::write(root.join("agents.toml"), format!(
            "[agents.fake]\ncommand = \"/usr/bin/python3\"\nargs = [{}]\nenv = [\"ACP_TEST_PASSTHROUGH\"]\nplugins = [\"probe\"]\n", json!(agent.to_str().unwrap())
        )).unwrap();
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new().append(true).open(root.join("agents.toml")).unwrap(),
            "[agents.slow]\ncommand = \"/usr/bin/python3\"\nargs = [{}]\nenv = [\"ACP_TEST_PASSTHROUGH\", \"ACP_TEST_HANG_INITIALIZE\"]\nplugins = [\"probe\"]",
            json!(agent.to_str().unwrap())
        ).unwrap();
        let database = Database::open(Storage::Memory).await.unwrap();
        let pool = Arc::new(Pool::new(PoolConfig::default()).unwrap());
        let server = Server::load_plugins(database, pool, &plugins)
            .await
            .unwrap();
        Self { directory, server }
    }

    async fn call(&self, kind: &str, name: &str, args: Value) -> Result<Value, String> {
        let mut session = self.server.connect().await.unwrap();
        session
            .sender()
            .request(
                serde_json::from_value(
                    json!({"type":kind,"id":1,"name":format!("probe/ops:{name}"),"args":args}),
                )
                .unwrap(),
            )
            .unwrap();
        loop {
            match tokio::time::timeout(Duration::from_secs(45), session.recv())
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
        tokio::time::sleep(Duration::from_millis(250)).await;
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
        assert!(error.contains("ACP cwd"), "{mode}: {error}");
    }
    fixture.close().await;
}
