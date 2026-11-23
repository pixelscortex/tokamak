//! Per-plugin process registry. A socket is a route back to a window's signed-in
//! workspace; its lifetime does not determine the lifetime of the process.
mod session;

pub(super) use session::connection;

use super::{Artifact, TIMEOUT, artifact, client_env, write};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
};
use tempfile::TempPath;
use tokamak_worker::{Process, RestartBackoff, WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::{
    io::BufReader,
    sync::{Mutex as AsyncMutex, mpsc},
    time::Instant,
};
use tokio_util::{
    codec::{FramedRead, LinesCodec},
    sync::CancellationToken,
    task::{AbortOnDropHandle, TaskTracker},
};

type Slots = HashMap<String, Arc<AsyncMutex<Slot>>>;

#[derive(Clone)]
pub(super) struct Pool {
    plugins: Arc<PathBuf>,
    env: Arc<BTreeMap<String, String>>,
    slots: Arc<Mutex<Slots>>,
    stopping: CancellationToken,
    tasks: TaskTracker,
}

#[derive(Default)]
struct Slot {
    artifact: Option<Artifact>,
    current: Option<Arc<Host>>,
    restart: RestartBackoff,
}

impl Pool {
    pub(super) fn new(
        plugins: Arc<PathBuf>,
        app_data: Arc<PathBuf>,
        stopping: CancellationToken,
    ) -> Self {
        let paths = tokamak_worker::search_paths();
        let mut env = client_env(|name| std::env::var(name).ok());
        env.insert(
            "TOKAMAK_APP_DATA_DIR".into(),
            app_data.to_string_lossy().into_owned(),
        );
        if let Ok(path) = std::env::join_paths(&paths) {
            env.insert("PATH".into(), path.to_string_lossy().into_owned());
        }
        Self {
            plugins,
            env: Arc::new(env),
            slots: Arc::default(),
            stopping,
            tasks: TaskTracker::new(),
        }
    }

    pub(super) async fn wait(&self) {
        self.tasks.close();
        self.tasks.wait().await;
    }

    pub(super) fn observe(&self, server: &Arc<server::Server>, mut session: server::Session) {
        let server = server.clone();
        let pool = self.clone();
        self.tasks.spawn(async move {
            loop {
                let event = tokio::select! {
                    () = pool.stopping.cancelled() => break,
                    event = session.recv() => event,
                };
                match event {
                    Ok(Some(server::Event::PluginChanged { plugins, .. })) => {
                        pool.reconcile(&server, &plugins).await;
                    }
                    Ok(Some(_)) => {}
                    _ => break,
                }
            }
        });
    }

    async fn reconcile(&self, server: &server::Server, changed: &[String]) {
        let Ok(catalog) = server.plugins().await else {
            return;
        };
        let slots = lock(&self.slots)
            .iter()
            .map(|(id, slot)| (id.clone(), slot.clone()))
            .collect::<Vec<_>>();
        for (id, slot) in slots {
            let next = catalog["plugins"]
                .as_array()
                .and_then(|entries| entries.iter().find(|entry| entry["plugin"]["id"] == id));
            {
                let mut slot = slot.lock().await;
                if let Some(previous) = &slot.artifact
                    && !next.is_some_and(|entry| {
                        entry["hashes"]["local-entry.js"] == previous.entry_hash
                            && entry["hashes"]["local.js"] == previous.code_hash
                    })
                    // Another workspace can use a locally installed plugin
                    // even when it is absent from this catalog.
                    && (next.is_some() || changed.contains(&id))
                {
                    slot.retire().await;
                }
            }
            self.prune(&id, &slot);
        }
    }

    fn prune(&self, id: &str, slot: &Arc<AsyncMutex<Slot>>) {
        let mut slots = lock(&self.slots);
        // Another invocation may already have this slot and be about to use it.
        if Arc::strong_count(slot) == 2 && slot.try_lock().is_ok_and(|slot| slot.artifact.is_none())
        {
            slots.remove(id);
        }
    }

    async fn retire(&self, previous: Artifact) {
        let slot = lock(&self.slots).get(&previous.id).cloned();
        if let Some(slot) = slot {
            {
                let mut slot = slot.lock().await;
                if slot.artifact.as_ref() == Some(&previous) {
                    slot.retire().await;
                }
            }
            self.prune(&previous.id, &slot);
        }
    }

    async fn host(&self, requested: &Artifact, wait_to_restart: bool) -> Result<Arc<Host>, String> {
        let plugin = &requested.id;
        let fail = |reason: String| format!("Plugin {plugin} process: {reason}");
        let slot = {
            let mut slots = lock(&self.slots);
            if slots.len() >= WORKER_CAPACITY && !slots.contains_key(plugin) {
                return Err(fail("local plugin process limit reached".into()));
            }
            slots.entry(plugin.clone()).or_default().clone()
        };
        let result = self.start_or_reuse(requested, &slot, wait_to_restart).await;
        self.prune(plugin, &slot);
        result.map_err(fail)
    }

    async fn start_or_reuse(
        &self,
        requested: &Artifact,
        slot: &AsyncMutex<Slot>,
        wait_to_restart: bool,
    ) -> Result<Arc<Host>, String> {
        loop {
            let mut slot = slot.lock().await;
            if self.stopping.is_cancelled() {
                return Err("Runner stopped".into());
            }
            let same = slot.artifact.as_ref() == Some(requested);
            if same && let Some(host) = slot.reuse().await {
                return Ok(host);
            }
            if let Some(retry) = slot
                .restart
                .retry_at
                .filter(|retry| same && *retry > Instant::now())
            {
                if !wait_to_restart {
                    return Err("waiting to restart after a crash".into());
                }
                drop(slot);
                tokio::select! {
                    () = self.stopping.cancelled() => return Err("Runner stopped".into()),
                    () = tokio::time::sleep_until(retry) => continue,
                }
            }
            let root = self.plugins.clone();
            let request = requested.clone();
            let verified = tokio::task::spawn_blocking(move || {
                artifact(&root, &request.id, &request.entry_hash, &request.code_hash)
            });
            let (_, code) = tokio::time::timeout(TIMEOUT, verified)
                .await
                .map_err(|_| "local artifact verification stalled")?
                .map_err(|error| error.to_string())??;
            if !same {
                slot.retire().await;
                slot.artifact = Some(requested.clone());
            }
            if self.stopping.is_cancelled() {
                return Err("Runner stopped".into());
            }
            match Host::start(&requested.id, code, self) {
                Ok(host) => {
                    slot.current = Some(host.clone());
                    return Ok(host);
                }
                Err(error) => {
                    slot.restart.failed(Instant::now(), false);
                    return Err(error);
                }
            }
        }
    }
}

impl Slot {
    async fn reuse(&mut self) -> Option<Arc<Host>> {
        let host = self.current.as_ref()?;
        if !host.stopping.is_cancelled() {
            return Some(host.clone());
        }
        host.ended.cancelled().await;
        let stopped = host.stopped_at.get().copied().unwrap_or_else(Instant::now);
        self.restart.crashed(stopped, host.started);
        self.current = None;
        None
    }

    async fn retire(&mut self) {
        // Keep the handle in the slot until the process has actually exited,
        // even if the call that requested the new generation is cancelled.
        if let Some(host) = &self.current {
            host.stop("local plugin generation retired".into());
            host.ended.cancelled().await;
        }
        *self = Self::default();
    }
}

#[derive(Default)]
struct Calls {
    next: u64,
    active: HashMap<u64, mpsc::Sender<Value>>,
}

struct Host {
    id: String,
    calls: Mutex<Calls>,
    writes: mpsc::Sender<Vec<u8>>,
    stopping: CancellationToken,
    ended: CancellationToken,
    reason: OnceLock<String>,
    started: Instant,
    stopped_at: OnceLock<Instant>,
}

impl Host {
    fn start(id: &str, code: TempPath, pool: &Pool) -> Result<Arc<Self>, String> {
        let cwd = pool.plugins.parent().unwrap_or(&pool.plugins);
        let mut process = Process::launch_plugin(id, &code, cwd, &pool.env)?;
        let (input, output, mut stderr) = process.pipes()?;
        let (writes, outgoing) = mpsc::channel(WORKER_CAPACITY);
        let host = Arc::new(Self {
            id: id.into(),
            calls: Mutex::default(),
            writes,
            stopping: pool.stopping.child_token(),
            ended: CancellationToken::new(),
            reason: OnceLock::new(),
            started: Instant::now(),
            stopped_at: OnceLock::new(),
        });
        let running = host.clone();
        pool.tasks.spawn(async move {
            let _code = code;
            let _drain = AbortOnDropHandle::new(tokio::spawn(async move {
                let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
            }));
            let mut output = FramedRead::new(
                BufReader::new(output),
                LinesCodec::new_with_max_length(WORKER_FRAME_BYTES - 1),
            );
            let read = async {
                while let Some(line) = output.next().await {
                    let frame = serde_json::from_str(&line.map_err(|error| error.to_string())?)
                        .map_err(|_| "Invalid plugin host JSON")?;
                    running.deliver(frame)?;
                }
                Err::<(), String>("plugin host output closed".into())
            };
            let reason = tokio::select! {
                reason = process.exited() => reason,
                error = write(input, outgoing) => error,
                error = read => error.err().unwrap_or_else(|| "plugin host output closed".into()),
                () = running.stopping.cancelled() => "Runner stopped".into(),
            };
            let _ = running.stopped_at.set(Instant::now());
            running.stop(reason);
            lock(&running.calls).active.clear();
            process.stop().await;
            running.ended.cancel();
        });
        Ok(host)
    }

    fn begin(self: &Arc<Self>, mut frame: Value) -> Result<Call, String> {
        let (send, receive) = mpsc::channel(WORKER_CAPACITY + 1);
        let mut calls = lock(&self.calls);
        if self.stopping.is_cancelled() {
            return Err(self.error());
        }
        if calls.active.len() >= WORKER_CAPACITY {
            return Err(self.label("invocation capacity exceeded"));
        }
        calls.next += 1;
        let id = calls.next;
        frame["id"] = json!(id);
        calls.active.insert(id, send);
        if let Err(error) = self.send(&frame) {
            calls.active.remove(&id);
            return Err(error);
        }
        Ok(Call {
            host: self.clone(),
            id,
            receive,
            finished: false,
        })
    }

    fn deliver(&self, frame: Value) -> Result<(), String> {
        let mut calls = lock(&self.calls);
        let recipient = match frame["type"].as_str() {
            Some("log") => {
                let level = frame["level"].as_str().unwrap_or("info");
                let text = frame["text"].as_str().unwrap_or("");
                tokamak_worker::log(format!("Plugin {} [{level}]: {text}", self.id));
                return Ok(());
            }
            Some("op") => calls.active.get(&frame_id(&frame["call"])?).cloned(),
            Some("result") => calls.active.remove(&frame_id(&frame["id"])?),
            _ => return Err("invalid plugin host message".into()),
        };
        if let Some(recipient) = recipient
            && let Err(mpsc::error::TrySendError::Full(_)) = recipient.try_send(frame)
        {
            return Err("plugin host output queue full".into());
        }
        Ok(())
    }

    fn send(&self, frame: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
        if bytes.len() >= WORKER_FRAME_BYTES {
            return Err(self.label("message exceeds 1 MiB"));
        }
        bytes.push(b'\n');
        self.writes
            .try_send(bytes)
            .map_err(|_| self.label("input queue full or closed"))
    }

    fn stop(&self, reason: String) {
        let _ = self.reason.set(reason);
        self.stopping.cancel();
    }

    fn error(&self) -> String {
        self.label(self.reason.get().map_or("host stopped", String::as_str))
    }

    fn label(&self, reason: &str) -> String {
        format!("Plugin {} process: {reason}", self.id)
    }
}

struct Call {
    host: Arc<Host>,
    id: u64,
    receive: mpsc::Receiver<Value>,
    finished: bool,
}

impl Call {
    async fn next(&mut self) -> Result<Value, String> {
        let frame = self.receive.recv().await.ok_or_else(|| self.host.error())?;
        self.finished = frame["type"] == "result";
        Ok(frame)
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        if !self.finished
            && lock(&self.host.calls).active.remove(&self.id).is_some()
            && self
                .host
                .send(&json!({"type":"cancel", "id":self.id}))
                .is_err()
        {
            self.host
                .stop("could not deliver cancellation to plugin host".into());
        }
    }
}

fn frame_id(value: &Value) -> Result<u64, String> {
    value
        .as_u64()
        .filter(|id| *id < (1 << 53))
        .ok_or_else(|| "invalid local frame id".into())
}

fn lock<T>(state: &Mutex<T>) -> MutexGuard<'_, T> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
