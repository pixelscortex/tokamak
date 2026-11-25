//! Shared request/reply framing for the device-authenticated machine socket.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Semaphore, mpsc, oneshot},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

pub const PATH: &str = "/machine";
pub const STAGE_PLANS_HEADER: &str = "x-tokamak-runner-plans";
pub const STAGE_PLANS: &str = "hooks-and-points";
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
pub const HEARTBEAT_LIMIT: Duration = Duration::from_secs(15);
pub const DUPLICATE: u16 = 4002;
pub(crate) const CAPACITY: usize = 128;

pub fn heartbeat() -> (Duration, Duration) {
    fn setting(name: &str, default: Duration) -> Duration {
        std::env::var(name)
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|&ms| ms > 0)
            .map_or(default, Duration::from_millis)
    }
    let interval = setting("TOKAMAK_MACHINE_HEARTBEAT_INTERVAL_MS", HEARTBEAT_INTERVAL);
    let limit = setting("TOKAMAK_MACHINE_HEARTBEAT_LIMIT_MS", HEARTBEAT_LIMIT);
    if interval < limit {
        (interval, limit)
    } else {
        (HEARTBEAT_INTERVAL, HEARTBEAT_LIMIT)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Packet {
    Request {
        id: u64,
        request: Request,
    },
    Reply {
        id: u64,
        result: Result<Value, ReplyError>,
    },
    Cancel {
        id: u64,
    },
    Retire {
        id: u64,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    Invoke {
        plugin: String,
        entry_hash: String,
        code_hash: String,
        name: String,
        args: Value,
    },
    Operation {
        root: u64,
        scope: u64,
        name: String,
        payload: Value,
    },
}

// Keep ordinary errors compatible with existing machine connections. Typed
// errors carry the details needed to report an unavailable hook or point.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReplyError {
    Message(String),
    Call(CallReplyError),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallReplyError {
    message: String,
    details: Option<Value>,
    limit: Option<Limit>,
    artifact_unavailable: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Limit {
    Depth,
    Modules,
}

impl From<String> for ReplyError {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<&str> for ReplyError {
    fn from(message: &str) -> Self {
        Self::Message(message.into())
    }
}

impl From<engine::CallError> for ReplyError {
    fn from(error: engine::CallError) -> Self {
        if error.details.is_none() && error.limit.is_none() && error.kind.is_none() {
            Self::Message(error.message)
        } else {
            Self::Call(CallReplyError {
                message: error.message,
                details: error.details,
                limit: error.limit.map(|limit| match limit {
                    engine::CallLimit::Depth => Limit::Depth,
                    engine::CallLimit::Modules => Limit::Modules,
                }),
                artifact_unavailable: error.kind
                    == Some(engine::CallErrorKind::RunnerArtifactUnavailable),
            })
        }
    }
}

impl From<ReplyError> for engine::CallError {
    fn from(error: ReplyError) -> Self {
        match error {
            ReplyError::Message(message) => message.into(),
            ReplyError::Call(error) => Self {
                message: error.message,
                details: error.details,
                limit: error.limit.map(|limit| match limit {
                    Limit::Depth => engine::CallLimit::Depth,
                    Limit::Modules => engine::CallLimit::Modules,
                }),
                kind: error
                    .artifact_unavailable
                    .then_some(engine::CallErrorKind::RunnerArtifactUnavailable),
            },
        }
    }
}

type Pending = oneshot::Sender<Result<Value, ReplyError>>;

#[derive(Clone)]
pub struct Peer(Arc<State>);

struct State {
    next: AtomicU64,
    tx: mpsc::Sender<Packet>,
    pending: Mutex<HashMap<u64, Pending>>,
    slots: Semaphore,
    stop: CancellationToken,
}

struct PendingCall<'a> {
    peer: &'a Peer,
    id: u64,
}

impl Drop for PendingCall<'_> {
    fn drop(&mut self) {
        if self
            .peer
            .0
            .pending
            .lock()
            .expect("machine pending calls")
            .remove(&self.id)
            .is_some()
        {
            self.peer.send(Packet::Cancel { id: self.id });
        }
    }
}

impl Peer {
    pub fn new() -> (Self, mpsc::Receiver<Packet>) {
        let (tx, rx) = mpsc::channel(CAPACITY);
        (
            Self(Arc::new(State {
                next: AtomicU64::new(1),
                tx,
                pending: Mutex::default(),
                slots: Semaphore::new(CAPACITY),
                stop: CancellationToken::new(),
            })),
            rx,
        )
    }

    pub fn next_id(&self) -> u64 {
        self.0.next.fetch_add(1, Ordering::Relaxed)
    }

    pub fn stop(&self) -> &CancellationToken {
        &self.0.stop
    }

    pub async fn call(&self, id: u64, request: Request) -> Result<Value, ReplyError> {
        let _slot = self
            .0
            .slots
            .try_acquire()
            .map_err(|_| "Machine request capacity exceeded")?;
        let (reply, wait) = oneshot::channel();
        self.0
            .pending
            .lock()
            .expect("machine pending calls")
            .insert(id, reply);
        let _pending = PendingCall { peer: self, id };
        self.send(Packet::Request { id, request });
        tokio::select! {
            biased;
            () = self.stop().cancelled() => Err("Machine connection lost".into()),
            result = wait => result.map_err(|_| "Machine connection lost")?,
        }
    }

    pub fn retire(&self, id: u64) {
        self.send(Packet::Retire { id });
    }

    fn send(&self, packet: Packet) {
        if self.0.tx.try_send(packet).is_err() {
            self.stop().cancel();
        }
    }
}

#[derive(Default)]
pub struct Incoming {
    jobs: JoinSet<u64>,
    active: HashMap<u64, (CancellationToken, CancellationToken)>,
}

impl Incoming {
    pub async fn reap(&mut self) -> bool {
        if self.jobs.is_empty() {
            return std::future::pending().await;
        }
        if let Some(Ok(id)) = self.jobs.join_next().await {
            self.active.remove(&id);
            true
        } else {
            false
        }
    }

    pub fn receive<F, Fut>(&mut self, peer: &Peer, packet: Packet, handle: F)
    where
        F: FnOnce(u64, Request, CancellationToken) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<Value, ReplyError>> + Send + 'static,
    {
        match packet {
            Packet::Reply { id, result } => {
                if let Some(reply) = peer
                    .0
                    .pending
                    .lock()
                    .expect("machine pending calls")
                    .remove(&id)
                {
                    let _ = reply.send(result);
                }
            }
            Packet::Cancel { id } => {
                if let Some((cancel, _)) = self.active.get(&id) {
                    cancel.cancel();
                }
            }
            Packet::Retire { id } => {
                if let Some((_, retiring)) = self.active.get(&id) {
                    retiring.cancel();
                }
            }
            Packet::Request { id, request } => {
                if self.active.contains_key(&id) {
                    peer.stop().cancel();
                    return;
                }
                if self.active.len() >= CAPACITY {
                    peer.send(Packet::Reply {
                        id,
                        result: Err("Machine request capacity exceeded".into()),
                    });
                    return;
                }
                let peer = peer.clone();
                let cancel = peer.stop().child_token();
                let retiring = CancellationToken::new();
                self.active.insert(id, (cancel.clone(), retiring.clone()));
                self.jobs.spawn(async move {
                    tokio::select! {
                        biased;
                        () = cancel.cancelled() => {},
                        result = handle(id, request, retiring) => peer.send(Packet::Reply { id, result }),
                    }
                    id
                });
            }
        }
    }

    pub async fn shutdown(mut self) {
        while self.jobs.join_next().await.is_some() {}
    }
}
