//! Per-plugin process registry. A socket is a route back to a window's signed-in
//! workspace; its lifetime does not determine the lifetime of the process.
mod session;

pub(super) use session::connection;

use super::{Artifact, TIMEOUT, artifact, client_env, provider, write};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
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

// Different installations of a plugin can coexist on one Runner. The live
// profile additionally separates realms that may import different builds.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Build {
    artifact: Artifact,
    live: Vec<Artifact>,
}

impl Build {
    pub(super) fn new(artifact: Artifact, mut live: Vec<Artifact>) -> Result<Self, String> {
        live.sort_unstable();
        if live.len() >= WORKER_CAPACITY
            || live.iter().any(|provider| provider.id == artifact.id)
            || live.windows(2).any(|pair| pair[0].id == pair[1].id)
        {
            return Err("Invalid local plugin live profile".into());
        }
        Ok(Self { artifact, live })
    }

    fn retirement(&self, changed: &str) -> String {
        if self.artifact.id == changed {
            "local plugin build retired".into()
        } else {
            format!("live provider {changed} changed; local realm retired")
        }
    }

    fn includes(&self, artifact: &Artifact) -> bool {
        &self.artifact == artifact || self.live.contains(artifact)
    }
}

const RESTARTING: &str = "restarting after a crash; try again later";

type Slots = HashMap<Build, Entry>;

#[derive(Clone)]
pub(super) struct Pool {
    plugins: Arc<PathBuf>,
    env: Arc<BTreeMap<String, String>>,
    slots: Arc<Mutex<Slots>>,
    stopping: CancellationToken,
    tasks: TaskTracker,
}

struct Entry {
    slot: Arc<Slot>,
    users: usize,
    obsolete: Option<String>,
}

#[derive(Default)]
struct Slot {
    state: AsyncMutex<SlotState>,
    retired: CancellationToken,
    reason: OnceLock<String>,
}

#[derive(Default)]
struct SlotState {
    current: Option<Arc<Host>>,
    restart: RestartBackoff,
}

// Each socket holds one lease per build it has used, including routed builds.
struct Leases {
    pool: Pool,
    used: Mutex<HashMap<Build, Arc<Slot>>>,
}

impl Leases {
    fn new(pool: &Pool) -> Self {
        Self {
            pool: pool.clone(),
            used: Mutex::default(),
        }
    }

    fn get(&self, build: &Build) -> Result<Arc<Slot>, String> {
        let mut used = lock(&self.used);
        if let Some(slot) = used.get(build) {
            return Ok(slot.clone());
        }
        let mut slots = lock(&self.pool.slots);
        if slots.len() >= WORKER_CAPACITY && !slots.contains_key(build) {
            return Err(format!(
                "Plugin {} process: local plugin process limit reached",
                build.artifact.id
            ));
        }
        let entry = slots.entry(build.clone()).or_insert_with(|| Entry {
            slot: Arc::default(),
            users: 0,
            obsolete: None,
        });
        entry.users += 1;
        used.insert(build.clone(), entry.slot.clone());
        Ok(entry.slot.clone())
    }

    fn retire(&self, build: &Build, changed: &str) {
        let mut used = lock(&self.used);
        let mut slots = lock(&self.pool.slots);
        if let Some(entry) = slots.get_mut(build) {
            if used.remove(build).is_some() {
                entry.users -= 1;
            }
            entry.obsolete = Some(build.retirement(changed));
            if !entry.keep() {
                slots.remove(build);
            }
        }
    }
}

impl Drop for Leases {
    fn drop(&mut self) {
        let mut used = lock(&self.used);
        let mut slots = lock(&self.pool.slots);
        for (build, _) in used.drain() {
            if let Some(entry) = slots.get_mut(&build) {
                entry.users -= 1;
            }
        }
        slots.retain(|_, entry| entry.keep());
    }
}

