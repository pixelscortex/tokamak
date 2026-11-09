//! Bounded, transport-independent feature service. One coordinator linearizes
//! transactions and subscription refreshes; actions use separate workers and
//! rejoin that coordinator only for nested query/mutation calls.
//! A session has ONE ordered output stream; transports must preserve its order.

pub use crate::protocol::Event;
use crate::protocol::Request;
use crate::{
    data::{ChangeEvent, DataSpace, Database},
    host::{self, ReadSet},
};
use engine::{Bundle, OpRegistry, Pool, PoolConfig};
use serde_json::Value as Json;
use std::{
    collections::BTreeMap,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Notify, broadcast, mpsc, oneshot, watch};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FunctionKind {
    Query,
    Mutation,
    Action,
}

const COMMANDS: usize = 64;
const OUTPUTS: usize = 32;
const SESSIONS: usize = 64;
const SUBSCRIPTIONS: usize = 128;
const ATTEMPTS: usize = 3;
const ACTIONS: usize = 34; // Two workers plus their bounded admission queue.

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

/// Startup inspects the bundled SDK registry in a fresh QuickJS world. The
/// caller owns the Tokio host runtime and must keep it alive through close;
/// initialize embedded storage there, not on the JS executors.
pub struct Server {
    commands: mpsc::Sender<Command>,
    // Shutdown must never compete for space with application calls.
    closing: mpsc::Sender<oneshot::Sender<Result<(), Error>>>,
    descriptor: Json,
    cleanup: Arc<Notify>,
    closed: watch::Receiver<Option<Result<(), Error>>>,
}

impl Server {
    pub async fn load(
        database: Database,
        pool: Arc<Pool>,
        bundle: Arc<Bundle>,
    ) -> Result<Self, Error> {
        Self::load_in_space(database, pool, bundle, DataSpace::default()).await
    }

    /// Kernel-selected plugin space. Callers cannot select it in request payloads.
    pub async fn load_in_space(
        mut database: Database,
        pool: Arc<Pool>,
        bundle: Arc<Bundle>,
        space: DataSpace,
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
        Self::start(
            database,
            pool,
            Some(bundle),
            space,
            descriptor,
            kinds,
            None,
            None,
        )
        .await
    }

    /// All static manifests resolve before any plugin module is evaluated.
    pub async fn load_plugins(
        mut database: Database,
        pool: Arc<Pool>,
        root: &std::path::Path,
    ) -> Result<Self, Error> {
        let loaded = match crate::plugins::Catalog::read(root) {
            Ok(catalog) => crate::plugins::Loaded::load(catalog, &pool).await,
            Err(error) => Err(error),
        };
        let loaded = match loaded {
            Ok(loaded) => Box::pin(loaded.record_grants(&database, None))
                .await
                .map(|()| loaded),
            Err(error) => Err(error),
        };
        let loaded = match loaded {
            Ok(loaded) => loaded,
            Err(error) => {
                return match Box::pin(database.close()).await {
                    Ok(()) => Err(error),
                    Err(close) => Err(Error::Invalid(format!(
                        "{error}; startup cleanup failed: {close}"
                    ))),
                };
            }
        };
        let kinds = loaded
            .targets
            .iter()
            .map(|(name, target)| (name.clone(), target.kind))
            .collect();
        Self::start(
            database,
            pool,
            None,
            DataSpace::default(),
            loaded.descriptor.clone(),
            kinds,
            Some(loaded),
            Some(root.to_owned()),
        )
        .await
    }

