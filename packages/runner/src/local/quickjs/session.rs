use super::{Build, Host, Lease, Leases, Pool, frame_id, lock};
use crate::local::{Request, receive, send};
use axum::extract::ws::WebSocket;
use futures_util::{StreamExt, future::try_join_all, stream::FuturesUnordered};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokamak_worker::{WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

const MAX_DEPTH: usize = 16;

#[derive(Clone)]
struct Peer {
    host: Arc<Host>,
    call: u64,
    channel: Option<u64>,
}

impl Peer {
    async fn request(&self, payload: Value) -> Result<Value, String> {
        let response = self.host.peer(self.call, self.channel, payload).await?;
        if let Some(error) = response["error"].as_str() {
            return Err(error.into());
        }
        Ok(json!({"value":response["value"]}))
    }
}

struct Channel {
    provider: watch::Sender<Option<Peer>>,
    closed: CancellationToken,
}

type Channels = Mutex<HashMap<u64, Arc<Channel>>>;

// The forwarding capability exists only while the original routed call is
// active. It holds neither a new identity nor a route to another build.
struct OpenChannel<'a> {
    channels: &'a Channels,
    id: u64,
    channel: Arc<Channel>,
}

impl Drop for OpenChannel<'_> {
    fn drop(&mut self) {
        self.channel.closed.cancel();
        lock(self.channels).remove(&self.id);
    }
}

enum Invocation<'a> {
    Root(Option<&'a Turn<'a>>),
    Routed,
    Linked { origin: Peer, channel: &'a Channel },
}

enum Reply {
    Result(Value),
    Route(Arc<Lease>),
}

// A turn's callback and permission state lives in its original ai realm.
// The owning invocation registers its server-issued ID until that call ends.
#[derive(Default)]
pub(super) struct Turns(HashMap<(Arc<str>, String), TurnRealm>);

#[derive(Clone)]
struct TurnRealm {
    host: Arc<Host>,
    _lease: Arc<Lease>,
}

struct Turn<'a> {
    pool: &'a Pool,
    workspace: &'a Arc<str>,
    id: Mutex<Option<String>>,
    lease: &'a Arc<Lease>,
}

impl Turn<'_> {
    fn bind(&self, id: &str, host: &Arc<Host>) {
        let mut bound = lock(&self.id);
        if bound.is_none() {
            lock(&self.pool.turns).0.insert(
                (self.workspace.clone(), id.to_owned()),
                TurnRealm {
                    host: host.clone(),
                    _lease: self.lease.clone(),
                },
            );
            *bound = Some(id.to_owned());
        }
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        if let Some(id) = lock(&self.id).take() {
            lock(&self.pool.turns)
                .0
                .remove(&(self.workspace.clone(), id));
        }
    }
}

struct Pending {
    target: Option<String>,
    answer: oneshot::Sender<Reply>,
}

struct Bridge {
    output: mpsc::Sender<Value>,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
    leases: Leases,
}

impl Bridge {
    async fn request(&self, mut frame: Value, root: u64) -> Result<Reply, String> {
        let (answer, receive) = oneshot::channel();
        let target = match frame["name"].as_str() {
            Some("local.contract.call" | "local.contract.describe") => Some(
                frame["payload"]["plugin"]
                    .as_str()
                    .ok_or("Missing local contract provider")?
                    .to_owned(),
            ),
            _ => None,
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        {
            let mut pending = lock(&self.pending);
            if pending.len() == WORKER_CAPACITY {
                return Err("Local worker operation capacity exceeded".into());
            }
            pending.insert(id, Pending { target, answer });
        }
        let _operation = Operation { bridge: self, id };
        frame["id"] = json!(id);
        frame["call"] = json!(root);
        self.output
            .send(json!({"type":"message", "message":frame}))
            .await
            .map_err(|_| "Local worker connection closed")?;
        receive
            .await
            .map_err(|_| "Local worker operation closed".into())
    }

    fn answer(&self, id: u64, reply: Reply) {
        if let Some(pending) = lock(&self.pending).remove(&id) {
            let _ = pending.answer.send(reply);
        }
    }

    fn route(&self, id: u64, build: Result<Build, String>) {
        let Some(pending) = lock(&self.pending).remove(&id) else {
            return; // The invocation may have ended.
        };
        let route = build.and_then(|build| {
            if pending.target.as_deref() != Some(&build.artifact.id) {
                return Err("Local contract route does not match its host operation".into());
            }
            self.leases.get(&build).map(Reply::Route)
        });
        let _ = pending
            .answer
            .send(route.unwrap_or_else(|error| Reply::Result(json!({"error":error}))));
    }
}

struct Operation<'a> {
    bridge: &'a Bridge,
    id: u64,
}

impl Drop for Operation<'_> {
    fn drop(&mut self) {
        lock(&self.bridge.pending).remove(&self.id);
    }
}