impl Entry {
    fn keep(&self) -> bool {
        if self.users > 0 {
            return true;
        }
        if let Some(reason) = &self.obsolete {
            let _ = self.slot.reason.set(reason.clone());
            self.slot.retired.cancel();
            return false;
        }
        // A failed verification or a socket that never invoked anything
        // should not leave an empty slot in the registry.
        !self
            .slot
            .state
            .try_lock()
            .is_ok_and(|state| state.current.is_none() && state.restart.retry_at.is_none())
    }
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
            let mut previous = local_catalog(&server).await.unwrap_or_default();
            loop {
                let event = tokio::select! {
                    () = pool.stopping.cancelled() => break,
                    event = session.recv() => event,
                };
                let Ok(Some(event)) = event else {
                    break;
                };
                if matches!(event, server::Event::PluginChanged { .. }) {
                    pool.reconcile(&server, &mut previous).await;
                }
            }
        });
    }

    async fn reconcile(&self, server: &server::Server, previous: &mut HashSet<Artifact>) {
        if let Some(next) = local_catalog(server).await {
            for old in previous.difference(&next) {
                self.retire_private(old);
            }
            *previous = next;
        }
    }

    fn retire_private(&self, old: &Artifact) {
        lock(&self.slots).retain(|build, entry| {
            if !build.includes(old) {
                return true;
            }
            entry.obsolete = Some(build.retirement(&old.id));
            entry.keep()
        });
    }

    async fn host(
        &self,
        build: &Build,
        slot: &Arc<Slot>,
        routed: bool,
    ) -> Result<Arc<Host>, String> {
        self.start_or_reuse(build, slot, routed)
            .await
            .map_err(|reason| format!("Plugin {} process: {reason}", build.artifact.id))
    }

    async fn start_or_reuse(
        &self,
        build: &Build,
        slot: &Arc<Slot>,
        routed: bool,
    ) -> Result<Arc<Host>, String> {
        loop {
            let mut state = slot.state.lock().await;
            if self.stopping.is_cancelled() {
                return Err("Runner stopped".into());
            }
            if slot.retired.is_cancelled() {
                return Err(slot.retirement().into());
            }
            if let Some(host) = state.reuse(routed).await? {
                return Ok(host);
            }
            if let Some(retry) = state
                .restart
                .retry_at
                .filter(|retry| *retry > Instant::now())
            {
                if routed {
                    return Err(RESTARTING.into());
                }
                drop(state);
                tokio::select! {
                    () = self.stopping.cancelled() => return Err("Runner stopped".into()),
                    () = slot.retired.cancelled() => return Err(slot.retirement().into()),
                    () = tokio::time::sleep_until(retry) => continue,
                }
            }
            let root = self.plugins.clone();
            let request = build.artifact.clone();
            let verified = tokio::task::spawn_blocking(move || {
                artifact(&root, &request.id, &request.entry_hash, &request.code_hash)
            });
            let (_, code) = tokio::time::timeout(TIMEOUT, verified)
                .await
                .map_err(|_| "local artifact verification stalled")?
                .map_err(|error| error.to_string())??;
            if self.stopping.is_cancelled() {
                return Err("Runner stopped".into());
            }
            if slot.retired.is_cancelled() {
                return Err(slot.retirement().into());
            }
            match Host::start(build, slot, code, self) {
                Ok(host) => {
                    state.current = Some(host.clone());
                    return Ok(host);
                }
                Err(error) => {
                    state.restart.failed(Instant::now(), false);
                    return Err(error);
                }
            }
        }
    }
}

async fn local_catalog(server: &server::Server) -> Option<HashSet<Artifact>> {
    let catalog = server.plugins().await.ok()?;
    Some(
        catalog["plugins"]
            .as_array()?
            .iter()
            .filter_map(|entry| {
                Some(Artifact {
                    id: entry["plugin"]["id"].as_str()?.to_owned(),
                    entry_hash: entry["hashes"]["local-entry.js"].as_str()?.to_owned(),
                    code_hash: entry["hashes"]["local.js"].as_str()?.to_owned(),
                })
            })
            .collect(),
    )
}

