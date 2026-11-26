//! Per-plugin process registry. A socket is a route back to a window's signed-in
//! workspace; its lifetime does not determine the lifetime of the process.
mod session;

pub(crate) use session::{action, connection};

use super::{Artifact, TIMEOUT, client_env, quickjs_bundle, stderr_tail, write};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet, hash_map::Entry as HashEntry},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::Duration,
};
use tempfile::TempPath;
use tokamak_worker::{Process, RestartBackoff, WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::{
    io::BufReader,
    net::UnixDatagram,
    sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot},
    time::Instant,
};
use tokio_util::{
    codec::{FramedRead, LinesCodec},
    sync::CancellationToken,
    task::{AbortOnDropHandle, TaskTracker},
};

const IDLE_GRACE: Duration = Duration::from_secs(2);
const RESTARTING: &str = "restarting after a crash; try again later";
// The manager needs a second half for short calls (controls and discovery).
const TURN_CAPACITY: usize = WORKER_CAPACITY / 2;
// Each provider also needs capacity to serve other kinds of local calls.
const PROVIDER_TURN_CAPACITY: usize = WORKER_CAPACITY / 4;

fn too_many_turns(limit: usize) -> String {
    format!("Too many turns are running on this machine ({limit}). Wait for one to finish.")
}

type Slots = HashMap<Artifact, Entry>;

#[derive(Clone)]
pub(crate) struct Pool {
    plugins: Arc<PathBuf>,
    env: Arc<BTreeMap<String, String>>,
    slots: Arc<Mutex<Slots>>,
    stopping: CancellationToken,
    tasks: TaskTracker,
    processes: Arc<Semaphore>,
    linked: Arc<Semaphore>,
    actions: Arc<Semaphore>,
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
pub(crate) struct Leases {
    pool: Pool,
    workspace: Arc<str>,
    used: Mutex<HashMap<Artifact, Arc<Lease>>>,
}

struct Lease {
    slots: Arc<Mutex<Slots>>,
    build: Artifact,
    slot: Arc<Slot>,
    retiring: CancellationToken,
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
    pub(crate) fn new(pool: &Pool, workspace: Arc<str>) -> Self {
        Self {
            pool: pool.clone(),
            workspace,
            used: Mutex::default(),
        }
    }

    fn get(&self, build: &Artifact) -> Result<Arc<Lease>, String> {
        let mut used = lock(&self.used);
        if let Some(lease) = used.get(build) {
            return Ok(lease.clone());
        }
        let mut slots = lock(&self.pool.slots);
        slots.retain(|other, entry| {
            if other == build || other.id != build.id {
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
                .map_err(|reason| format!("Plugin {} process: {reason}", build.id))?;
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
            retiring: CancellationToken::new(),
        });
        used.insert(build.clone(), lease.clone());
        Ok(lease)
    }

    fn retire(&self, build: &Artifact) {
        if let Some(entry) = lock(&self.pool.slots).get_mut(build) {
            entry.supersede(&self.workspace, || "local plugin build retired".into());
        }
        // Drop outside the registry lock: this may release the last lease.
        if let Some(lease) = lock(&self.used).remove(build) {
            lease.retiring.cancel();
        }
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

enum StartError {
    Artifact(String),
    Process(String),
}

impl From<String> for StartError {
    fn from(value: String) -> Self {
        Self::Process(value)
    }
}

impl From<&str> for StartError {
    fn from(value: &str) -> Self {
        value.to_owned().into()
    }
}

impl StartError {
    fn message(self, id: &str) -> String {
        let reason = match self {
            Self::Artifact(reason) | Self::Process(reason) => reason,
        };
        format!("Plugin {id} process: {reason}")
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
            linked: Arc::new(Semaphore::new(TURN_CAPACITY)),
            actions: Arc::new(Semaphore::new(WORKER_CAPACITY)),
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
        leases: Arc<Leases>,
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
                    pool.reconcile(&server, &mut previous, &leases).await;
                }
            }
        });
    }

    async fn reconcile(
        &self,
        server: &server::Server,
        previous: &mut HashSet<Artifact>,
        leases: &Leases,
    ) {
        if let Some(next) = local_catalog(server).await {
            for old in previous.difference(&next) {
                self.retire_private(old, &leases.workspace);
                leases.retire(old);
            }
            *previous = next;
        }
    }

