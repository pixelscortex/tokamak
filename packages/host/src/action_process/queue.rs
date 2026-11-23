use std::{
    collections::{HashMap, VecDeque},
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

const PLUGIN_RUNNING: usize = 16;
const ANONYMOUS_RUNNING: usize = 4;

pub(super) struct Queue {
    sources: HashMap<u64, Arc<Source>>,
    lanes: HashMap<Arc<str>, Lane>,
    anonymous_running: usize,
    output: Arc<Output>,
    next: Arc<AtomicU64>,
    executor: Handle,
    complete: mpsc::UnboundedSender<(Arc<str>, u64)>,
}

impl Queue {
    pub fn new(output: Arc<Output>, complete: mpsc::UnboundedSender<(Arc<str>, u64)>) -> Self {
        Self {
            sources: HashMap::new(),
            lanes: HashMap::new(),
            anonymous_running: 0,
            output,
            next: Arc::default(),
            executor: Handle::current(),
            complete,
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
        let plugin = source.plugin.clone();
        self.lanes
            .entry(plugin.clone())
            .or_default()
            .waiting
            .push_back(Waiting { id, source, frame });
        self.start_waiting(&plugin);
    }

    pub fn cancel(&mut self, slot: u64, id: u64) {
        let Some(source) = self.sources.get(&slot) else {
            return;
        };
        let plugin = source.plugin.clone();
        if let Some(lane) = self.lanes.get_mut(&plugin) {
            lane.waiting
                .retain(|call| call.id != id || call.source.bridge.slot != slot);
            if let Some(call) = lane.running.get_mut(&id).filter(|call| call.slot == slot) {
                call.cancel();
            }
            self.start_waiting(&plugin);
        }
    }

    pub fn op_result(&mut self, slot: u64, id: u64, frame: Value) {
        if let Some(sender) = self
            .lane(slot)
            .and_then(|lane| lane.running.get(&id))
            .filter(|call| call.slot == slot)
            .and_then(|call| call.send.as_ref())
        {
            let _ = sender.send(frame);
        }
    }

    pub fn retire(&mut self, slot: u64) {
        if let Some(source) = self.sources.remove(&slot)
            && let Some(lane) = self.lanes.get_mut(&source.plugin)
        {
            lane.waiting.retain(|call| call.source.bridge.slot != slot);
            for call in lane.running.values_mut().filter(|call| call.slot == slot) {
                call.cancel();
            }
            self.start_waiting(&source.plugin);
        }
    }

    pub fn finished(&mut self, plugin: Arc<str>, id: u64) {
        let Some(call) = self
            .lanes
            .get_mut(&plugin)
            .and_then(|lane| lane.running.remove(&id))
        else {
            return;
        };

        if call.anonymous {
            self.anonymous_running -= 1;
        }
        self.start_waiting(&plugin);

        if call.anonymous && self.anonymous_running < ANONYMOUS_RUNNING {
            // Releasing an anonymous slot can unblock another plugin's queue.
            let waiting = self
                .lanes
                .iter()
                .filter(|(_, lane)| {
                    lane.waiting
                        .front()
                        .is_some_and(|call| call.source.anonymous)
                })
                .map(|(plugin, _)| plugin.clone())
                .collect::<Vec<_>>();
            for plugin in waiting {
                self.start_waiting(&plugin);
                if self.anonymous_running == ANONYMOUS_RUNNING {
                    break;
                }
            }
        }
    }

    fn lane(&mut self, slot: u64) -> Option<&mut Lane> {
        self.lanes.get_mut(&self.sources.get(&slot)?.plugin)
    }

    fn start_waiting(&mut self, plugin: &str) {
        let Some(lane) = self.lanes.get_mut(plugin) else {
            return;
        };
        while lane.running.len() < PLUGIN_RUNNING {
            if self.anonymous_running == ANONYMOUS_RUNNING
                && lane
                    .waiting
                    .front()
                    .is_some_and(|call| call.source.anonymous)
            {
                break;
            }
            let Some(call) = lane.waiting.pop_front() else {
                break;
            };
            let id = call.id;
            let slot = call.source.bridge.slot;
            match call.start(self.executor.clone(), self.complete.clone()) {
                Ok(call) => {
                    self.anonymous_running += usize::from(call.anonymous);
                    lane.running.insert(id, call);
                }
                Err(error) => self.output.error(slot, id, &error.to_string()),
            }
        }

        if lane.running.is_empty() && lane.waiting.is_empty() {
            self.lanes.remove(plugin);
        }
    }
}

struct Source {
    plugin: Arc<str>,
    anonymous: bool,
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
        let logs = output.share(plugin.clone());

        Ok(Self {
            plugin: plugin.into(),
            anonymous: frame["network"] == false,
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

#[derive(Default)]
struct Lane {
    waiting: VecDeque<Waiting>,
    running: HashMap<u64, Running>,
}

struct Waiting {
    id: u64,
    source: Arc<Source>,
    frame: Value,
}

impl Waiting {
    fn start(
        self,
        executor: Handle,
        complete: mpsc::UnboundedSender<(Arc<str>, u64)>,
    ) -> Result<Running> {
        let (send, receive) = mpsc::unbounded_channel();
        let stop = Arc::new(AtomicBool::new(false));
        let retired = stop.clone();
        let slot = self.source.bridge.slot;
        let anonymous = self.source.anonymous;
        std::thread::Builder::new()
            .name("tokamak-action-js".into())
            .spawn(move || {
                let Self { id, source, frame } = self;
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

                // The runtime and its resources have been dropped before the
                // result is visible or another call is allowed to take its place.
                if !retired.load(Ordering::Acquire) {
                    report(bridge, id, outcome);
                }
                let _ = complete.send((source.plugin.clone(), id));
            })?;
        Ok(Running {
            slot,
            anonymous,
            stop,
            send: Some(send),
        })
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
    slot: u64,
    anonymous: bool,
    stop: Arc<AtomicBool>,
    send: Option<mpsc::UnboundedSender<Value>>,
}

impl Running {
    fn cancel(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.send.take();
    }
}