pub(in crate::local) async fn connection(
    socket: &mut WebSocket,
    pool: &Pool,
    build: Build,
    workspace: String,
) -> Result<(), String> {
    let (output, mut outgoing) = mpsc::channel(WORKER_CAPACITY);
    if workspace.len() > 2048 {
        return Err("Invalid local worker workspace".into());
    }
    let workspace: Arc<str> = workspace.into();
    let bridge = Arc::new(Bridge {
        output,
        next: AtomicU64::new(0),
        pending: Mutex::default(),
        leases: Leases::new(pool, workspace),
    });
    let mut active = HashMap::<u64, CancellationToken>::new();
    let mut calls = JoinSet::new();
    bridge.leases.get(&build)?;
    send(socket, json!({"type":"started","routed":true})).await?;
    loop {
        tokio::select! {
            () = pool.stopping.cancelled() => return Ok(()),
            // The window is the authority on the remote workspace catalog.
            request = receive(socket) => match request? {
                Some(Request::Write { message }) => {
                    if serde_json::to_vec(&message).map_err(|e| e.to_string())?.len() >= WORKER_FRAME_BYTES {
                        return Err("Local worker message exceeds 1 MiB".into());
                    }
                    let id = frame_id(&message["id"])?;
                    match message["type"].as_str() {
                        Some("invoke") if message.get("contract").is_none() => {
                            if active.contains_key(&id) {
                                return Err("Duplicate local worker invocation".into());
                            }
                            if active.len() >= WORKER_CAPACITY {
                                send(socket, result(id, Some("Local worker invocation capacity exceeded"), Value::Null)).await?;
                                continue;
                            }
                            match bridge.leases.get(&build) {
                                Ok(lease) => {
                                    let cancel = CancellationToken::new();
                                    active.insert(id, cancel.clone());
                                calls.spawn(root_call(pool.clone(), bridge.clone(), id, lease, message, cancel));
                                }
                                Err(error) => send(socket, result(id, Some(&error), Value::Null)).await?,
                            }
                        }
                        Some("opResult") => bridge.answer(id, Reply::Result(message)),
                        Some("cancel") => {
                            if let Some(cancel) = active.get(&id) {
                                cancel.cancel();
                            }
                        }
                        _ => return Err("Invalid local worker request".into()),
                    }
                }
                Some(Request::Route { id, artifact, live }) => bridge.route(id, Build::new(artifact, live)),
                Some(Request::Retire { artifact, live, changed }) => {
                    // This notification is fire and forget. A malformed profile has no effect.
                    if let Ok(build) = Build::new(artifact, live) {
                        bridge.leases.retire(&build, &changed);
                    }
                }
                Some(Request::Load { .. }) => return Err("QuickJS loads providers through local.contracts".into()),
                Some(Request::Close) | None => return Ok(()),
                Some(Request::Start { .. }) => return Err("Local worker already started".into()),
            },
            Some(frame) = outgoing.recv() => send(socket, frame).await?,
            Some(completed) = calls.join_next() => {
                let (id, response) = completed.map_err(|error| error.to_string())?;
                active.remove(&id);
                let frame = match response {
                    Ok(mut frame) => {
                        frame["id"] = json!(id);
                        json!({"type":"message", "message":frame})
                    }
                    Err(error) => result(id, Some(&error), Value::Null),
                };
                send(socket, frame).await?;
            }
        }
    }
}

async fn root_call(
    pool: Pool,
    bridge: Arc<Bridge>,
    root: u64,
    lease: Arc<Lease>,
    frame: Value,
    cancel: CancellationToken,
) -> (u64, Result<Value, String>) {
    let label = format!(
        "Plugin {} local function cancelled",
        lease.build.artifact.id
    );
    let response = tokio::select! {
        biased;
        () = cancel.cancelled() => Err(label),
        response = invoke_root(&pool, &bridge, root, &lease, frame) => response,
    };
    (root, response)
}

fn result(id: u64, error: Option<&str>, value: Value) -> Value {
    json!({"type":"message","message":{"type":"result","id":id,"error":error,"value":value}})
}