    fn retire_private(&self, old: &Artifact, workspace: &str) {
        if let Some(entry) = lock(&self.slots).get_mut(old) {
            entry.supersede(workspace, || "local plugin build retired".into());
            // Older protocol clients did not send a workspace.
            entry.supersede("", || "local plugin build retired".into());
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
        build: &Artifact,
        slot: &Arc<Slot>,
        routed: bool,
    ) -> Result<Arc<Host>, String> {
        self.start_or_reuse(build, slot, routed)
            .await
            .map_err(|error| error.message(&build.id))
    }

    async fn start_or_reuse(
        &self,
        build: &Artifact,
        slot: &Arc<Slot>,
        routed: bool,
    ) -> Result<Arc<Host>, StartError> {
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
            let request = build.clone();
            let verified = tokio::task::spawn_blocking(move || quickjs_bundle(&root, &request));
            let code = tokio::time::timeout(TIMEOUT, verified)
                .await
                .map_err(|_| "local artifact verification stalled")?
                .map_err(|error| error.to_string())?
                .map_err(StartError::Artifact)?;
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
            match Host::start(build, slot, code, permit, self) {
                Ok(host) => {
                    state.current = Some(host.clone());
                    return Ok(host);
                }
                Err(error) => {
                    state.restart.failed(Instant::now(), false);
                    return Err(error.into());
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
    active: HashMap<u64, Inbox>,
    linked: HashSet<u64>,
    peers: HashMap<u64, (u64, oneshot::Sender<Value>)>,
}

#[derive(Clone)]
struct Inbox {
    frames: mpsc::Sender<Value>,
    overflow: CancellationToken,
}

impl Inbox {
    fn deliver(&self, frame: Value) {
        if let Err(mpsc::error::TrySendError::Full(_)) = self.frames.try_send(frame) {
            // A blocked invocation must not stop the host or its other calls.
            self.overflow.cancel();
        }
    }
}

struct Host {
    build: Artifact,
    action_ops: OnceLock<Result<session::WindowActionOps, String>>,
    calls: Mutex<Calls>,
    writes: mpsc::Sender<Vec<u8>>,
    native: AsyncMutex<UnixDatagram>,
    stopping: CancellationToken,
    ended: CancellationToken,
    reason: OnceLock<String>,
    started: Instant,
    stopped_at: OnceLock<Instant>,
}

impl Host {
    fn start(
        build: &Artifact,
        slot: &Arc<Slot>,
        code: TempPath,
        permit: OwnedSemaphorePermit,
        pool: &Pool,
    ) -> Result<Arc<Self>, String> {
        let id = &build.id;
        let cwd = pool.plugins.parent().unwrap_or(&pool.plugins);
        let (mut process, native) = Process::launch_plugin(id, &code, cwd, &pool.env)?;
        let native = UnixDatagram::from_std(native).map_err(|error| error.to_string())?;
        let (input, output, stderr) = process.pipes()?;
        let (writes, outgoing) = mpsc::channel(WORKER_CAPACITY);
        let host = Arc::new(Self {
            build: build.clone(),
            action_ops: OnceLock::new(),
            calls: Mutex::default(),
            writes,
            native: AsyncMutex::new(native),
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
            let mut calls = lock(&running.calls);
            calls.active.clear();
            calls.linked.clear();
            running.ended.cancel();
        });
        Ok(host)
    }

    fn authorize(&self, claimed: &Value) -> Result<(), String> {
        if claimed.is_null() || claimed.as_str().is_some_and(|id| id == self.build.id) {
            return Ok(());
        }
        Err(self.label(&format!("cannot claim plugin identity {claimed}")))
    }

    async fn begin(self: &Arc<Self>, frame: &mut Value) -> Result<Call, String> {
        // One op and one cancel per pending SDK slot, plus the final result.
        let (frames, receive) = mpsc::channel(2 * WORKER_CAPACITY + 1);
        let overflow = CancellationToken::new();
        let permit = self.writes.reserve().await.map_err(|_| self.error())?;
        let mut calls = lock(&self.calls);
        if self.stopping.is_cancelled() {
            return Err(self.error());
        }
        if calls.active.len() >= WORKER_CAPACITY {
            return Err(self.label("invocation capacity exceeded"));
        }
        let linked = frame["contract"]["channel"] == true;
        if linked && calls.linked.len() >= PROVIDER_TURN_CAPACITY {
            return Err(format!(
                "Too many {} turns are running ({PROVIDER_TURN_CAPACITY}). Wait for one to finish.",
                self.build.id
            ));
        }
        calls.next += 1;
        let id = calls.next;
        frame["id"] = json!(id);
        frame["routed"] = json!(true);
        let bytes = self.encode(frame)?;
        calls.active.insert(
            id,
            Inbox {
                frames,
                overflow: overflow.clone(),
            },
        );
        permit.send(bytes);
        if linked {
            calls.linked.insert(id);
        }
        Ok(Call {
            host: self.clone(),
            id,
            receive,
            overflow,
            finished: false,
        })
    }

    fn deliver(&self, frame: Value) -> Result<(), String> {
        let mut calls = lock(&self.calls);
        let recipient = match frame["type"].as_str() {
            Some("log") => {
                let level = frame["level"].as_str().unwrap_or("info");
                let text = frame["text"].as_str().unwrap_or("");
                tokamak_worker::log(format!("Plugin {} [{level}]: {text}", self.build.id));
                return Ok(());
            }
            Some("op" | "opCancel") => calls.active.get(&frame_id(&frame["call"])?).cloned(),
            Some("result") => {
                let id = frame_id(&frame["id"])?;
                calls.linked.remove(&id);
                calls.active.remove(&id)
            }
            Some("peerResult") => {
                let id = frame_id(&frame["id"])?;
                let call = frame_id(&frame["call"])?;
                if calls
                    .peers
                    .get(&id)
                    .is_some_and(|(owner, _)| *owner == call)
                    && let Some((_, send)) = calls.peers.remove(&id)
                {
                    let _ = send.send(frame);
                }
                return Ok(());
            }
            _ => return Err("invalid plugin host message".into()),
        };
        if let Some(recipient) = recipient {
            recipient.deliver(frame);
        }
        Ok(())
    }

    // Peer requests run inside an admitted call. The response table is bounded
    // separately; waiting for the shared pipe to have room never loses a report.
    async fn peer(&self, call: u64, channel: Option<u64>, payload: Value) -> Result<Value, String> {
        let (send, receive) = oneshot::channel();
        let id = {
            let mut calls = lock(&self.calls);
            if !calls.active.contains_key(&call) {
                return Err("Local contract channel ended".into());
            }
            if calls.peers.len() >= 2 * WORKER_CAPACITY {
                return Err(self.label("local contract channel capacity exceeded"));
            }
            calls.next += 1;
            let id = calls.next;
            calls.peers.insert(id, (call, send));
            id
        };
        let _pending = PeerRequest { host: self, id };
        self.send(&json!({"type":"peer","id":id,"call":call,"channel":channel,"payload":payload}))
            .await?;
        tokio::select! {
            frame = receive => frame.map_err(|_| self.label("local contract channel ended")),
            () = self.ended.cancelled() => Err(self.error()),
        }
    }

    fn encode(&self, frame: &Value) -> Result<Vec<u8>, String> {
        let mut bytes = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
        if bytes.len() >= WORKER_FRAME_BYTES {
            return Err(self.label("message exceeds 1 MiB"));
        }
        bytes.push(b'\n');
        Ok(bytes)
    }

    async fn send(&self, frame: &Value) -> Result<(), String> {
        self.writes
            .send(self.encode(frame)?)
            .await
            .map_err(|_| self.error())
    }

    async fn stop_programs(&self, call: u64) -> Result<(), String> {
        let request = async {
            let socket = self.native.lock().await;
            let id = call.to_le_bytes();
            socket.send(&id).await?;
            let mut reply = [0; 8];
            // A cancelled request can leave an acknowledgement in the socket.
            while socket.recv(&mut reply).await? != reply.len() || reply != id {}
            Ok::<(), std::io::Error>(())
        };
        tokio::select! {
            () = self.ended.cancelled() => Err(self.error()),
            result = tokio::time::timeout(Duration::from_secs(1), request) => result
                .map_err(|_| self.label("program stop did not respond"))?
                .map_err(|error| self.label(&format!("program stop failed: {error}"))),
        }
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
        format!("Plugin {} process: {reason}", self.build.id)
    }
}

struct Call {
    host: Arc<Host>,
    id: u64,
    receive: mpsc::Receiver<Value>,
    overflow: CancellationToken,
    finished: bool,
}

struct PeerRequest<'a> {
    host: &'a Host,
    id: u64,
}

impl Drop for PeerRequest<'_> {
    fn drop(&mut self) {
        lock(&self.host.calls).peers.remove(&self.id);
    }
}

impl Call {
    async fn next(&mut self) -> Result<Value, String> {
        let frame = tokio::select! {
            biased;
            () = self.overflow.cancelled() => return Err(self.host.label("invocation output queue full")),
            frame = self.receive.recv() => frame.ok_or_else(|| self.host.error())?,
        };
        self.finished = frame["type"] == "result";
        Ok(frame)
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if lock(&self.host.calls).active.contains_key(&self.id) {
            let host = self.host.clone();
            let id = self.id;
            tokio::spawn(async move {
                let _ = host.send(&json!({"type":"cancel", "id":id})).await;
                let mut calls = lock(&host.calls);
                calls.linked.remove(&id);
                calls.active.remove(&id);
            });
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
    fn a_full_invocation_inbox_does_not_block_another_call() {
        let inbox = || {
            let (frames, receive) = mpsc::channel(2 * WORKER_CAPACITY + 1);
            (
                Inbox {
                    frames,
                    overflow: CancellationToken::new(),
                },
                receive,
            )
        };
        let (busy, _receive) = inbox();
        let (other, mut receive) = inbox();
        for id in 0..WORKER_CAPACITY {
            busy.deliver(json!({"type":"op","id":id}));
            busy.deliver(json!({"type":"opCancel","id":id}));
        }
        let result = json!({"type":"result","value":true});
        busy.deliver(result.clone());
        assert!(
            !busy.overflow.is_cancelled(),
            "a full burst still leaves room for the result"
        );
        busy.deliver(json!({"type":"op","id":WORKER_CAPACITY}));
        assert!(busy.overflow.is_cancelled());
        other.deliver(result.clone());
        assert_eq!(receive.try_recv().unwrap(), result);
    }

    #[test]
    fn at_capacity_evicts_the_least_recently_used_unleased_build() {
        let now = Instant::now();
        let mut slots = Slots::new();
        let mut build = |id: &str, users, seconds_ago| {
            let build = Artifact {
                id: id.into(),
                entry_hash: String::new(),
                code_hash: String::new(),
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
