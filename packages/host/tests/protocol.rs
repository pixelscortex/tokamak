#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::{path::Path, process::Stdio, time::Duration};

use serde_json::{Value, json};
use tokamak_worker::{WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
};

struct Host {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
}

impl Host {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_tokamak-plugin-host"))
            .arg(fixture())
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            child,
            input,
            output,
        }
    }

    async fn send(&mut self, frame: Value) {
        self.input
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn receive(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(7), self.output.next_line())
            .await
            .expect("plugin host did not respond")
            .unwrap()
            .expect("plugin host exited");
        serde_json::from_str(&line).unwrap()
    }

    async fn invoke(&mut self, id: u64, name: &str, args: Value) {
        self.send(json!({ "type": "invoke", "id": id, "fn": name, "args": args }))
            .await;
        let op = self.receive().await;
        assert_eq!(op["name"], "auth.current");
        self.send(json!({ "type": "opResult", "id": op["id"], "value": null }))
            .await;
    }
}

fn fixture() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture.js")
}

#[tokio::test]
async fn cancellation_interrupts_a_tight_loop_and_retires_only_started_calls() {
    let mut host = Host::start();
    host.invoke(1, "sleep", json!({})).await;
    host.invoke(2, "loop", json!({})).await;
    assert_eq!(host.receive().await["text"], "loop");

    host.send(json!({ "type": "cancel", "id": 2 })).await;
    let mut results = [host.receive().await, host.receive().await];
    results.sort_by_key(|frame| frame["id"].as_u64().unwrap());
    assert_eq!(
        results[0]["error"],
        "Plugin local function stopped when its QuickJS runtime was reset"
    );
    assert_eq!(results[1]["error"], "Plugin local function cancelled");

    let number = json!(0.018920700000000002);
    host.invoke(3, "echo", number.clone()).await;
    assert_eq!(host.receive().await["value"], number);
}

#[tokio::test]
async fn deadline_interrupts_a_tight_loop_without_client_cancellation() {
    let mut host = Host::start();
    host.invoke(1, "loop", json!({})).await;
    assert_eq!(host.receive().await["text"], "loop");
    assert_eq!(
        host.receive().await["error"],
        "Plugin local function deadline exceeded"
    );
}

#[tokio::test]
async fn allocation_failure_does_not_stop_another_call() {
    let mut host = Host::start();
    host.send(json!({ "type": "invoke", "id": 1, "fn": "echo", "args": "still here" }))
        .await;
    let echo_op = host.receive().await;
    host.invoke(2, "memory", json!({})).await;
    assert_eq!(host.receive().await["error"], "out of memory");

    host.send(json!({ "type": "opResult", "id": echo_op["id"], "value": null }))
        .await;
    assert_eq!(host.receive().await["value"], "still here");
}

#[tokio::test]
async fn oversized_output_fails_the_call_and_oversized_input_closes_the_host() {
    let mut host = Host::start();
    host.invoke(1, "huge", json!({})).await;
    assert_eq!(
        host.receive().await["error"],
        "Worker message exceeds 1 MiB limit"
    );

    host.input
        .write_all(&vec![b' '; WORKER_FRAME_BYTES])
        .await
        .unwrap();
    let exit = tokio::time::timeout(Duration::from_secs(5), host.child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(!exit.success());
}

#[tokio::test]
async fn local_functions_can_use_native_modules_timers_text_encoder_and_fetch() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let responder = std::thread::spawn(move || {
        use std::io::{BufRead, Write};
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = std::io::BufReader::new(&stream);
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            if line == "\r\n" {
                break;
            }
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nyes")
            .unwrap();
    });
    let mut host = Host::start();
    host.invoke(
        1,
        "native",
        json!({ "source": fixture(), "endpoint": endpoint }),
    )
    .await;
    let reply = host.receive().await;
    assert_eq!(
        reply["value"],
        json!({ "copied": true, "text": "yes", "bytes": [206, 181], "ticks": 1 }),
        "{reply}"
    );
    responder.join().unwrap();
}

#[tokio::test]
async fn suspended_invocations_cannot_exceed_the_worker_capacity() {
    let mut host = Host::start();
    for id in 0..WORKER_CAPACITY {
        host.send(json!({ "type": "invoke", "id": id, "fn": "echo", "args": id }))
            .await;
        assert_eq!(host.receive().await["call"], id);
    }
    host.send(json!({ "type": "invoke", "id": WORKER_CAPACITY, "fn": "echo", "args": null }))
        .await;
    let exit = tokio::time::timeout(Duration::from_secs(5), host.child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(!exit.success());
}

#[tokio::test]
async fn another_plugins_contract_is_explicitly_refused() {
    let mut host = Host::start();
    host.invoke(1, "providers", json!({})).await;
    let candidate_op = host.receive().await;
    assert_eq!(candidate_op["name"], "local.contracts");
    host.send(json!({
        "type": "opResult", "id": candidate_op["id"],
        "value": [{ "plugin": "provider", "registration": "fixture", "path": fixture(), "own": false, "owner": "consumer" }]
    })).await;
    let auth = host.receive().await;
    assert_eq!(auth["name"], "auth.current");
    host.send(json!({ "type": "opResult", "id": auth["id"], "value": {} }))
        .await;
    let result = host.receive().await;
    assert_eq!(
        result["error"],
        "Loading another plugin's local contracts is not available on the QuickJS host yet"
    );
}
