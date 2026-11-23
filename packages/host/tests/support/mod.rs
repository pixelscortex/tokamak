use std::{path::Path, process::Stdio, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
};

pub struct Host {
    pub child: Child,
    pub input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
}

impl Host {
    pub fn start() -> Self {
        Self::with_heap(None)
    }

    pub fn with_heap(heap: Option<&str>) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_tokamak-plugin-host"));
        command.env_remove("TOKAMAK_PLUGIN_HOST_HEAP_MIB");
        if let Some(heap) = heap {
            command.env("TOKAMAK_PLUGIN_HOST_HEAP_MIB", heap);
        }
        let mut child = command
            .process_group(0)
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

    pub async fn send(&mut self, frame: Value) {
        send(&mut self.input, frame).await;
    }

    pub async fn receive(&mut self) -> Value {
        receive(&mut self.output).await
    }

    pub async fn invoke(&mut self, id: u64, name: &str, args: Value) {
        invoke(&mut self.input, &mut self.output, id, name, args).await;
    }
}

pub async fn send(input: &mut ChildStdin, frame: Value) {
    input
        .write_all(format!("{frame}\n").as_bytes())
        .await
        .unwrap();
}

pub async fn receive(output: &mut Lines<BufReader<ChildStdout>>) -> Value {
    let line = tokio::time::timeout(Duration::from_secs(12), output.next_line())
        .await
        .expect("plugin host did not respond")
        .unwrap()
        .expect("plugin host exited");
    serde_json::from_str(&line).unwrap()
}

pub async fn invoke(
    input: &mut ChildStdin,
    output: &mut Lines<BufReader<ChildStdout>>,
    id: u64,
    name: &str,
    args: Value,
) {
    send(
        input,
        json!({ "type": "invoke", "id": id, "fn": name, "args": args }),
    )
    .await;
    let op = receive(output).await;
    assert_eq!(op["name"], "auth.current");
    send(
        input,
        json!({ "type": "opResult", "id": op["id"], "value": null }),
    )
    .await;
}

pub fn fixture() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture.js")
}
