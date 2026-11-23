use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result};
use serde_json::Value;
use tokio::{runtime::Handle, sync::mpsc};

use super::{Output, call};

type Key = (u64, u64);

pub(super) struct Calls {
    sources: HashMap<u64, Arc<Source>>,
    running: HashMap<Key, Running>,
    output: Arc<Output>,
    next: Arc<AtomicU64>,
    executor: Handle,
    completed: mpsc::UnboundedSender<Key>,
}

impl Calls {
    pub fn new(output: Arc<Output>, completed: mpsc::UnboundedSender<Key>) -> Self {
        Self {
            sources: HashMap::new(),
            running: HashMap::new(),
            output,
            next: Arc::default(),
            executor: Handle::current(),
            completed,
        }
    }

    pub fn invoke(&mut self, slot: u64, id: u64, frame: Value) {
        if let std::collections::hash_map::Entry::Vacant(entry) = self.sources.entry(slot) {
            match Source::new(slot, &frame, self.output.clone(), self.next.clone()) {
                Ok(source) => {
                    entry.insert(Arc::new(source));
                }
                Err(error) => {
                    self.output.error(slot, id, &error.to_string());
                    return;
                }
            }
        }

        let source = self.sources[&slot].clone();
        let key = (slot, id);
        let (send, receive) = mpsc::unbounded_channel();
        let stop = Arc::new(AtomicBool::new(false));
        let retired = stop.clone();
        let executor = self.executor.clone();
        let completed = self.completed.clone();
        let thread = std::thread::Builder::new()
            .name("tokamak-action-js".into())
            .spawn(move || {
                let bridge = &source.bridge;
                let outcome = match source.text() {
                    Ok(text) if !retired.load(Ordering::Acquire) => executor.block_on(call::run(
                        text,
                        source.heap,
                        source.worker_entry,
                        frame,
                        bridge.clone(),
                        retired.clone(),
                        receive,
                    )),
                    Ok(_) => Ok(None),
                    Err(error) => Err(anyhow::anyhow!("{error}")),
                };

                // Drop the runtime and its resources before publishing the result.
                if !retired.load(Ordering::Acquire) {
                    report(bridge, id, outcome);
                }
                let _ = completed.send(key);
            });
        match thread {
            Ok(_) => {
                self.running.insert(
                    key,
                    Running {
                        stop,
                        send: Some(send),
                    },
                );
            }
            Err(error) => self.output.error(slot, id, &error.to_string()),
        }
    }

    pub fn cancel(&mut self, slot: u64, id: u64) {
        if let Some(call) = self.running.get_mut(&(slot, id)) {
            call.cancel();
        }
    }

    pub fn op_result(&self, slot: u64, id: u64, frame: Value) {
        if let Some(sender) = self
            .running
            .get(&(slot, id))
            .and_then(|call| call.send.as_ref())
        {
            let _ = sender.send(frame);
        }
    }

    pub fn retire(&mut self, slot: u64) {
        self.sources.remove(&slot);
        for (&(owner, _), call) in &mut self.running {
            if owner == slot {
                call.cancel();
            }
        }
    }

    pub fn finished(&mut self, key: Key) {
        self.running.remove(&key);
    }
}

struct Source {
    path: PathBuf,
    source: OnceLock<Result<String, String>>,
    heap: usize,
    worker_entry: bool,
    bridge: Arc<call::Bridge>,
}

impl Source {
    fn new(slot: u64, frame: &Value, output: Arc<Output>, next: Arc<AtomicU64>) -> Result<Self> {
        let path = frame["path"]
            .as_str()
            .context("Missing action bundle path")?;
        let heap = frame["heap"]
            .as_u64()
            .and_then(|bytes| usize::try_from(bytes).ok())
            .filter(|bytes| *bytes > 0)
            .context("Invalid action heap limit")?;
        let plugin = frame["pluginName"]
            .as_str()
            .map_or_else(|| slot.to_string(), str::to_owned);
        let logs = output.share(plugin);

        Ok(Self {
            path: path.into(),
            source: OnceLock::new(),
            heap,
            worker_entry: frame["workerEntry"] == true,
            bridge: Arc::new(call::Bridge {
                slot,
                output,
                next,
                logs,
            }),
        })
    }

    fn text(&self) -> Result<&str, &String> {
        self.source
            .get_or_init(|| {
                std::fs::read_to_string(&self.path)
                    .map_err(|error| format!("Reading verified action bundle: {error}"))
            })
            .as_deref()
    }
}

fn report(bridge: &call::Bridge, id: u64, outcome: Result<Option<Value>>) {
    let slot = bridge.slot;
    let error = match outcome {
        Ok(Some(frame)) => bridge.output.send(slot, frame).err(),
        Ok(None) => None,
        Err(error) => Some(error),
    };
    if let Some(error) = error {
        bridge.output.error(slot, id, &format!("{error:#}"));
    }
}

struct Running {
    stop: Arc<AtomicBool>,
    send: Option<mpsc::UnboundedSender<Value>>,
}

impl Running {
    fn cancel(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.send.take();
    }
}