impl Slot {
    fn retirement(&self) -> &str {
        self.reason
            .get()
            .map_or("local plugin build retired", String::as_str)
    }
}

impl SlotState {
    async fn reuse(&mut self, routed: bool) -> Result<Option<Arc<Host>>, String> {
        let Some(host) = self.current.as_ref() else {
            return Ok(None);
        };
        if !host.stopping.is_cancelled() {
            return Ok(Some(host.clone()));
        }
        if routed && !host.ended.is_cancelled() {
            return Err(RESTARTING.into());
        }
        host.ended.cancelled().await;
        let stopped = host.stopped_at.get().copied().unwrap_or_else(Instant::now);
        self.restart.crashed(stopped, host.started);
        self.current = None;
        Ok(None)
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
    live: Vec<Artifact>,
    providers: Mutex<HashMap<String, TempPath>>,
    writes: mpsc::Sender<Vec<u8>>,
    stopping: CancellationToken,
    ended: CancellationToken,
    reason: OnceLock<String>,
    started: Instant,
    stopped_at: OnceLock<Instant>,
}

impl Host {
    fn start(
        build: &Build,
        slot: &Arc<Slot>,
        code: TempPath,
        pool: &Pool,
    ) -> Result<Arc<Self>, String> {
        let id = &build.artifact.id;
        let cwd = pool.plugins.parent().unwrap_or(&pool.plugins);
        let mut process = Process::launch_plugin(id, &code, cwd, &pool.env)?;
        let (input, output, mut stderr) = process.pipes()?;
        let (writes, outgoing) = mpsc::channel(WORKER_CAPACITY);
        let host = Arc::new(Self {
            id: id.clone(),
            live: build.live.clone(),
            providers: Mutex::default(),
            calls: Mutex::default(),
            writes,
            stopping: pool.stopping.child_token(),
            ended: CancellationToken::new(),
            reason: OnceLock::new(),
            started: Instant::now(),
            stopped_at: OnceLock::new(),
        });
        let running = host.clone();
        let slot = slot.clone();
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
                () = slot.retired.cancelled() => slot.retirement().into(),
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

    async fn prepare_providers(&self, pool: &Pool, frame: &mut Value) -> Result<(), String> {
        let Some(candidates) = frame["value"].as_array_mut() else {
            return Ok(());
        };
        for candidate in candidates {
            let entry = candidate
                .as_object_mut()
                .ok_or("Invalid local contract candidate")?;
            // Only Runner snapshots may be passed to the QuickJS loader.
            entry.remove("path");
            let Some(value) = entry.remove("artifact") else {
                continue;
            };
            let artifact: Artifact =
                serde_json::from_value(value).map_err(|error| error.to_string())?;
            if candidate["plugin"] != artifact.id || !self.live.contains(&artifact) {
                return Err(self.label("live provider does not match the realm profile"));
            }
            let path = self.load_provider(pool, artifact).await?;
            candidate["path"] = json!(path);
        }
        Ok(())
    }

    async fn load_provider(&self, pool: &Pool, artifact: Artifact) -> Result<String, String> {
        fn path(code: &TempPath) -> Result<String, String> {
            code.to_str()
                .map(str::to_owned)
                .ok_or("Local provider path is not UTF-8".into())
        }
        if let Some(code) = lock(&self.providers).get(&artifact.id) {
            return path(code);
        }
        let id = artifact.id.clone();
        let code = tokio::time::timeout(TIMEOUT, provider((*pool.plugins).clone(), artifact))
            .await
            .map_err(|_| "local provider verification stalled")??;
        // Concurrent requests may both verify a snapshot, but only the first
        // path is ever seen by QuickJS, so its import cache has one module.
        path(lock(&self.providers).entry(id).or_insert(code))
    }

    fn authorize(&self, claimed: &Value) -> Result<(), String> {
        if claimed.is_null()
            || claimed
                .as_str()
                .is_some_and(|id| id == self.id || lock(&self.providers).contains_key(id))
        {
            return Ok(());
        }
        Err(self.label(&format!("cannot claim plugin identity {claimed}")))
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
