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

fn admit(sender: &mpsc::Sender<Command>, command: Command) -> Result<(), Error> {
    sender.try_send(command).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => Error::Overloaded,
        mpsc::error::TrySendError::Closed(_) => Error::Closed,
    })
}

type Connection = (u64, mpsc::Receiver<Event>, Arc<AtomicBool>, mpsc::WeakSender<Event>);

pub(crate) enum Command {
    Connect(oneshot::Sender<Result<Connection, Error>>),
    Action(u64, Action),
    Plugins(oneshot::Sender<Result<Json, Error>>),
    Reload(String, oneshot::Sender<Result<Json, Error>>),
    RunFunction(crate::actions::NestedCall),
    Asset(String, String, oneshot::Sender<Result<Option<Arc<crate::plugins::Asset>>, Error>>),
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

mod action_coordination;
mod command_loop;
mod delivery;
mod plugin_control;
mod requests;
mod server;
mod session;
mod startup;
mod subscriptions;

pub(crate) use startup::inspect;

mod invocations;
