//! Per-plugin process registry. A socket is a route back to a window's signed-in
//! workspace; its lifetime does not determine the lifetime of the process.
mod session;

pub(super) use session::connection;

use super::{
    Artifact, TIMEOUT, artifact, artifact_folder, client_env, snapshot, stderr_tail, write,
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet, hash_map::Entry as HashEntry},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::Duration,
};
use tempfile::TempPath;
use tokamak_worker::{Process, RestartBackoff, WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::{
    io::BufReader,
    sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, mpsc},
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

const IDLE_GRACE: Duration = Duration::from_secs(2);
const RESTARTING: &str = "restarting after a crash; try again later";

type Slots = HashMap<Build, Entry>;

#[derive(Clone)]
pub(super) struct Pool {
    plugins: Arc<PathBuf>,
    env: Arc<BTreeMap<String, String>>,
    slots: Arc<Mutex<Slots>>,
    stopping: CancellationToken,
    tasks: TaskTracker,
    processes: Arc<Semaphore>,
    turns: Arc<Mutex<session::Turns>>,
}

struct Entry {
    slot: Arc<Slot>,
    users: usize,
    obsolete: Option<String>,
    workspaces: HashSet<Arc<str>>,
    last_used: Instant,
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

// A socket remembers the builds it routes to. An invocation also holds its
// lease, so a catalog update or a disconnected window cannot retire it mid-call.
struct Leases {
    pool: Pool,
    workspace: Arc<str>,
    used: Mutex<HashMap<Build, Arc<Lease>>>,
}

struct Lease {
    slots: Arc<Mutex<Slots>>,
    build: Build,
    slot: Arc<Slot>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut slots = lock(&self.slots);
        if let HashEntry::Occupied(mut registered) = slots.entry(self.build.clone()) {
            let entry = registered.get_mut();
            entry.users -= 1;
            if entry.users == 0 {
                entry.last_used = Instant::now();
                // A socket that never invoked anything need not keep a slot.
                if entry.empty() {
                    registered.remove();
                }
            }
        }
    }
}

impl Leases {
    fn new(pool: &Pool, workspace: Arc<str>) -> Self {
        Self {
            pool: pool.clone(),
            workspace,
            used: Mutex::default(),
        }
    }

    fn get(&self, build: &Build) -> Result<Arc<Lease>, String> {
        let mut used = lock(&self.used);
        if let Some(lease) = used.get(build) {
            return Ok(lease.clone());
        }
        let mut slots = lock(&self.pool.slots);
        slots.retain(|other, entry| {
            if other == build || other.artifact.id != build.artifact.id {
                return true;
            }
            entry.supersede(&self.workspace, || {
                "superseded by another local plugin build".into()
            });
            if entry.users == 0 && entry.obsolete.is_some() {
                entry.stop();
                return false;
            }
            true
        });
        if !slots.contains_key(build) {
            evict_idle(&mut slots, WORKER_CAPACITY)
                .map_err(|reason| format!("Plugin {} process: {reason}", build.artifact.id))?;
        }
        let entry = slots.entry(build.clone()).or_insert_with(|| Entry {
            slot: Arc::default(),
            users: 0,
            obsolete: None,
            workspaces: HashSet::new(),
            last_used: Instant::now(),
        });
        entry.workspaces.insert(self.workspace.clone());
        entry.obsolete = None;
        entry.users += 1;
        let lease = Arc::new(Lease {
            slots: self.pool.slots.clone(),
            build: build.clone(),
            slot: entry.slot.clone(),
        });
        used.insert(build.clone(), lease.clone());
        Ok(lease)
    }

    fn retire(&self, build: &Build, changed: &str) {
        if let Some(entry) = lock(&self.pool.slots).get_mut(build) {
            entry.supersede(&self.workspace, || build.retirement(changed));
        }
        // Drop outside the registry lock: this may release the last lease.
        lock(&self.used).remove(build);
    }
}

fn evict_idle(slots: &mut Slots, capacity: usize) -> Result<(), &'static str> {
    if slots.len() < capacity {
        return Ok(());
    }
    let oldest = slots
        .iter()
        .filter(|(_, entry)| entry.users == 0)
        .min_by_key(|(_, entry)| entry.last_used)
        .map(|(build, _)| build.clone())
        .ok_or("local plugin process limit reached")?;
    if let Some(mut entry) = slots.remove(&oldest) {
        entry.obsolete = Some("idle local plugin process evicted to make room".into());
        entry.stop();
    }
    Ok(())
}

