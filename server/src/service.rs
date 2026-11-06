//! Bounded, transport-independent feature service. One coordinator linearizes
//! calls and subscription refreshes: less throughput than concurrent scheduling,
//! but one owned lifecycle and no stale-run generations or writer fence to leak.
//! A session has ONE ordered output stream; transports must preserve its order.

use crate::{
    data::{ChangeEvent, Database, Table},
    host::{self, ReadSet},
};
use runtime::{Bundle, OpRegistry, Pool};
use serde_json::Value as Json;
use std::{
    collections::BTreeMap,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Notify, broadcast, mpsc, oneshot};

const COMMANDS: usize = 64;
const OUTPUTS: usize = 32;
const SESSIONS: usize = 64;
const SUBSCRIPTIONS: usize = 128;
const ATTEMPTS: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Closed,
    Overloaded,
    SlowConsumer,
    Invalid(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => f.write_str("server/session is closed"),
            Self::Overloaded => f.write_str("server capacity exceeded; request was not admitted"),
            Self::SlowConsumer => f.write_str("session disconnected: output queue filled; reconnect and resubscribe (mutation outcomes may be unknown)"),
            Self::Invalid(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for Error {}

/// Results and updates deliberately share a queue. A mutation Response is
/// enqueued AFTER its subscribed writes, not on a racing oneshot reply path.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Response {
        id: u64,
        result: Result<Json, String>,
    },
    Subscription {
        id: u64,
        result: Result<Json, String>,
    },
    Unsubscribed {
        id: u64,
    },
}

/// Startup inspects the bundled SDK registry in a fresh QuickJS world. The
/// caller owns the Tokio host runtime and must keep it alive through close;
/// initialize embedded storage there, not on the time-only JS executors.
pub struct Server {
    commands: mpsc::Sender<Command>,
    descriptor: Json,
    cleanup: Arc<Notify>,
}

impl Server {
    pub async fn load(
        mut database: Database,
        pool: Arc<Pool>,
        bundle: Arc<Bundle>,
    ) -> Result<Self, Error> {
        let inspected = inspect(&pool, bundle.clone()).await;
        let (descriptor, kinds) = match inspected {
            Ok(inspected) => inspected,
            Err(error) => {
                return match Box::pin(database.close()).await {
                    Ok(()) => Err(error),
                    Err(close) => Err(Error::Invalid(format!(
                        "{error}; startup cleanup failed: {close}"
                    ))),
                };
            }
        };
        let changes = database.subscribe(); // Before any initial subscription run.
        let (commands, receiver) = mpsc::channel(COMMANDS);
        let cleanup = Arc::new(Notify::new());
        let actor = Coordinator {
            database,
            pool,
            bundle,
            kinds,
            changes,
            sessions: BTreeMap::new(),
            next_session: 0,
            cleanup: cleanup.clone(),
        };
        // Owning the task, rather than a caller future, shields accepted calls
        // through COMMIT, invalidation, and ordered delivery. Client cancellation
        // does not abort finalization. Process/runtime failure remains unknown.
        tokio::spawn(actor.run(receiver));
        Ok(Self {
            commands,
            descriptor,
            cleanup,
        })
    }

    pub fn descriptor(&self) -> &Json {
        &self.descriptor
    }

    pub fn functions(&self) -> &[Json] {
        self.descriptor["functions"]
            .as_array()
            .expect("validated descriptor")
    }

    pub async fn connect(&self) -> Result<Session, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Connect(reply))?;
        let (id, output, slow, alive) = wait.await.map_err(|_| Error::Closed)??;
        Ok(Session {
            sender: SessionSender {
                id,
                commands: self.commands.clone(),
                slow,
                alive,
            },
            output,
            cleanup: self.cleanup.clone(),
        })
    }

    /// Ordered behind accepted commands; shields shutdown even if this await is
    /// cancelled. Busy (a native transaction still retained externally) keeps
    /// the service live so callers can finish that transaction and retry close.
    pub async fn close(&self) -> Result<(), Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Close(reply))?;
        wait.await.map_err(|_| Error::Closed)?
    }
}

