use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use tokamak_worker::WORKER_FRAME_BYTES;
use tokio::sync::mpsc;

const QUEUE_BYTES: usize = 4 * WORKER_FRAME_BYTES;
const LOG_BYTES: usize = WORKER_FRAME_BYTES;
const PLUGIN_LOG_BYTES: usize = LOG_BYTES / 4;

#[derive(Default)]
pub(super) struct PluginLogs {
    queued: usize,
    dropped: usize,
}

pub(super) type LogShare = Arc<Mutex<PluginLogs>>;

#[derive(Default)]
struct Queue {
    bytes: usize,
    logs: usize,
}

struct Line {
    bytes: Vec<u8>,
    logs: Option<LogShare>,
}

pub(super) struct Output {
    writer: mpsc::UnboundedSender<Line>,
    queue: Arc<Mutex<Queue>>,
}

impl Output {
    pub fn start() -> Self {
        let (writer, mut outgoing) = mpsc::unbounded_channel::<Line>();
        let queue = Arc::new(Mutex::new(Queue::default()));
        let queued = queue.clone();
        std::thread::spawn(move || {
            let mut stdout = io::stdout().lock();
            while let Some(line) = outgoing.blocking_recv() {
                if stdout
                    .write_all(&line.bytes)
                    .and_then(|()| stdout.flush())
                    .is_err()
                {
                    crate::protocol::shutdown();
                }

                let mut queue = queued.lock().expect("action process output");
                queue.bytes -= line.bytes.len();
                if let Some(logs) = line.logs {
                    queue.logs -= line.bytes.len();
                    logs.lock().expect("plugin log share").queued -= line.bytes.len();
                }
            }
        });

        Self { writer, queue }
    }

    pub fn send(&self, slot: u64, mut frame: Value) -> Result<()> {
        frame["slot"] = json!(slot);
        let bytes = encode(&frame)?;
        let mut queue = self.queue.lock().expect("action process output");
        ensure!(
            queue.bytes < QUEUE_BYTES || frame["type"] == "result",
            "Action process output queue is full"
        );
        self.enqueue(&mut queue, bytes, None)
    }

    pub fn pong(&self, id: u64) -> Result<()> {
        let bytes = encode(&json!({"type":"pong","id":id}))?;
        self.enqueue(
            &mut self.queue.lock().expect("action process output"),
            bytes,
            None,
        )
    }

    pub fn log(&self, slot: u64, mut frame: Value, share: &LogShare) -> Result<()> {
        frame["slot"] = json!(slot);
        let bytes = encode(&frame)?;
        let mut queue = self.queue.lock().expect("action process output");
        let mut plugin = share.lock().expect("plugin log share");
        let notice = (plugin.dropped > 0)
            .then(|| {
                encode(&json!({
                    "type":"log","slot":slot,"level":"warn",
                    "text":format!("{} log lines dropped", plugin.dropped),
                }))
            })
            .transpose()?;
        let total = bytes.len() + notice.as_ref().map_or(0, Vec::len);
        if plugin.queued + total > PLUGIN_LOG_BYTES
            || queue.logs + total > LOG_BYTES
            || queue.bytes + total > QUEUE_BYTES
        {
            plugin.dropped = plugin.dropped.saturating_add(1);
            return Ok(());
        }

        if let Some(notice) = notice {
            self.enqueue(&mut queue, notice, Some(share.clone()))?;
            plugin.dropped = 0;
        }
        self.enqueue(&mut queue, bytes, Some(share.clone()))?;
        plugin.queued += total;
        Ok(())
    }

    fn enqueue(&self, queue: &mut Queue, bytes: Vec<u8>, logs: Option<LogShare>) -> Result<()> {
        let size = bytes.len();
        let is_log = logs.is_some();
        self.writer
            .send(Line { bytes, logs })
            .context("Action process output closed")?;
        queue.bytes += size;
        if is_log {
            queue.logs += size;
        }
        Ok(())
    }

    pub fn error(&self, slot: u64, id: u64, error: &str) {
        let error: String = error.chars().take(8192).collect();
        let _ = self.send(slot, json!({"type":"result","id":id,"error":error}));
    }
}

fn encode(frame: &Value) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(frame)?;
    bytes.push(b'\n');
    ensure!(
        bytes.len() <= WORKER_FRAME_BYTES,
        if frame["type"] == "result" {
            "result too large (1 MiB limit)"
        } else {
            "Action message exceeds 1 MiB limit"
        }
    );
    Ok(bytes)
}
