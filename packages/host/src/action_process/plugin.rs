use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    future::{Future, poll_fn},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result};
use rquickjs::{
    AsyncRuntime, Ctx, Exception, Module,
    loader::{ImportAttributes, Loader, Resolver},
};
use serde_json::Value;
use tokio::sync::mpsc;

use super::{Output, number, realm::Realm};
use crate::{modules, runtime::Watchdog};

pub(super) struct Thread {
    requests: mpsc::UnboundedSender<Value>,
    retired: Arc<AtomicBool>,
}

impl Thread {
    pub fn start(
        slot: u64,
        frame: &Value,
        output: Arc<Output>,
        next: Arc<AtomicU64>,
    ) -> Result<Self> {
        let path = frame["path"]
            .as_str()
            .context("Missing action bundle path")?;
        let path = std::path::PathBuf::from(path);
        let heap = frame["heap"]
            .as_u64()
            .and_then(|bytes| usize::try_from(bytes).ok())
            .filter(|bytes| *bytes > 0)
            .context("Invalid action heap limit")?;
        let persistent = frame["persistent"] == true;
        // The server admits calls and host operations before sending frames.
        // A busy runtime must never put backpressure on the dispatcher.
        let (requests, receive) = mpsc::unbounded_channel();
        let retired = Arc::new(AtomicBool::new(false));
        let bridge = Bridge {
            slot,
            output,
            next,
            logs: Default::default(),
        };
        let stop = retired.clone();

        std::thread::Builder::new()
            .name("tokamak-action-js".into())
            .spawn(move || start_thread(&path, heap, persistent, bridge, stop, receive))?;
        Ok(Self { requests, retired })
    }

    pub fn send(&self, frame: Value) -> Result<()> {
        self.requests
            .send(frame)
            .map_err(|e| anyhow::anyhow!("{e}"))
    }
}

impl Drop for Thread {
    fn drop(&mut self) {
        self.retired.store(true, Ordering::Release);
    }
}

fn start_thread(
    path: &std::path::Path,
    heap: usize,
    persistent: bool,
    bridge: Bridge,
    stop: Arc<AtomicBool>,
    mut receive: mpsc::UnboundedReceiver<Value>,
) {
    let setup = || -> Result<_> {
        let source = std::fs::read_to_string(path).context("Reading verified action bundle")?;
        // Native HTTP cancellation must run while JavaScript is busy.
        let executor = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(4)
            .enable_all()
            .build()?;
        Ok((
            Plugin {
                source,
                heap,
                persistent,
            },
            executor,
        ))
    };

    match setup() {
        Ok((plugin, executor)) => executor.block_on(run_plugin(plugin, bridge, stop, receive)),
        Err(error) => {
            receive.close();
            while let Some(frame) = receive.blocking_recv() {
                if frame["type"] == "invoke"
                    && let Ok(id) = number(&frame, "id")
                {
                    bridge.output.error(bridge.slot, id, &format!("{error:#}"));
                }
            }
        }
    }
}

struct Plugin {
    source: String,
    heap: usize,
    persistent: bool,
}

async fn run_plugin(
    plugin: Plugin,
    bridge: Bridge,
    stop: Arc<AtomicBool>,
    mut receive: mpsc::UnboundedReceiver<Value>,
) {
    let bridge = Rc::new(bridge);
    while let Some(first) = receive.recv().await {
        if stop.load(Ordering::Acquire) {
            break;
        }
        if first["type"] != "invoke" {
            continue;
        }
        let id = first["id"].as_u64().unwrap_or_default();
        match PluginRuntime::new(plugin.heap, stop.clone(), bridge.clone()).await {
            Ok((runtime, completions)) => {
                runtime.run(first, &mut receive, completions, &plugin).await
            }
            Err(error) => bridge.output.error(bridge.slot, id, &error.to_string()),
        }
    }
}

pub(super) struct Bridge {
    pub slot: u64,
    pub output: Arc<Output>,
    pub next: Arc<AtomicU64>,
    pub logs: super::output::LogShare,
}

pub(super) type Active = Rc<RefCell<HashSet<u64>>>;

struct PluginRuntime {
    runtime: AsyncRuntime,
    watchdog: Rc<Watchdog>,
    active: Active,
    completed: mpsc::UnboundedSender<u64>,
    stopped: Arc<AtomicBool>,
    bridge: Rc<Bridge>,
}

impl PluginRuntime {
    async fn new(
        heap: usize,
        stopped: Arc<AtomicBool>,
        bridge: Rc<Bridge>,
    ) -> Result<(Self, mpsc::UnboundedReceiver<u64>)> {
        let runtime = AsyncRuntime::new()?;
        runtime.set_memory_limit(heap).await;
        runtime.set_loader(Builtins, Builtins).await;
        let watchdog = Rc::new(Watchdog::default());
        let check = watchdog.clone();
        let retired = stopped.clone();
        runtime
            .set_interrupt_handler(Some(Box::new(move || {
                retired.load(Ordering::Acquire) || check.interrupt()
            })))
            .await;
        let (completed, completions) = mpsc::unbounded_channel();
        Ok((
            Self {
                runtime,
                watchdog,
                stopped,
                completed,
                active: Active::default(),
                bridge,
            },
            completions,
        ))
    }