async fn inspect(
    pool: &Pool,
    bundle: Arc<Bundle>,
) -> Result<(Json, BTreeMap<String, bool>), Error> {
    let descriptor = pool
        .submit(
            bundle.clone(),
            "describe",
            Json::Null,
            Arc::new(OpRegistry::new()),
        )
        .map_err(|e| Error::Invalid(e.to_string()))?
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?;
    let mut kinds = BTreeMap::new();
    for function in descriptor
        .get("functions")
        .and_then(Json::as_array)
        .ok_or_else(|| Error::Invalid("bundle descriptor must list functions".into()))?
    {
        let name = function
            .get("name")
            .and_then(Json::as_str)
            .ok_or_else(|| Error::Invalid("invalid function name".into()))?;
        let mutation = match function.get("kind").and_then(Json::as_str) {
            Some("query") => false,
            Some("mutation") => true,
            _ => {
                return Err(Error::Invalid(
                    "function kind must be query or mutation".into(),
                ));
            }
        };
        if kinds.insert(name.to_owned(), mutation).is_some() {
            return Err(Error::Invalid("duplicate function name".into()));
        }
    }
    if descriptor.get("schema").is_none() {
        return Err(Error::Invalid(
            "bundle descriptor must include schema".into(),
        ));
    }
    Ok((descriptor, kinds))
}

/// IDs are chosen by the transport, scoped to this session. Request IDs should
/// be unique while outstanding. Subscription IDs must not be reused until the
/// ordered Unsubscribed event is consumed. Dropping this owner closes reception
/// and wakes cleanup even when the command queue is full.
pub struct Session {
    sender: SessionSender,
    output: mpsc::Receiver<Event>,
    cleanup: Arc<Notify>,
}

/// Clone this admission-only handle while one task owns Session::recv. No
/// mutex across an idle receive is needed, and replies still have ONE route.
#[derive(Clone)]
pub struct SessionSender {
    id: u64,
    commands: mpsc::Sender<Command>,
    slow: Arc<AtomicBool>,
    alive: mpsc::WeakSender<Event>,
}

impl SessionSender {
    /// Success means admitted, NOT committed. Read replies from recv in order.
    /// Losing the stream after admission means the mutation outcome is unknown;
    /// never blindly retry it. There is no cross-client deduplication protocol.
    pub fn call(&self, id: u64, name: impl Into<String>, args: Json) -> Result<(), Error> {
        self.send(Action::Call {
            id,
            name: name.into(),
            args,
        })
    }

    pub fn subscribe(&self, id: u64, name: impl Into<String>, args: Json) -> Result<(), Error> {
        self.send(Action::Subscribe {
            id,
            name: name.into(),
            args,
        })
    }

    pub fn unsubscribe(&self, id: u64) -> Result<(), Error> {
        self.send(Action::Unsubscribe(id))
    }

    fn send(&self, action: Action) -> Result<(), Error> {
        if self.slow.load(Ordering::Acquire) {
            return Err(Error::SlowConsumer);
        }
        if self.alive.upgrade().is_none_or(|sender| sender.is_closed()) {
            return Err(Error::Closed);
        }
        admit(&self.commands, Command::Action(self.id, action))
    }
}

impl Session {
    pub fn sender(&self) -> SessionSender {
        self.sender.clone()
    }

    pub fn call(&self, id: u64, name: impl Into<String>, args: Json) -> Result<(), Error> {
        self.sender.call(id, name, args)
    }

    pub fn subscribe(&self, id: u64, name: impl Into<String>, args: Json) -> Result<(), Error> {
        self.sender.subscribe(id, name, args)
    }

    pub fn unsubscribe(&self, id: u64) -> Result<(), Error> {
        self.sender.unsubscribe(id)
    }

    pub async fn recv(&mut self) -> Result<Option<Event>, Error> {
        match self.output.recv().await {
            Some(event) => Ok(Some(event)),
            None if self.sender.slow.load(Ordering::Acquire) => Err(Error::SlowConsumer),
            None => Ok(None),
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.output.close();
        self.cleanup.notify_one();
    }
}

fn admit(sender: &mpsc::Sender<Command>, command: Command) -> Result<(), Error> {
    sender.try_send(command).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => Error::Overloaded,
        mpsc::error::TrySendError::Closed(_) => Error::Closed,
    })
}

type Connection = (
    u64,
    mpsc::Receiver<Event>,
    Arc<AtomicBool>,
    mpsc::WeakSender<Event>,
);