    async fn start(
        mut database: Database,
        pool: Arc<Pool>,
        bundle: Option<Arc<Bundle>>,
        space: DataSpace,
        descriptor: Json,
        kinds: BTreeMap<String, FunctionKind>,
        plugins: Option<Arc<crate::plugins::Loaded>>,
        plugin_root: Option<std::path::PathBuf>,
    ) -> Result<Self, Error> {
        let action_pool = match Pool::new_actions(PoolConfig {
            limits: pool.limits().clone(),
            ..PoolConfig::default()
        }) {
            Ok(pool) => Arc::new(pool),
            Err(error) => {
                Box::pin(database.close())
                    .await
                    .map_err(|e| Error::Invalid(format!("{error}; startup cleanup failed: {e}")))?;
                return Err(Error::Invalid(error.to_string()));
            }
        };
        let changes = database.subscribe(); // Before any initial subscription run.
        let (commands, receiver) = mpsc::channel(COMMANDS);
        let (closing, close_receiver) = mpsc::channel(1);
        let cleanup = Arc::new(Notify::new());
        let (closed_sender, closed) = watch::channel(None);
        let actor = Coordinator {
            database,
            pool,
            bundle,
            kinds,
            space,
            plugins,
            plugin_root,
            changes,
            action_pool,
            action_jobs: tokio::task::JoinSet::new(),
            commands: commands.downgrade(),
            sessions: BTreeMap::new(),
            next_session: 0,
            cleanup: cleanup.clone(),
            closed: closed_sender,
        };
        // Owning the task, rather than a caller future, shields accepted calls
        // through COMMIT, invalidation, and ordered delivery. Client cancellation
        // does not abort finalization. Process/runtime failure remains unknown.
        tokio::spawn(actor.run(receiver, close_receiver));
        Ok(Self {
            commands,
            closing,
            descriptor,
            cleanup,
            closed,
        })
    }

    pub fn descriptor(&self) -> &Json {
        &self.descriptor
    }

    /// Ordered live metadata. descriptor() remains the legacy startup snapshot.
    pub async fn plugins(&self) -> Result<Json, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Plugins(reply))?;
        wait.await.map_err(|_| Error::Closed)?
    }

    /// Replaces the complete installation generation, including dependent callers.
    pub async fn reload_plugin(&self, id: String) -> Result<Json, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Reload(id, reply))?;
        wait.await.map_err(|_| Error::Closed)?
    }

    pub async fn plugin_asset(
        &self,
        id: String,
        name: String,
    ) -> Result<Option<Arc<crate::plugins::Asset>>, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Asset(id, name, reply))?;
        wait.await.map_err(|_| Error::Closed)?
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
                wait_for_capacity: false,
            },
            output,
            cleanup: self.cleanup.clone(),
        })
    }

    /// Ordered behind accepted commands; shields shutdown even if this await is
    /// cancelled. Busy (a native transaction still retained externally) keeps
    /// the service live so callers can finish that transaction and retry close.
    pub async fn close(&self) -> Result<(), Error> {
        if let Some(result) = self.closed.borrow().clone() {
            return result;
        }
        let (reply, wait) = oneshot::channel();
        // The first request enters a dedicated one-slot control lane even when
        // application admission is saturated. Once enqueued, cancellation cannot
        // retract it. Concurrent close callers wait for control-lane capacity or
        // the retained outcome; they cannot grow an unbounded shutdown queue.
        if self.closing.send(reply).await.is_err() {
            return self.await_closed().await;
        }
        match wait.await {
            Ok(result) => result,
            Err(_) => self.await_closed().await,
        }
    }

    async fn await_closed(&self) -> Result<(), Error> {
        // A cancelled close caller does not own the shutdown barrier. Retain its
        // completed outcome so retries cannot report Closed before locks release.
        let mut closed = self.closed.clone();
        loop {
            if let Some(result) = closed.borrow_and_update().clone() {
                return result;
            }
            closed.changed().await.map_err(|_| Error::Closed)?;
        }
    }
}