async fn invoke_root(
    pool: &Pool,
    bridge: &Bridge,
    root: u64,
    lease: &Arc<Lease>,
    frame: Value,
) -> Result<Value, String> {
    let id = &lease.build.artifact.id;
    let ancestors = std::slice::from_ref(id);
    let workspace = &bridge.leases.workspace;
    let turn = Turn {
        pool,
        workspace,
        id: Mutex::default(),
        lease,
    };
    let name = frame["fn"].as_str().unwrap_or_default();
    // Temporary (TKM-248): live turn hooks can still replace ai's realm.
    // Follow-ups must reach a turn in its original, draining realm, even
    // when the current realm no longer has any live hooks.
    if id == "ai" {
        if matches!(
            name,
            "run:steer" | "run:stop" | "run:forceStop" | "run:answer" | "run:pending"
        ) && let Some(turn_id) = frame["args"]["turnId"].as_str()
        {
            let original = lock(&pool.turns)
                .0
                .get(&(workspace.clone(), turn_id.to_owned()))
                .cloned();
            if let Some(realm) = original {
                return run(
                    pool,
                    bridge,
                    root,
                    &realm.host,
                    frame,
                    ancestors,
                    Invocation::Root(None),
                )
                .await;
            }
        }
        if matches!(name, "working:list" | "working:stopAll") {
            let list = name == "working:list";
            return working(pool, bridge, root, lease, frame, ancestors, list).await;
        }
    }
    let host = pool.host(&lease.build, &lease.slot, false).await?;
    // A live hook can be added while a turn is running in a hook-free realm.
    let binds_turn = id == "ai" && name == "run:turn";
    run(
        pool,
        bridge,
        root,
        &host,
        frame,
        ancestors,
        Invocation::Root(binds_turn.then_some(&turn)),
    )
    .await
}

async fn working(
    pool: &Pool,
    bridge: &Bridge,
    root: u64,
    lease: &Arc<Lease>,
    frame: Value,
    ancestors: &[String],
    list: bool,
) -> Result<Value, String> {
    let current = pool.host(&lease.build, &lease.slot, false).await?;
    let mut realms = vec![TurnRealm {
        host: current,
        _lease: lease.clone(),
    }];
    for ((origin, _), realm) in &lock(&pool.turns).0 {
        if origin == &bridge.leases.workspace
            && !realms
                .iter()
                .any(|other| Arc::ptr_eq(&other.host, &realm.host))
        {
            realms.push(realm.clone());
        }
    }
    let calls = realms.iter().map(|realm| {
        run(
            pool,
            bridge,
            root,
            &realm.host,
            frame.clone(),
            ancestors,
            Invocation::Root(None),
        )
    });
    let mut count = 0;
    let mut turns = Vec::new();
    for mut reply in try_join_all(calls).await? {
        if !reply["error"].is_null() {
            return Ok(reply);
        }
        match reply["value"].take() {
            Value::Array(entries) if list => turns.extend(entries),
            value if !list => count += value.as_u64().unwrap_or_default(),
            _ => {}
        }
    }
    Ok(json!({"type":"result", "value":if list { json!(turns) } else { json!(count) }}))
}

async fn run(
    pool: &Pool,
    bridge: &Bridge,
    root: u64,
    host: &Arc<Host>,
    frame: Value,
    ancestors: &[String],
    invocation: Invocation<'_>,
) -> Result<Value, String> {
    let mut call = match host.begin(frame) {
        Ok(call) => call,
        Err(error) => return Err(host.call_error(error).await),
    };
    let here = Peer {
        host: host.clone(),
        call: call.id,
        channel: None,
    };
    let channels = Channels::default();
    let route = CallRoute {
        pool,
        bridge,
        root,
        ancestors,
    };
    let mut operations = FuturesUnordered::new();
    if let Invocation::Linked { channel, .. } = &invocation {
        channel.provider.send_replace(Some(here.clone()));
    }
    loop {
        tokio::select! {
            frame = call.next() => {
                let frame = frame?;
                if frame["type"] == "result" {
                    return Ok(frame);
                }
                // A crashed or cancelled caller drops its nested work.
                let id = frame["id"].as_u64().unwrap_or_default();
                let opening = if frame["name"] == "local.contract.call" && frame["channel"] == true
                    && frame["plugin"].is_null() {
                    let channel = Arc::new(Channel {
                        provider: watch::channel(None).0,
                        closed: CancellationToken::new(),
                    });
                    lock(&channels).insert(id, channel.clone());
                    Some(OpenChannel { channels: &channels, id, channel })
                } else {
                    None
                };
                let (channels, invocation, here, route) = (&channels, &invocation, &here, &route);
                operations.push(async move {
                    let response = match frame["name"].as_str() {
                        Some("local.contract.peer" | "local.contract.close") => {
                            peer_operation(channels, invocation, frame).await
                        }
                        _ => route.operation(here, frame, invocation, opening).await,
                    };
                    (id, response)
                });
            }
            Some((id, response)) = operations.next() => {
                let mut reply = match response {
                    Ok(reply) => reply,
                    Err(error) => json!({"error":error}),
                };
                reply["id"] = json!(id);
                reply["type"] = json!("opResult");
                if let Err(error) = host.send(&reply) {
                    return Err(host.call_error(error).await);
                }
            }
        }
    }
}

