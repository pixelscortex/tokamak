#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::{path::Path, process::Stdio, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines},
    net::{TcpListener, TcpStream},
    process::{Child, ChildStdin, ChildStdout, Command},
};

struct Process {
    _child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
}

impl Process {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_tokamak-plugin-host"))
            .arg("--actions")
            .process_group(0)
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()).lines(),
            _child: child,
        }
    }

    async fn send(&mut self, frame: Value) {
        self.input
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn invoke(&mut self, slot: u64, id: u64, name: &str, args: Value, bundle: &str) {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join(bundle);
        self.send(json!({
            "type":"invoke","slot":slot,"id":id,"fn":name,"args":args,
            "path":path,"permissions":["net:127.0.0.1"],"workerEntry":true,"heap":6 * 1024 * 1024,
        }))
        .await;
    }

    async fn next(&mut self) -> Value {
        loop {
            let line = tokio::time::timeout(Duration::from_secs(10), self.output.next_line())
                .await
                .expect("action process did not respond")
                .unwrap()
                .expect("action process exited");
            let frame: Value = serde_json::from_str(&line).unwrap();
            if frame["type"] != "op" {
                return frame;
            }
            assert_eq!(frame["name"], "auth.current");
            self.send(json!({
                "type":"opResult","slot":frame["slot"],"call":frame["call"],"id":frame["id"],"value":null,
            })).await;
        }
    }
}

const BUNDLE: &str = "action-fixture.js";

#[tokio::test]
async fn plugins_run_concurrently_and_a_busy_plugin_only_interrupts_its_own_calls() {
    let mut process = Process::start();
    process.invoke(1, 1, "delay", json!(1000), BUNDLE).await;
    assert_eq!(process.next().await["text"], "delay started");
    process.invoke(2, 2, "loop", Value::Null, BUNDLE).await;
    assert_eq!(process.next().await["text"], "loop started");
    assert_eq!(
        process.next().await,
        json!({"type":"result","slot":1,"id":1,"value":"done"})
    );
    let failure = process.next().await;
    assert_eq!(failure["id"], 2);
    assert!(failure["error"].as_str().unwrap().contains("did not yield"));
    process.invoke(2, 3, "count", Value::Null, BUNDLE).await;
    assert_eq!(process.next().await["value"], 1);
}

#[tokio::test]
async fn heap_exhaustion_fails_only_the_owning_action() {
    let mut process = Process::start();
    process.invoke(1, 1, "count", Value::Null, BUNDLE).await;
    assert_eq!(process.next().await["value"], 1);
    process.invoke(2, 2, "heap", Value::Null, BUNDLE).await;
    let failure = process.next().await;
    assert_eq!(failure["id"], 2);
    assert!(
        failure["error"].as_str().unwrap().contains("memory"),
        "{failure}"
    );
    process.invoke(1, 3, "count", Value::Null, BUNDLE).await;
    assert_eq!(process.next().await["value"], 1);
    process.invoke(2, 4, "count", Value::Null, BUNDLE).await;
    assert_eq!(process.next().await["value"], 1);
}

#[tokio::test]
async fn action_modules_supply_the_four_builtins_without_files_or_programs() {
    let mut process = Process::start();
    process
        .invoke(1, 1, "modules", Value::Null, "action-builtins.js")
        .await;
    let result = process.next().await;
    assert_eq!(result["value"][0], 64, "{result}");
    assert_eq!(result["value"][2], "a/b");
    assert_eq!(result["value"][3], "example.com");

    process
        .invoke(2, 2, "modules", Value::Null, "action-file-import.js")
        .await;
    let result = process.next().await;
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("node:fs/promises")
    );

    process.invoke(3, 3, "authority", Value::Null, BUNDLE).await;
    assert_eq!(
        process.next().await["value"],
        json!({"process":"undefined","proc":"undefined"})
    );
}

#[tokio::test]
async fn control_backlog_does_not_delay_another_plugin_or_dispatcher_ping() {
    let mut process = Process::start();
    process.invoke(2, 1, "count", Value::Null, BUNDLE).await;
    assert_eq!(process.next().await["value"], 1);
    process.invoke(1, 2, "spin", json!(2000), BUNDLE).await;
    assert_eq!(process.next().await["text"], "spin started");

    tokio::time::timeout(Duration::from_millis(200), async {
        for id in 100..500 {
            process
                .send(json!({"type":"cancel","slot":1,"id":id}))
                .await;
        }
        process.send(json!({"type":"ping","id":8})).await;
        assert_eq!(process.next().await, json!({"type":"pong","id":8}));
        process.invoke(2, 3, "count", Value::Null, BUNDLE).await;
        assert_eq!(process.next().await["value"], 1);
    })
    .await
    .expect("plugin 1's backlog stalled the dispatcher");

    assert_eq!(process.next().await["id"], 2);
    process.invoke(2, 4, "count", Value::Null, BUNDLE).await;
    assert_eq!(process.next().await["value"], 1);
}

async fn receive_http_request(listener: &TcpListener) -> TcpStream {
    let (peer, _) = listener.accept().await.unwrap();
    let mut reader = BufReader::new(peer);
    let mut line = String::new();

    // Wait for the GET before replying or cancelling; accept alone only observes TCP setup.
    loop {
        line.clear();
        assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
        if line == "\r\n" {
            return reader.into_inner();
        }
    }
}

#[tokio::test]
async fn cancelled_worker_fetches_release_their_resources() {
    let mut process = Process::start();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let mut hung = Vec::new();

    for id in 1..=100 {
        process
            .invoke(1, id, "fetch", json!(url), "action-builtins.js")
            .await;
        let peer = tokio::select! {
            result = process.next() => panic!("hung fetch {id} completed: {result}"),
            peer = receive_http_request(&listener) => peer,
        };
        // Keep the peer open without sending headers so only cancellation can end the fetch.
        hung.push(peer);
        process
            .send(json!({"type":"cancel","slot":1,"id":id}))
            .await;
    }

    process
        .invoke(1, 101, "timerThenFetch", json!(url), "action-builtins.js")
        .await;
    let mut peer = tokio::select! {
        result = process.next() => panic!("timer/fetch failed before reaching the peer: {result}"),
        peer = receive_http_request(&listener) => peer,
    };
    peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
        .await
        .unwrap();
    assert_eq!(
        process.next().await,
        json!({"type":"result","slot":1,"id":101,"value":"ok"})
    );

    tokio::time::timeout(Duration::from_secs(2), async {
        for mut peer in hung {
            peer.read_to_end(&mut Vec::new()).await.unwrap();
        }
    })
    .await
    .expect("cancelled worker fetches left HTTP connections open");
}