pub(crate) async fn inspect(
    pool: &Pool,
    bundle: Arc<Bundle>,
) -> Result<(Json, BTreeMap<String, FunctionKind>), Error> {
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
            Some("query") => FunctionKind::Query,
            Some("mutation") => FunctionKind::Mutation,
            Some("action") => FunctionKind::Action,
            _ => {
                return Err(Error::Invalid(
                    "function kind must be query, mutation or action".into(),
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
    wait_for_capacity: bool,
}

impl SessionSender {
    /// Opt this Tower handle into awaitable capacity. Native owners that have
    /// already accepted messages into a bounded local mailbox use this mode
    /// while independently draining output. Headless peers retain fail-fast
    /// overload/disconnection semantics by default.
    pub fn with_backpressure(mut self) -> Self {
        self.wait_for_capacity = true;
        self
    }

    /// Success means admitted, NOT committed. Read replies from recv in order.
    /// Losing the stream after admission means the mutation outcome is unknown;
    /// never blindly retry it. There is no cross-client deduplication protocol.
    pub fn call(&self, id: u64, name: impl Into<String>, args: Json) -> Result<(), Error> {
        self.send(Action::Call {
            id,
            name: name.into(),
            args,
            kind: None,
        })
    }

    /// Common admission path for both adapters. Kind validation happens inside
    /// the ordered coordinator, so an invalid query cannot execute a mutation.
    pub fn request(&self, request: Request) -> Result<(), Error> {
        self.send(request_action(request)?)
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

    fn check_live(&self) -> Result<(), Error> {
        if self.slow.load(Ordering::Acquire) {
            return Err(Error::SlowConsumer);
        }
        if self.alive.upgrade().is_none_or(|sender| sender.is_closed()) {
            return Err(Error::Closed);
        }
        Ok(())
    }

    fn send(&self, action: Action) -> Result<(), Error> {
        self.check_live()?;
        admit(&self.commands, Command::Action(self.id, action))
    }
}

fn request_action(request: Request) -> Result<Action, Error> {
    if request.id() > 9_007_199_254_740_991 {
        return Err(Error::Invalid(
            "request ID must be a JavaScript safe integer".into(),
        ));
    }
    Ok(match request {
        Request::Query { id, name, args } => Action::Call {
            id,
            name,
            args,
            kind: Some(FunctionKind::Query),
        },
        Request::Mutation { id, name, args } => Action::Call {
            id,
            name,
            args,
            kind: Some(FunctionKind::Mutation),
        },
        Request::Action { id, name, args } => Action::Call {
            id,
            name,
            args,
            kind: Some(FunctionKind::Action),
        },
        Request::Subscribe { id, name, args } => Action::Subscribe { id, name, args },
        Request::Unsubscribe { id } => Action::Unsubscribe(id),
        Request::Plugins { id } => Action::Plugins(id),
        Request::PluginsPage {
            id,
            revision,
            offset,
        } => Action::PluginsPage {
            id,
            revision,
            offset,
        },
        Request::PluginAsset {
            id,
            plugin,
            name,
            revision,
            offset,
        } => Action::PluginAsset {
            id,
            plugin,
            name,
            revision,
            offset,
        },
    })
}

/// Tower is the common service boundary, not a second execution path. The
/// response acknowledges bounded admission; application replies use Event only.
/// Backpressured transports must bound pending calls and keep draining output
/// while admission waits. Cancellation before enqueueing never executes a call.
impl tower::Service<Request> for SessionSender {
    type Response = ();
    type Error = Error;
    type Future = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Error>> + Send>>;

    fn poll_ready(&mut self, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request) -> Self::Future {
        let sender = self.clone();
        Box::pin(async move {
            if !sender.wait_for_capacity {
                return sender.request(request);
            }
            let action = request_action(request)?;
            sender.check_live()?;
            // A permit is real bounded backpressure, not a retry of an operation
            // whose commit outcome might already be unknown.
            let permit = sender.commands.reserve().await.map_err(|_| Error::Closed)?;
            sender.check_live()?;
            permit.send(Command::Action(sender.id, action));
            Ok(())
        })
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

pub(crate) enum Command {
    Connect(oneshot::Sender<Result<Connection, Error>>),
    Action(u64, Action),
    Plugins(oneshot::Sender<Result<Json, Error>>),
    Reload(String, oneshot::Sender<Result<Json, Error>>),
    RunFunction(crate::actions::NestedCall),
    Asset(
        String,
        String,
        oneshot::Sender<Result<Option<Arc<crate::plugins::Asset>>, Error>>,
    ),
}

pub(crate) enum Action {
    Plugins(u64),
    PluginsPage {
        id: u64,
        revision: String,
        offset: u64,
    },
    PluginAsset {
        id: u64,
        plugin: String,
        name: String,
        revision: String,
        offset: u64,
    },
    Call {
        id: u64,
        name: String,
        args: Json,
        kind: Option<FunctionKind>,
    },
    Subscribe {
        id: u64,
        name: String,
        args: Json,
    },
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
    bundle: Option<Arc<Bundle>>,
    kinds: BTreeMap<String, FunctionKind>,
    space: DataSpace,
    plugins: Option<Arc<crate::plugins::Loaded>>,
    plugin_root: Option<std::path::PathBuf>,
    changes: broadcast::Receiver<ChangeEvent>,
    action_pool: Arc<Pool>,
    action_jobs: tokio::task::JoinSet<(u64, u64, Result<Json, String>)>,
    commands: mpsc::WeakSender<Command>,
    sessions: BTreeMap<u64, Client>,
    next_session: u64,
    cleanup: Arc<Notify>,
    closed: watch::Sender<Option<Result<(), Error>>>,
}

impl Coordinator {
    fn start_action(&mut self, session: u64, id: u64, name: String, args: Json) {
        if self.action_jobs.len() >= ACTIONS {
            self.emit(
                session,
                Event::Response {
                    id,
                    result: Err("action capacity exceeded".into()),
                },
            );
            return;
        }
        let (bundle, local_name, owner) = if let Some(loaded) = &self.plugins {
            let target = &loaded.targets[&name];
            (
                target.bundle.clone(),
                target.local_name.clone(),
                Some(target.owner.clone()),
            )
        } else {
            (self.bundle.clone().expect("legacy bundle"), name, None)
        };
        let pending =
            crate::actions::operations(self.commands.clone(), self.plugins.clone(), owner)
                .and_then(|ops| {
                    self.action_pool.submit(
                        bundle,
                        "invoke",
                        serde_json::json!({"name":local_name,"args":args}),
                        ops,
                    )
                });
        match pending {
            Ok(pending) => {
                self.action_jobs
                    .spawn(async move { (session, id, pending.await.map_err(|e| e.to_string())) });
            }
            Err(error) => self.emit(
                session,
                Event::Response {
                    id,
                    result: Err(error.to_string()),
                },
            ),
        }
    }

    async fn stop_actions(&mut self) {
        self.action_pool.cancel_actions();
        while let Some(completion) = self.action_jobs.join_next().await {
            if let Ok((session, id, result)) = completion {
                self.emit(session, Event::Response { id, result });
            }
        }
    }

    async fn run_function(&mut self, call: crate::actions::NestedCall) {
        let valid = (|| {
            match (&self.plugins, &call.generation, &call.owner) {
                (Some(current), Some(generation), Some(owner))
                    if Arc::ptr_eq(current, generation) =>
                {
                    let target = current.target(
                        owner,
                        &call.name,
                        call.kind == FunctionKind::Mutation,
                        &[],
                    )?;
                    if target.kind != call.kind {
                        return Err("nested function kind does not match request".to_owned());
                    }
                }
                (None, None, None) => {
                    if self.kinds.get(&call.name) != Some(&call.kind) {
                        return Err("nested function kind does not match request".to_owned());
                    }
                }
                _ => return Err("action belongs to a retired plugin generation".to_owned()),
            }
            Ok(())
        })();
        let result = match valid {
            Err(error) => Err(error),
            Ok(()) => {
                let mutation = call.kind == FunctionKind::Mutation;
                let mut result = Err("mutation conflict retry limit exceeded".into());
                let determinism = engine::Determinism::default();
                for attempt in 0..ATTEMPTS {
                    let nested = host::invoke(
                        &self.database,
                        &self.pool,
                        self.bundle.clone(),
                        &call.name,
                        call.args.clone(),
                        mutation,
                        &self.space,
                        self.plugins.clone(),
                        determinism,
                    )
                    .await;
                    if mutation && nested.conflict {
                        if attempt + 1 == ATTEMPTS {
                            break;
                        }
                        continue;
                    }
                    result = nested.result;
                    break;
                }
                self.drain_changes();
                self.refresh().await;
                result
            }
        };
        let _ = call.reply.send(result);
    }

    fn metadata(&self) -> Result<Json, Error> {
        let plugins = self.plugins.as_ref().ok_or_else(|| {
            Error::Invalid("Server uses a legacy bundle, not a plugin installation".into())
        })?;
        let mut metadata = plugins.catalog.metadata();
        metadata["functions"] = plugins.descriptor["functions"].clone();
        Ok(metadata)
    }

    fn catalog_page(&self, revision: Option<&str>, offset: u64) -> Result<Json, String> {
        let loaded = self.plugins.as_ref().ok_or("No plugin installation")?;
        if revision.is_some_and(|r| r != loaded.catalog.revision) {
            return Err("Plugin generation changed".into());
        }
        // Serialize once per generation, rather than once per page (quadratic
        // in catalog size). Paging bounds wire memory, never plugin count.
        let text = &loaded.catalog_text;
        let start = usize::try_from(offset).map_err(|_| "Invalid catalog offset")?;
        if start > text.len() || !text.is_char_boundary(start) {
            return Err("Invalid catalog offset".into());
        }
        // Byte pages also bound a single unusually large manifest. Escaping can
        // expand 8 KiB at most sixfold, safely below either transport's cap.
        let mut end = (start + 8192).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        Ok(
            serde_json::json!({"revision":loaded.catalog.revision, "text":&text[start..end], "next":end,"done":end == text.len()}),
        )
    }

    async fn control(&mut self, command: Command) {
        match command {
            Command::RunFunction(call) => self.run_function(call).await,
            Command::Plugins(reply) => {
                let _ = reply.send(self.metadata());
            }
            Command::Asset(id, name, reply) => {
                let result = self
                    .plugins
                    .as_ref()
                    .ok_or_else(|| Error::Invalid("No plugin installation".into()))
                    .map(|loaded| {
                        loaded
                            .catalog
                            .plugins
                            .get(&id)
                            .and_then(|plugin| plugin.ui_asset(&name))
                    });
                let _ = reply.send(result);
            }
            Command::Reload(id, reply) => {
                let result = self.reload(&id).await;
                let _ = reply.send(result);
            }
            _ => unreachable!("application commands have their own admission path"),
        }
    }

    async fn reload(&mut self, id: &str) -> Result<Json, Error> {
        let root = self
            .plugin_root
            .as_ref()
            .ok_or_else(|| Error::Invalid("No plugin installation to reload".into()))?;
        let catalog =
            crate::plugins::Catalog::read_reusing(root, self.plugins.as_ref().map(|p| &p.catalog))?;
        if !catalog.plugins.contains_key(id)
            && !self
                .plugins
                .as_ref()
                .is_some_and(|loaded| loaded.catalog.plugins.contains_key(id))
        {
            return Err(Error::Invalid(format!("Plugin is not installed: {id}")));
        }
        let candidate =
            crate::plugins::Loaded::load_reusing(catalog, &self.pool, self.plugins.as_deref())
                .await?;
        // Each generation gets a fresh action lane; build it before the swap so
        // a pool failure leaves the current generation fully intact.
        let action_pool = Arc::new(
            Pool::new_actions(PoolConfig {
                limits: self.pool.limits().clone(),
                ..PoolConfig::default()
            })
            .map_err(|e| Error::Invalid(e.to_string()))?,
        );
        Box::pin(candidate.record_grants(&self.database, self.plugins.as_deref())).await?;
        // This command follows every previously accepted invocation's complete
        // commit/rollback. Nothing below can fail before the generation swap.
        // Cancel old-generation actions so a reload cannot leave revoked network
        // grants running in old worlds; the old pool tears down detached.
        self.action_pool.cancel_actions();
        self.action_pool = action_pool;
        self.kinds = candidate
            .targets
            .iter()
            .map(|(name, target)| (name.clone(), target.kind))
            .collect();
        let mut changed = std::collections::BTreeSet::new();
        if let Some(previous) = &self.plugins {
            for (id, artifact) in &previous.catalog.plugins {
                if candidate.catalog.plugins.get(id).is_none_or(|next| {
                    serde_json::to_value(&artifact.manifest).ok()
                        != serde_json::to_value(&next.manifest).ok()
                }) {
                    changed.insert(id.clone());
                }
            }
            for id in candidate.catalog.plugins.keys() {
                if !previous.catalog.plugins.contains_key(id) {
                    changed.insert(id.clone());
                }
            }
        }
        self.plugins = Some(candidate);
        let catalog = self.metadata()?;
        // Use the same bounded ordered stream as data updates. A stale asset
        // request carries its catalog revision and cannot mix generations.
        for session in self.sessions.keys().copied().collect::<Vec<_>>() {
            self.emit(
                session,
                Event::PluginChanged {
                    plugins: changed.iter().cloned().collect(),
                    catalog: serde_json::json!({"revision": catalog["revision"], "paged": true}),
                },
            );
        }
        self.invalidate(None);
        self.refresh().await;
        self.metadata()
    }

    async fn run(
        mut self,
        mut commands: mpsc::Receiver<Command>,
        mut closing: mpsc::Receiver<oneshot::Sender<Result<(), Error>>>,
    ) {
        loop {
            self.sessions.retain(|_, client| !client.output.is_closed());
            tokio::select! {
                Some(reply) = closing.recv() => {
                    // Active native transactions remain finishable on Busy.
                    // No database owner can create a new one behind our check.
                    if self.database.has_transactions() {
                        let _ = reply.send(Err(Error::Invalid(crate::data::Error::Busy.to_string())));
                        continue;
                    }
                    commands.close();
                    // Finish every accepted command before the SDK lock-release
                    // barrier, even when the caller of close has disappeared.
                    while let Some(command) = commands.recv().await {
                        match command {
                            Command::Action(session, action) => self.action(session, action).await,
                            Command::Connect(reply) => { let _ = reply.send(Err(Error::Closed)); }
                            command => self.control(command).await,
                        }
                    }
                    self.stop_actions().await;
                    let result = Box::pin(self.database.close()).await.map_err(|e| Error::Invalid(e.to_string()));
                    self.closed.send_replace(Some(result.clone()));
                    let _ = reply.send(result);
                    return;
                }
                Some(completion) = self.action_jobs.join_next() => {
                    if let Ok((session,id,result)) = completion {
                        self.emit(session, Event::Response { id, result });
                    }
                }
                _ = self.cleanup.notified() => {},
                change = self.changes.recv() => {
                    match change {
                        Ok(change) => self.invalidate(Some(&change)),
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
                    Some(command) => self.control(command).await,
                    None => break,
                }
            }
        }
        // Last-handle drop is also graceful: no invocation is abandoned at an
        // await point by a disappearing client/server handle.
        self.stop_actions().await;
        let result = Box::pin(self.database.close())
            .await
            .map_err(|e| Error::Invalid(e.to_string()));
        self.closed.send_replace(Some(result));
    }

    fn emit(&mut self, session: u64, mut event: Event) {
        // Count serialized bytes without allocating an unbounded transport buffer.
        // Native routing envelopes are accounted for separately by the mailbox.
        struct Limit(usize);
        impl std::io::Write for Limit {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0 += bytes.len();
                if self.0 > engine::MAX_WIRE_MESSAGE_BYTES {
                    return Err(std::io::Error::other("result too large"));
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        if serde_json::to_writer(&mut Limit(0), &event).is_err() {
            event = match event {
                Event::Response { id, .. } => Event::Response {
                    id,
                    result: Err("result too large (1 MiB limit)".into()),
                },
                Event::Subscription { id, .. } => {
                    if let Some(client) = self.sessions.get_mut(&session) {
                        client.subscriptions.remove(&id);
                    }
                    // Response is also the protocol's terminal subscription
                    // failure: SDK releases its observer/capacity immediately.
                    Event::Response {
                        id,
                        result: Err("result too large (1 MiB limit); subscription ended".into()),
                    }
                }
                Event::PluginChanged { catalog, .. } => {
                    // The complete catalog is already paged. Clients diff it
                    // after assembly, so an arbitrarily large list of changed
                    // identities need not fit a single notification envelope.
                    Event::PluginChanged {
                        plugins: Vec::new(),
                        catalog,
                    }
                }
                _ => return,
            };
        }
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

    fn invalidate(&mut self, change: Option<&ChangeEvent>) {
        for client in self.sessions.values_mut() {
            for sub in client.subscriptions.values_mut() {
                if sub.uncertain || change.is_none_or(|change| sub.reads.affected(change)) {
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
                Ok(change) => self.invalidate(Some(&change)),
                Err(broadcast::error::TryRecvError::Lagged(_)) => self.invalidate(None),
                Err(_) => return,
            }
        }
        self.invalidate(None);
    }

    async fn action(&mut self, session: u64, action: Action) {
        // Admission transfers call ownership to the coordinator. Disconnect
        // retires subscriptions and delivery, not accepted mutations waiting in
        // the command queue. Shutdown must drain those calls too.
        if !self.sessions.contains_key(&session) && !matches!(&action, Action::Call { .. }) {
            return;
        }
        match action {
            Action::Plugins(id) => {
                let result = self.catalog_page(None, 0);
                self.emit(session, Event::Response { id, result });
            }
            Action::PluginsPage {
                id,
                revision,
                offset,
            } => {
                let result = self.catalog_page(Some(&revision), offset);
                self.emit(session, Event::Response { id, result });
            }
            Action::PluginAsset {
                id,
                plugin,
                name,
                revision,
                offset,
            } => {
                let result = (|| {
                    let loaded = self.plugins.as_ref().ok_or("No plugin installation")?;
                    if loaded.catalog.revision != revision {
                        return Err("Plugin generation changed".to_owned());
                    }
                    let bytes = loaded
                        .catalog
                        .plugins
                        .get(&plugin)
                        .and_then(|p| p.ui_asset(&name))
                        .ok_or("Unknown plugin UI asset")?;
                    bytes.page(offset).map_err(|e| e.to_string())
                })();
                self.emit(session, Event::Response { id, result });
            }
            Action::Call {
                id,
                name,
                args,
                kind: expected,
            } => {
                let result = match self.kinds.get(&name).copied() {
                    None => Err(format!("unknown function: {name}")),
                    Some(kind) if expected.is_some_and(|expected| expected != kind) => {
                        Err("function kind does not match request".into())
                    }
                    Some(FunctionKind::Action) => {
                        self.start_action(session, id, name, args);
                        return;
                    }
                    Some(kind) => {
                        let mutation = kind == FunctionKind::Mutation;
                        let mut result = Err("mutation conflict retry limit exceeded".into());
                        let determinism = engine::Determinism::default();
                        for attempt in 0..ATTEMPTS {
                            let call = host::invoke(
                                &self.database,
                                &self.pool,
                                self.bundle.clone(),
                                &name,
                                args.clone(),
                                mutation,
                                &self.space,
                                self.plugins.clone(),
                                determinism,
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
                let error = if self.kinds.get(&name) != Some(&FunctionKind::Query) {
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
            let call = if self.kinds.get(&name) == Some(&FunctionKind::Query) {
                host::invoke(
                    &self.database,
                    &self.pool,
                    self.bundle.clone(),
                    &name,
                    args,
                    false,
                    &self.space,
                    self.plugins.clone(),
                    engine::Determinism::default(),
                )
                .await
            } else {
                host::Call {
                    result: Err(
                        "Subscription query is not registered in this plugin generation".into(),
                    ),
                    reads: ReadSet::new(),
                    conflict: false,
                }
            };
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