async fn peer_operation(
    channels: &Channels,
    invocation: &Invocation<'_>,
    mut frame: Value,
) -> Result<Value, String> {
    if !frame["plugin"].is_null() {
        return Err("A live provider cannot use the host's local contract channel".into());
    }
    let close = frame["name"] == "local.contract.close";
    let mut payload = frame["payload"].take();
    let fields = payload
        .as_object_mut()
        .ok_or("Invalid local contract channel request")?;
    if !close
        && (!fields.get("method").is_some_and(Value::is_string) || !fields.contains_key("args"))
    {
        return Err("Invalid local contract channel message".into());
    }
    let remote = fields.remove("channel").unwrap_or_default();
    if remote.is_null()
        && !close
        && let Invocation::Linked { origin, .. } = invocation
    {
        return origin.request(payload).await;
    }
    let id = frame_id(&remote)?;
    let channel = lock(channels)
        .get(&id)
        .cloned()
        .ok_or("Local contract channel ended")?;
    if close {
        channel.closed.cancel();
        return Ok(json!({"value":null}));
    }
    let mut provider = channel.provider.subscribe();
    tokio::select! {
        () = channel.closed.cancelled() => Err("Local contract channel ended".into()),
        response = async {
            let peer = provider.wait_for(Option::is_some).await
                .map_err(|_| "Local contract channel ended")?.clone()
                .ok_or("Local contract channel ended")?;
            peer.request(payload).await
        } => response,
    }
}

struct CallRoute<'a> {
    pool: &'a Pool,
    bridge: &'a Bridge,
    root: u64,
    ancestors: &'a [String],
}

impl CallRoute<'_> {
    async fn operation(
        &self,
        here: &Peer,
        mut frame: Value,
        invocation: &Invocation<'_>,
        opening: Option<OpenChannel<'_>>,
    ) -> Result<Value, String> {
        let host = &here.host;
        host.authorize(&frame["plugin"])?;
        if frame["plugin"].is_null() && self.ancestors.len() > 1 {
            frame["plugin"] = json!(host.id);
        }
        frame["host"] = json!(host.id);
        let reply = self.bridge.request(frame.clone(), self.root).await?;
        let lease = match reply {
            Reply::Route(lease) => lease,
            Reply::Result(mut value) => {
                if frame["name"] == "local.contracts" && value["error"].is_null() {
                    host.prepare_providers(&mut value)?;
                }
                if let Invocation::Root(Some(turn)) = invocation
                    && frame["name"] == "local.runMutation"
                    && frame["payload"]["name"] == "ai/turns:begin"
                    && frame["plugin"].is_null()
                    && value["error"].is_null()
                    && let Some(id) = value["value"]["turnId"].as_str()
                {
                    turn.bind(id, host);
                }
                return Ok(value);
            }
        };
        self.invoke(&lease, here, frame, opening).await
    }

    async fn invoke(
        &self,
        lease: &Lease,
        here: &Peer,
        mut frame: Value,
        opening: Option<OpenChannel<'_>>,
    ) -> Result<Value, String> {
        let Self {
            pool,
            bridge,
            root,
            ancestors,
        } = *self;
        let mut target = frame["payload"].take();
        let args = if frame["name"] == "local.contract.call" {
            target
                .as_object_mut()
                .and_then(|payload| payload.remove("args"))
                .filter(Value::is_array)
                .ok_or("Local contract arguments must be plain data in an array")?
        } else {
            Value::Null
        };
        if opening.is_some() {
            target["channel"] = json!(true);
        } else if let Some(target) = target.as_object_mut() {
            target.remove("channel");
        }
        let frame = json!({"type":"invoke", "fn":"", "contract":target, "args":args});
        let artifact = &lease.build.artifact;
        if ancestors.len() == MAX_DEPTH || ancestors.contains(&artifact.id) {
            return Err(format!(
                "Local contract call cycle or depth limit at plugin {}",
                artifact.id
            ));
        }
        let mut ancestors = ancestors.to_vec();
        ancestors.push(artifact.id.clone());
        let other = pool.host(&lease.build, &lease.slot, true).await?;
        let response = if let Some(open) = &opening {
            let origin = Peer {
                channel: Some(open.id),
                ..here.clone()
            };
            tokio::select! {
                biased;
                () = open.channel.closed.cancelled() => return Err("Local contract channel closed".into()),
                response = Box::pin(run(pool, bridge, root, &other, frame, &ancestors, Invocation::Linked {
                    origin,
                    channel: &open.channel,
                })) => response?,
            }
        } else {
            Box::pin(run(
                pool,
                bridge,
                root,
                &other,
                frame,
                &ancestors,
                Invocation::Routed,
            ))
            .await?
        };
        if let Some(error) = response["error"].as_str() {
            return Err(format!("Plugin {}: {error}", lease.build.artifact.id));
        }
        Ok(json!({"value":response["value"]}))
    }
}
