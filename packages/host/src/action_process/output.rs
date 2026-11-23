use std::{
    collections::HashMap,
    io::{self, Write},
    sync::{Arc, Mutex, Weak},
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
    results: usize,
}

impl Queue {
    fn written(&mut self, line: Line) {
        self.bytes -= line.bytes.len();
        if line.is_result {
            self.results -= line.bytes.len();
        }
        if let Some(logs) = line.logs {
            self.logs -= line.bytes.len();
            logs.lock().expect("plugin log share").queued -= line.bytes.len();
        }
    }
}

struct Line {
    bytes: Vec<u8>,
    logs: Option<LogShare>,
    is_result: bool,
}

pub(super) struct Output {
    writer: mpsc::UnboundedSender<Line>,
    queue: Arc<Mutex<Queue>>,
    plugins: Mutex<HashMap<String, Weak<Mutex<PluginLogs>>>>,
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

                queued.lock().expect("action process output").written(line);
            }
        });

        Self {
            writer,
            queue,
            plugins: Mutex::default(),
        }
    }

    pub fn share(&self, plugin: String) -> LogShare {
        let mut plugins = self.plugins.lock().expect("action process log shares");
        if let Some(share) = plugins.get(&plugin).and_then(Weak::upgrade) {
            return share;
        }
        plugins.retain(|_, share| share.strong_count() > 0);
        let share = LogShare::default();
        plugins.insert(plugin, Arc::downgrade(&share));
        share
    }

    pub fn send(&self, slot: u64, mut frame: Value) -> Result<()> {
        frame["slot"] = json!(slot);
        let bytes = encode(&frame)?;
        let mut queue = self.queue.lock().expect("action process output");
        let is_result = frame["type"] == "result";
        ensure!(
            is_result
                || queue.bytes - queue.logs - queue.results + bytes.len()
                    <= QUEUE_BYTES - LOG_BYTES,
            "Action process output queue is full"
        );
        self.enqueue(&mut queue, bytes, None, is_result)
    }

    pub fn pong(&self, id: u64) -> Result<()> {
        let bytes = encode(&json!({"type":"pong","id":id}))?;
        self.enqueue(
            &mut self.queue.lock().expect("action process output"),
            bytes,
            None,
            false,
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
            self.enqueue(&mut queue, notice, Some(share.clone()), false)?;
            plugin.dropped = 0;
        }
        self.enqueue(&mut queue, bytes, Some(share.clone()), false)?;
        plugin.queued += total;
        Ok(())
    }

    fn enqueue(
        &self,
        queue: &mut Queue,
        bytes: Vec<u8>,
        logs: Option<LogShare>,
        is_result: bool,
    ) -> Result<()> {
        let size = bytes.len();
        let is_log = logs.is_some();
        self.writer
            .send(Line {
                bytes,
                logs,
                is_result,
            })
            .context("Action process output closed")?;
        queue.bytes += size;
        if is_result {
            queue.results += size;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_results_do_not_use_the_operation_budget() {
        let (writer, mut receive) = mpsc::unbounded_channel();
        let output = Output {
            writer,
            queue: Arc::default(),
            plugins: Mutex::default(),
        };
        let payload = "x".repeat(WORKER_FRAME_BYTES - 64);
        let result = json!({"type":"result","value":payload});
        let op = json!({"type":"op","payload":payload});

        for _ in 0..4 {
            output.send(1, result.clone()).unwrap();
        }

        for _ in 0..3 {
            output.send(2, op.clone()).unwrap();
        }
        assert_eq!(
            output.send(2, op).unwrap_err().to_string(),
            "Action process output queue is full"
        );

        let mut queue = output.queue.lock().unwrap();
        while let Ok(line) = receive.try_recv() {
            queue.written(line);
        }
        assert_eq!(queue.results, 0);
        assert_eq!(queue.bytes, 0);
    }

    #[test]
    fn one_plugins_log_flood_leaves_other_traffic_and_reports_recovery() {
        let (writer, mut receive) = mpsc::unbounded_channel();
        let queue = Arc::new(Mutex::new(Queue::default()));
        let output = Output {
            writer,
            queue: queue.clone(),
            plugins: Mutex::default(),
        };
        let noisy = output.share("noisy".into());
        let same_plugin = output.share("noisy".into());
        let peer = output.share("peer".into());
        let log = json!({"type":"log","text":"x".repeat(8192)});
        for _ in 0..500 {
            output.log(1, log.clone(), &noisy).unwrap();
            output.log(3, log.clone(), &same_plugin).unwrap();
        }
        assert!(noisy.lock().unwrap().queued <= PLUGIN_LOG_BYTES);
        let dropped = noisy.lock().unwrap().dropped;
        assert!(dropped > 0);
        output
            .log(2, json!({"type":"log","text":"peer log"}), &peer)
            .unwrap();
        output
            .send(
                2,
                json!({"type":"op","id":1,"payload":"x".repeat(512 * 1024)}),
            )
            .unwrap();

        let mut peer_output = Vec::new();
        while let Ok(line) = receive.try_recv() {
            let frame: Value = serde_json::from_slice(&line.bytes).unwrap();
            if frame["slot"] == 2 {
                peer_output.push(frame);
            }
            queue.lock().unwrap().written(line);
        }
        assert_eq!(peer_output.len(), 2);
        assert_eq!(peer_output[0]["text"], "peer log");
        assert_eq!(peer_output[1]["type"], "op");

        for _ in 0..2 {
            output.log(1, log.clone(), &noisy).unwrap();
        }
        let texts: Vec<_> = std::iter::from_fn(|| receive.try_recv().ok())
            .map(|line| serde_json::from_slice::<Value>(&line.bytes).unwrap()["text"].clone())
            .collect();
        assert_eq!(
            texts,
            [
                json!(format!("{dropped} log lines dropped")),
                log["text"].clone(),
                log["text"].clone()
            ]
        );
    }
}