enum Command {
    Connect(oneshot::Sender<Result<Connection, Error>>),
    Action(u64, Action),
    Close(oneshot::Sender<Result<(), Error>>),
}

enum Action {
    Call { id: u64, name: String, args: Json },
    Subscribe { id: u64, name: String, args: Json },
    Unsubscribe(u64),
}

struct Subscription {
    name: String,
    args: Json,
    reads: ReadSet,
    last: Option<Result<Json, String>>,
    dirty: bool,
    // A runtime/admission failure may not have reached all reads. Until a
    // successful run, changed tables conservatively invalidate this subscription.
    uncertain: bool,
}

struct Client {
    output: mpsc::Sender<Event>,
    slow: Arc<AtomicBool>,
    subscriptions: BTreeMap<u64, Subscription>,
}

struct Coordinator {
    database: Database,
    pool: Arc<Pool>,
    bundle: Arc<Bundle>,
    kinds: BTreeMap<String, bool>,
    changes: broadcast::Receiver<ChangeEvent>,
    sessions: BTreeMap<u64, Client>,
    next_session: u64,
    cleanup: Arc<Notify>,
}

impl Coordinator {
    async fn run(mut self, mut commands: mpsc::Receiver<Command>) {
        loop {
            self.sessions.retain(|_, client| !client.output.is_closed());
            tokio::select! {
                _ = self.cleanup.notified() => {},
                change = self.changes.recv() => {
                    match change {
                        Ok(change) => self.invalidate(Some(&change.tables)),
                        Err(broadcast::error::RecvError::Lagged(_)) => self.invalidate(None),
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                    self.refresh().await;
                }
                command = commands.recv() => match command {
                    Some(Command::Connect(reply)) => {
                        if self.sessions.len() >= SESSIONS || self.next_session == u64::MAX {
                            let _ = reply.send(Err(Error::Overloaded)); continue;
                        }
                        self.next_session += 1;
                        let id = self.next_session;
                        let (output, receiver) = mpsc::channel(OUTPUTS);
                        let slow = Arc::new(AtomicBool::new(false));
                        let alive = output.downgrade();
                        self.sessions.insert(id, Client { output, slow: slow.clone(), subscriptions: BTreeMap::new() });
                        if reply.send(Ok((id, receiver, slow, alive))).is_err() { self.sessions.remove(&id); }
                    }
                    Some(Command::Action(session, action)) => self.action(session, action).await,
                    Some(Command::Close(reply)) => {
                        let result = Box::pin(self.database.close()).await.map_err(|e| Error::Invalid(e.to_string()));
                        let done = result.is_ok();
                        let _ = reply.send(result);
                        if done { return; }
                    }
                    None => break,
                }
            }
        }
        // Last-handle drop is also graceful: no invocation is abandoned at an
        // await point by a disappearing client/server handle.
        let _ = Box::pin(self.database.close()).await;
    }

    fn emit(&mut self, session: u64, event: Event) {
        let Some(client) = self.sessions.get(&session) else {
            return;
        };
        if let Err(error) = client.output.try_send(event) {
            if matches!(error, mpsc::error::TrySendError::Full(_)) {
                client.slow.store(true, Ordering::Release);
            }
            // Never block a writer on a slow client. Close the ENTIRE session,
            // so dropping an update cannot be mistaken for an intact barrier.
            self.sessions.remove(&session);
        }
    }

    fn invalidate(&mut self, tables: Option<&[Table]>) {
        for client in self.sessions.values_mut() {
            for sub in client.subscriptions.values_mut() {
                if sub.uncertain
                    || tables
                        .is_none_or(|tables| tables.iter().any(|table| sub.reads.contains(table)))
                {
                    sub.dirty = true;
                }
            }
        }
    }

    fn drain_changes(&mut self) {
        // Bound time as well as space. A saturated/lagging receiver conservatively
        // invalidates everything; no growing table/event history is retained.
        for _ in 0..256 {
            match self.changes.try_recv() {
                Ok(change) => self.invalidate(Some(&change.tables)),
                Err(broadcast::error::TryRecvError::Lagged(_)) => self.invalidate(None),
                Err(_) => return,
            }
        }
        self.invalidate(None);
    }

    async fn action(&mut self, session: u64, action: Action) {
        if !self.sessions.contains_key(&session) {
            return;
        }
        match action {
            Action::Call { id, name, args } => {
                let result = match self.kinds.get(&name).copied() {
                    None => Err(format!("unknown function: {name}")),
                    Some(mutation) => {
                        let mut result = Err("mutation conflict retry limit exceeded".into());
                        for attempt in 0..ATTEMPTS {
                            let call = host::invoke(
                                &self.database,
                                &self.pool,
                                self.bundle.clone(),
                                &name,
                                args.clone(),
                                mutation,
                            )
                            .await;
                            if mutation && call.conflict {
                                if attempt + 1 == ATTEMPTS {
                                    break;
                                }
                                continue; // New transaction AND fresh JS world for the whole handler.
                            }
                            result = call.result;
                            break;
                        }
                        result
                    }
                };
                self.drain_changes();
                self.refresh().await; // Writer barrier precedes response on the SAME queue.
                self.emit(session, Event::Response { id, result });
            }
            Action::Subscribe { id, name, args } => {
                let client = self.sessions.get_mut(&session).expect("checked session");
                let error = if self.kinds.get(&name) != Some(&false) {
                    Some("subscriptions require a registered query")
                } else if client.subscriptions.contains_key(&id) {
                    Some("subscription ID already in use")
                } else if client.subscriptions.len() >= SUBSCRIPTIONS {
                    Some("subscription capacity exceeded")
                } else {
                    None
                };
                if let Some(error) = error {
                    // Invalid registration never replaces an existing subscription.
                    self.emit(
                        session,
                        Event::Response {
                            id,
                            result: Err(error.into()),
                        },
                    );
                    return;
                }
                client.subscriptions.insert(
                    id,
                    Subscription {
                        name,
                        args,
                        reads: ReadSet::new(),
                        last: None,
                        dirty: true,
                        uncertain: true,
                    },
                );
                self.drain_changes();
                self.refresh().await;
            }
            Action::Unsubscribe(id) => {
                self.sessions
                    .get_mut(&session)
                    .expect("checked session")
                    .subscriptions
                    .remove(&id);
                self.emit(session, Event::Unsubscribed { id });
            }
        }
    }

    async fn refresh(&mut self) {
        // Register before executing, then install the NEW readset before draining
        // events accumulated during that run. This includes initial/empty/get
        // dependencies, so a write to a newly read table cannot be lost.
        let mut reruns = BTreeMap::<(u64, u64), usize>::new();
        loop {
            self.sessions.retain(|_, client| !client.output.is_closed());
            let next = self.sessions.iter().find_map(|(&owner, client)| {
                client
                    .subscriptions
                    .iter()
                    .find(|(_, sub)| sub.dirty)
                    .map(|(&id, sub)| (owner, id, sub.name.clone(), sub.args.clone()))
            });
            let Some((owner, id, name, args)) = next else {
                return;
            };
            self.sessions
                .get_mut(&owner)
                .unwrap()
                .subscriptions
                .get_mut(&id)
                .unwrap()
                .dirty = false;
            let call = host::invoke(
                &self.database,
                &self.pool,
                self.bundle.clone(),
                &name,
                args,
                false,
            )
            .await;
            let sub = self
                .sessions
                .get_mut(&owner)
                .unwrap()
                .subscriptions
                .get_mut(&id)
                .unwrap();
            sub.reads = call.reads;
            sub.uncertain = call.result.is_err();
            self.drain_changes();
            let sub = self
                .sessions
                .get_mut(&owner)
                .unwrap()
                .subscriptions
                .get_mut(&id)
                .unwrap();
            if sub.dirty {
                let count = reruns.entry((owner, id)).or_default();
                *count += 1;
                if *count < 4 {
                    continue;
                }
                // Native transactions retained outside the service can keep
                // changing snapshots. End explicitly instead of publishing a
                // known-stale value or starving every command indefinitely.
                self.sessions
                    .get_mut(&owner)
                    .unwrap()
                    .subscriptions
                    .remove(&id);
                self.emit(
                    owner,
                    Event::Subscription {
                        id,
                        result: Err("subscription ended: snapshot kept changing".into()),
                    },
                );
                continue;
            }
            if sub.last.as_ref() != Some(&call.result) {
                sub.last = Some(call.result.clone()); // serde_json structural equality; no hash dependency.
                self.emit(
                    owner,
                    Event::Subscription {
                        id,
                        result: call.result,
                    },
                );
            }
        }
    }
}