    async fn watched<T>(&self, future: impl Future<Output = T>) -> T {
        let mut future = std::pin::pin!(future);
        poll_fn(|cx| self.watchdog.poll(|| future.as_mut().poll(cx))).await
    }

    async fn drive(&self) {
        let mut drive = std::pin::pin!(self.runtime.drive());
        poll_fn(|cx| {
            let result = self.watchdog.poll(|| drive.as_mut().poll(cx));
            if self.watchdog.tripped() {
                std::task::Poll::Ready(())
            } else {
                result
            }
        })
        .await
    }

    async fn run(
        self,
        first: Value,
        receive: &mut mpsc::UnboundedReceiver<Value>,
        mut completions: mpsc::UnboundedReceiver<u64>,
        plugin: &Plugin,
    ) {
        let mut realms = HashMap::<u64, Realm>::new();
        let mut root = None;
        let mut frame = Some(first);

        loop {
            if self.stopped.load(Ordering::Acquire) || self.watchdog.tripped() {
                break;
            }

            if let Some(message) = frame.take() {
                if let Err(error) = self.dispatch(message, plugin, &mut realms, &mut root).await {
                    eprintln!("dispatch: {error:#}");
                }
            } else {
                tokio::select! {
                    biased;
                    () = self.drive() => break,
                    Some(id) = completions.recv() => {
                        if realms.remove(&id).is_some() {
                            self.runtime.run_gc().await;
                        }
                    }
                    next = receive.recv() => {
                        let Some(next) = next else { break };
                        frame = Some(next);
                    }
                }
            }
        }

        let message = if self.watchdog.tripped() {
            "Plugin action did not yield for 5 seconds; QuickJS runtime reset"
        } else {
            "Plugin action runtime retired"
        };
        for id in self.active.borrow_mut().drain() {
            self.bridge.output.error(self.bridge.slot, id, message);
        }
    }

    async fn dispatch(
        &self,
        frame: Value,
        plugin: &Plugin,
        realms: &mut HashMap<u64, Realm>,
        root: &mut Option<Realm>,
    ) -> Result<()> {
        let id = number(&frame, "id")?;
        match frame["type"].as_str() {
            Some("invoke") => {
                self.active.borrow_mut().insert(id);
                let network = frame["network"] != false;
                // Sign-in retains its private realm and disabled web effects.
                let shared = plugin.persistent && network;
                if !shared || root.is_none() {
                    let permissions: Vec<String> =
                        serde_json::from_value(frame["permissions"].clone())?;
                    let start = Realm::new(
                        &self.runtime,
                        &plugin.source,
                        &permissions,
                        self.realm_config(),
                        plugin.persistent,
                        network,
                    );
                    let outcome = tokio::time::timeout(
                        std::time::Duration::from_secs(6),
                        self.watched(start),
                    )
                    .await;
                    match outcome {
                        Ok(Ok(realm)) if shared => *root = Some(realm),
                        Ok(Ok(realm)) => {
                            realms.insert(id, realm);
                        }
                        _ if self.watchdog.tripped() => return Ok(()),
                        Ok(Err(error)) => {
                            self.fail(id, &error.to_string());
                            return Ok(());
                        }
                        Err(_) => {
                            self.fail(id, "Plugin action bundle initialization timed out");
                            return Ok(());
                        }
                    }
                }

                let Some(realm) = realms.get(&id).or(root.as_ref()) else {
                    return Ok(());
                };
                if let Err(error) = self.watched(realm.dispatch(frame)).await
                    && !self.watchdog.tripped()
                {
                    self.fail(id, &error.to_string());
                    realms.remove(&id);
                }
            }
            Some("cancel") => {
                let active = self.active.borrow_mut().remove(&id);
                if active {
                    if let Some(realm) = realms.get(&id).or(root.as_ref()) {
                        let _ = self.watched(realm.dispatch(frame)).await;
                    }
                    realms.remove(&id);
                }
            }
            Some("opResult") => {
                let call = number(&frame, "call")?;
                let active = self.active.borrow().contains(&call);
                if active
                    && let Some(realm) = realms.get(&call).or(root.as_ref())
                    && let Err(error) = self.watched(realm.dispatch(frame)).await
                    && !self.watchdog.tripped()
                {
                    self.fail(call, &error.to_string());
                    realms.remove(&call);
                }
            }
            _ => anyhow::bail!("Invalid plugin action message"),
        }
        Ok(())
    }

    fn fail(&self, id: u64, error: &str) {
        self.active.borrow_mut().remove(&id);
        self.bridge.output.error(self.bridge.slot, id, error);
    }

    fn realm_config(&self) -> super::realm::Config {
        super::realm::Config {
            bridge: self.bridge.clone(),
            watchdog: self.watchdog.clone(),
            active: self.active.clone(),
            completed: self.completed.clone(),
        }
    }
}

struct Builtins;
impl Resolver for Builtins {
    fn resolve<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        _: &str,
        name: &str,
        _: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        modules::action_builtin(name)
            .map(str::to_owned)
            .ok_or_else(|| {
                Exception::throw_reference(
                    ctx,
                    &format!("Module is not allowed in the action process: {name}"),
                )
            })
    }
}

impl Loader for Builtins {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js>> {
        modules::load_builtin(ctx.clone(), name)
    }
}
