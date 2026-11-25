//! Bounded, transport-independent feature service. One coordinator linearizes
//! transactions and subscription refreshes; actions use the action process and
//! rejoin that coordinator only for nested query/mutation calls.
//! A session has ONE ordered output stream; transports must preserve its order.

pub use crate::protocol::Event;
use crate::protocol::{CallError, Request};
use crate::{
    data::{ChangeEvent, DataSpace, Database},
    host::{self, ReadSet},
};
use engine::{Bundle, OpRegistry, Pool};
use serde_json::Value as Json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Notify, broadcast, mpsc, oneshot, watch};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FunctionKind {
    Query,
    Mutation,
    Action,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Visibility {
    Public,
    PluginOnly,
    Internal,
}

impl Visibility {
    fn from_descriptor(function: &Json) -> Result<Self, Error> {
        if let Some(value) = function.get("visibility") {
            return match value.as_str() {
                Some("public") => Ok(Self::Public),
                Some("pluginOnly") => Ok(Self::PluginOnly),
                Some("internal") => Ok(Self::Internal),
                _ => Err(Error::Invalid("Invalid function visibility".into())),
            };
        }
        // Older installed bundles used flags. Decode once at the bundle boundary.
        let flag = |key| match function.get(key) {
            None => Ok(false),
            Some(value) => value
                .as_bool()
                .ok_or_else(|| Error::Invalid(format!("Function {key} flag must be boolean"))),
        };
        match (flag("internal")?, flag("pluginOnly")?) {
            (false, false) => Ok(Self::Public),
            (true, false) => Ok(Self::Internal),
            (false, true) => Ok(Self::PluginOnly),
            (true, true) => Err(Error::Invalid(
                "Conflicting function visibility flags".into(),
            )),
        }
    }
}

impl FunctionKind {
    fn from_wire(value: &Json) -> Option<Self> {
        match value.as_str()? {
            "query" => Some(Self::Query),
            "mutation" => Some(Self::Mutation),
            "action" => Some(Self::Action),
            _ => None,
        }
    }

    fn check_nested(self, other: Option<Self>) -> Result<(), String> {
        if Some(self) == other {
            Ok(())
        } else {
            Err("nested function kind does not match request".into())
        }
    }

    pub(crate) fn check_requested(self, payload: &Json) -> Result<(), String> {
        // Calls made through ctx.use do not specify a kind.
        payload.get("kind").map_or(Ok(()), |requested| {
            self.check_nested(Self::from_wire(requested))
        })
    }
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
    IndexBackfill(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => f.write_str("server/session is closed"),
            Self::Overloaded => f.write_str("server capacity exceeded; request was not admitted"),
            Self::SlowConsumer => f.write_str("session disconnected: output queue filled; reconnect and resubscribe (mutation outcomes may be unknown)"),
            Self::Invalid(message) | Self::IndexBackfill(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for Error {}

/// The caller's Tokio runtime must remain alive through close; embedded storage
/// belongs on that runtime, outside the JavaScript executors.
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
    auth: SessionAuth,
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

type Connection = (
    u64,
    mpsc::Receiver<Event>,
    Arc<AtomicBool>,
    mpsc::WeakSender<Event>,
);

pub(crate) struct SessionIdentity {
    caller: std::sync::RwLock<crate::identity::AuthContext>,
    revoked: tokio_util::sync::CancellationToken,
}

type SessionAuth = Arc<SessionIdentity>;

pub(crate) enum Command {
    Connect(SessionAuth, oneshot::Sender<Result<Connection, Error>>),
    UpdateUser(crate::identity::User, oneshot::Sender<()>),
    MemberAdded(crate::identity::User, oneshot::Sender<()>),
    MemberRemoved {
        id: String,
        user: Option<crate::identity::User>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    MemberAccountAbandoned {
        user: crate::identity::User,
        cleanup: sign_in::MemberAccountCleanup,
        reply: oneshot::Sender<()>,
    },
    RemoveUserWindowState(Vec<String>, oneshot::Sender<Result<(), String>>),
    Action(u64, SessionAuth, Action),
    Plugins(oneshot::Sender<Result<Json, Error>>),
    RunSignIn(sign_in::SignInRequest),
    SignInMethods(oneshot::Sender<Result<Vec<crate::plugins::SignInMethod>, Error>>),
    Reload(String, oneshot::Sender<Result<Json, Error>>),
    RunFunction(crate::actions::NestedCall),
    Asset(
        Option<String>,
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
        local_parent: Option<(usize, Option<String>)>,
    },
    Subscribe {
        id: u64,
        name: String,
        args: Json,
    },
    Unsubscribe(u64),
}

struct Subscription {
    query: SubscriptionQuery,
    reads: ReadSet,
    last: Option<Result<Json, CallError>>,
    dirty: bool,
    // A runtime/admission failure may not have reached all reads. Until a
    // successful run, changed tables conservatively invalidate this subscription.
    uncertain: bool,
}

#[derive(Clone)]
enum SubscriptionQuery {
    Builtin(builtin_queries::BuiltinQuery),
    Plugin { name: String, args: Json },
}

struct Client {
    auth: SessionAuth,
    output: mpsc::Sender<Event>,
    slow: Arc<AtomicBool>,
    subscriptions: BTreeMap<u64, Subscription>,
}

struct Coordinator {
    database: Database,
    pool: Arc<Pool>,
    bundle: Option<Arc<Bundle>>,
    kinds: BTreeMap<String, FunctionKind>,
    single_bundle_private: BTreeSet<String>,
    space: DataSpace,
    plugins: Option<Arc<crate::plugins::Loaded>>,
    plugin_root: Option<std::path::PathBuf>,
    changes: broadcast::Receiver<ChangeEvent>,
    action_process: Option<Arc<crate::host::action_process::Supervisor>>,
    legacy_action_source: Option<Arc<crate::host::action_process::Source>>,
    action_jobs: tokio::task::JoinSet<(u64, u64, Result<Json, String>)>,
    commands: mpsc::WeakSender<Command>,
    sessions: BTreeMap<u64, Client>,
    next_session: u64,
    cleanup: Arc<Notify>,
    closed: watch::Sender<Option<Result<(), Error>>>,
}

impl Coordinator {
    fn client_kind(&self, name: &str) -> Option<FunctionKind> {
        if self.single_bundle_private.contains(name) {
            return None;
        }
        self.kinds.get(name).copied()
    }
}

mod action_coordination;
mod builtin_queries;
mod command_loop;
mod delivery;
mod invocations;
mod plugin_control;
mod requests;
mod server;
mod session;
mod startup;
mod subscriptions;
mod window_state;

pub(crate) use startup::{InspectedBundle, inspect};

mod sign_in;
pub(crate) use sign_in::SignInError;
