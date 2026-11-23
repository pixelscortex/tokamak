//! One pipe pair for the process; JavaScript stays on the owning plugin's thread.
mod plugin;
mod realm;

use std::{
    collections::HashMap,
    io::{self, Write},
    sync::{Arc, Mutex, atomic::AtomicU64},
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use tokamak_worker::{WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::sync::mpsc;

pub(super) const BUNDLE: &str = "tokamak-action.js";

pub async fn run() -> Result<()> {
    let (input, mut frames) = mpsc::channel::<Value>(WORKER_CAPACITY);
    std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            let mut reader = io::stdin().lock();
            while let Some(frame) = crate::protocol::read_frame(&mut reader)? {
                if frame["type"] == "shutdown" || input.blocking_send(frame).is_err() {
                    break;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("Action process input: {error:#}");
        }
        crate::protocol::shutdown();
    });

    let (writer, mut outgoing) = mpsc::unbounded_channel::<Vec<u8>>();
    let bytes = Arc::new(Mutex::new(0));
    let queued = bytes.clone();
    std::thread::spawn(move || {
        let mut stdout = io::stdout().lock();
        while let Some(line) = outgoing.blocking_recv() {
            if stdout
                .write_all(&line)
                .and_then(|()| stdout.flush())
                .is_err()
            {
                crate::protocol::shutdown();
            }
            *queued.lock().expect("action process output") -= line.len();
        }
    });

    let output = Arc::new(Output { writer, bytes });
    let next_op = Arc::new(AtomicU64::new(0));
    let mut plugins = HashMap::<u64, plugin::Thread>::new();
    while let Some(frame) = frames.recv().await {
        let slot = number(&frame, "slot")?;
        match frame["type"].as_str() {
            Some("drop") => {
                plugins.remove(&slot);
            }
            Some("invoke") => {
                let id = number(&frame, "id")?;
                let start = || plugin::Thread::start(slot, &frame, output.clone(), next_op.clone());
                if let std::collections::hash_map::Entry::Vacant(entry) = plugins.entry(slot) {
                    match start() {
                        Ok(thread) => {
                            entry.insert(thread);
                        }
                        Err(error) => {
                            output.error(slot, id, &error.to_string());
                            continue;
                        }
                    }
                }
                if plugins[&slot].send(frame).is_err() {
                    output.error(
                        slot,
                        id,
                        "Plugin action capacity exceeded or runtime stopped",
                    );
                }
            }
            Some("cancel" | "opResult") => {
                if let Some(plugin) = plugins.get(&slot) {
                    plugin.control(frame).await;
                }
            }
            _ => anyhow::bail!("Invalid action process message"),
        }
    }
    Ok(())
}

struct Output {
    writer: mpsc::UnboundedSender<Vec<u8>>,
    bytes: Arc<Mutex<usize>>,
}

impl Output {
    fn send(&self, slot: u64, mut frame: Value) -> Result<()> {
        frame["slot"] = json!(slot);
        let mut line = serde_json::to_vec(&frame)?;
        line.push(b'\n');
        ensure!(
            line.len() <= WORKER_FRAME_BYTES,
            if frame["type"] == "result" {
                "result too large (1 MiB limit)"
            } else {
                "Action message exceeds 1 MiB limit"
            }
        );
        let mut bytes = self.bytes.lock().expect("action process output");
        if frame["type"] == "log" && *bytes >= 4 * WORKER_FRAME_BYTES {
            return Ok(());
        }
        ensure!(
            *bytes < 4 * WORKER_FRAME_BYTES || frame["type"] == "result",
            "Action process output queue is full"
        );
        *bytes += line.len();
        self.writer
            .send(line)
            .context("Action process output closed")
    }

    fn error(&self, slot: u64, id: u64, error: &str) {
        let error: String = error.chars().take(8192).collect();
        let _ = self.send(slot, json!({"type":"result","id":id,"error":error}));
    }
}

fn number(frame: &Value, key: &str) -> Result<u64> {
    frame[key]
        .as_u64()
        .filter(|id| *id < 1 << 53)
        .with_context(|| format!("Invalid action process {key}"))
}