impl Entry {
    fn supersede(&mut self, workspace: &str, reason: impl FnOnce() -> String) {
        if self.workspaces.remove(workspace) {
            self.obsolete = Some(reason());
        }
    }

    fn empty(&self) -> bool {
        self.users == 0
            && self
                .slot
                .state
                .try_lock()
                .is_ok_and(|state| state.current.is_none() && state.restart.retry_at.is_none())
    }

    fn keep_during_sweep(&self) -> bool {
        if self.users != 0 || self.obsolete.is_none() || self.last_used.elapsed() < IDLE_GRACE {
            return true;
        }
        self.stop();
        false
    }

    fn stop(&self) {
        if let Some(reason) = &self.obsolete {
            let _ = self.slot.reason.set(reason.clone());
        }
        self.slot.retired.cancel();
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
        let pool = Self {
            plugins,
            env: Arc::new(env),
            slots: Arc::default(),
            stopping,
            tasks: TaskTracker::new(),
            processes: Arc::new(Semaphore::new(WORKER_CAPACITY)),
            turns: Arc::default(),
        };
        pool.sweep_idle();
        pool
    }

    pub(super) async fn wait(&self) {
        self.tasks.close();
        self.tasks.wait().await;
    }

    pub(super) fn observe(
        &self,
        server: &Arc<server::Server>,
        mut session: server::Session,
        workspace: Arc<str>,
    ) {
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
                    pool.reconcile(&server, &mut previous, &workspace).await;
                }
            }
        });
    }

    async fn reconcile(
        &self,
        server: &server::Server,
        previous: &mut HashSet<Artifact>,
        workspace: &str,
    ) {
        if let Some(next) = local_catalog(server).await {
            for old in previous.difference(&next) {
                self.retire_private(old, workspace);
            }
            *previous = next;
        }
    }

    fn retire_private(&self, old: &Artifact, workspace: &str) {
        for (build, entry) in lock(&self.slots).iter_mut() {
            if build.includes(old) {
                entry.supersede(workspace, || build.retirement(&old.id));
                // Older protocol clients did not send a workspace.
                entry.supersede("", || build.retirement(&old.id));
            }
        }
    }

    fn sweep_idle(&self) {
        let pool = self.clone();
        self.tasks.spawn(async move {
            loop {
                tokio::select! {
                    () = pool.stopping.cancelled() => return,
                    () = tokio::time::sleep(IDLE_GRACE) => {}
                }
                lock(&pool.slots).retain(|_, entry| entry.keep_during_sweep());
            }
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
            tokio::select! {
                biased;
                () = self.stopping.cancelled() => return Err("Runner stopped".into()),
                () = slot.retired.cancelled() => return Err(slot.retirement().into()),
                reused = state.reuse(routed) => if let Some(host) = reused? { return Ok(host); },
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
            let live = build.live.clone();
            let verified = tokio::task::spawn_blocking(move || {
                let (_, code) =
                    artifact(&root, &request.id, &request.entry_hash, &request.code_hash)?;
                let providers = live
                    .into_iter()
                    .map(|artifact| {
                        let code = live_snapshot(&root, &artifact);
                        (artifact.id, code)
                    })
                    .collect();
                Ok::<_, String>((code, providers))
            });
            let (code, providers) = tokio::time::timeout(TIMEOUT, verified)
                .await
                .map_err(|_| "local artifact verification stalled")?
                .map_err(|error| error.to_string())??;
            if self.stopping.is_cancelled() {
                return Err("Runner stopped".into());
            }
            if slot.retired.is_cancelled() {
                return Err(slot.retirement().into());
            }
            // An evicted process releases its permit only after it is reaped.
            let permit = tokio::select! {
                biased;
                () = self.stopping.cancelled() => return Err("Runner stopped".into()),
                () = slot.retired.cancelled() => return Err(slot.retirement().into()),
                permit = self.processes.clone().acquire_owned() => permit.map_err(|_| "Runner stopped")?,
            };
            match Host::start(build, slot, code, providers, permit, self) {
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

fn live_snapshot(root: &Path, artifact: &Artifact) -> Result<TempPath, String> {
    let folder = artifact_folder(
        root,
        &artifact.id,
        &artifact.entry_hash,
        &artifact.code_hash,
    )?;
    snapshot(&folder, "local.js", &artifact.code_hash)
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
    providers: HashMap<String, Result<TempPath, String>>,
    loaded: Mutex<HashSet<String>>,
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
        providers: HashMap<String, Result<TempPath, String>>,
        permit: OwnedSemaphorePermit,
        pool: &Pool,
    ) -> Result<Arc<Self>, String> {
        let id = &build.artifact.id;
        let cwd = pool.plugins.parent().unwrap_or(&pool.plugins);
        let mut process = Process::launch_plugin(id, &code, cwd, &pool.env)?;
        let (input, output, stderr) = process.pipes()?;
        let (writes, outgoing) = mpsc::channel(WORKER_CAPACITY);
        let host = Arc::new(Self {
            id: id.clone(),
            live: build.live.clone(),
            providers,
            loaded: Mutex::default(),
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
            let _permit = permit;
            let mut stderr = AbortOnDropHandle::new(tokio::spawn(stderr_tail(stderr)));
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
            let mut reason = tokio::select! {
                biased;
                () = slot.retired.cancelled() => slot.retirement().into(),
                () = running.stopping.cancelled() => "Runner stopped".into(),
                reason = process.exited() => reason,
                error = write(input, outgoing) => error,
                error = read => error.err().unwrap_or_else(|| "plugin host output closed".into()),
            };
            let _ = running.stopped_at.set(Instant::now());
            running.stopping.cancel();
            process.stop().await;
            // Reaping closes the host's pipe; a descendant holding it open
            // must not hold up delivery of the failure to callers.
            if let Ok(Ok(tail)) = tokio::time::timeout(Duration::from_secs(1), &mut stderr).await
                && !tail.is_empty()
            {
                reason.push_str(":\n");
                reason.push_str(&tail);
            }
            running.stop(reason);
            lock(&running.calls).active.clear();
            running.ended.cancel();
        });
        Ok(host)
    }

    fn prepare_providers(&self, frame: &mut Value) -> Result<(), String> {
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
            let path = self.providers[&artifact.id]
                .as_ref()
                .map_err(Clone::clone)?;
            let path = path.to_str().ok_or("Local provider path is not UTF-8")?;
            lock(&self.loaded).insert(artifact.id);
            candidate["path"] = json!(path);
        }
        Ok(())
    }

    fn authorize(&self, claimed: &Value) -> Result<(), String> {
        if claimed.is_null()
            || claimed
                .as_str()
                .is_some_and(|id| id == self.id || lock(&self.loaded).contains(id))
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
        frame["routed"] = json!(true);
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
            Some("op" | "opCancel") => calls.active.get(&frame_id(&frame["call"])?).cloned(),
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

    async fn call_error(&self, error: String) -> String {
        // A host can fail before accepting its first invoke. Wait for its
        // bounded diagnostic just as we do for already accepted calls.
        if self.stopping.is_cancelled() || self.writes.is_closed() {
            self.ended.cancelled().await;
            return self.error();
        }
        error
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_capacity_evicts_the_least_recently_used_unleased_build() {
        let now = Instant::now();
        let mut slots = Slots::new();
        let mut build = |id: &str, users, seconds_ago| {
            let build = Build {
                artifact: Artifact {
                    id: id.into(),
                    entry_hash: String::new(),
                    code_hash: String::new(),
                },
                live: Vec::new(),
            };
            let slot: Arc<Slot> = Arc::default();
            slots.insert(
                build,
                Entry {
                    slot: slot.clone(),
                    users,
                    obsolete: None,
                    workspaces: HashSet::new(),
                    last_used: now - Duration::from_secs(seconds_ago),
                },
            );
            slot
        };
        let busy = build("busy", 1, 30);
        let recent = build("recent", 0, 5);
        let old = build("old", 0, 20);
        assert!(evict_idle(&mut slots, 3).is_ok());
        assert!(old.retired.is_cancelled());
        assert!(!recent.retired.is_cancelled());
        assert!(!busy.retired.is_cancelled());

        assert!(evict_idle(&mut slots, 2).is_ok());
        assert!(recent.retired.is_cancelled());
        assert_eq!(
            evict_idle(&mut slots, 1),
            Err("local plugin process limit reached")
        );
        assert!(!busy.retired.is_cancelled());
    }
}
