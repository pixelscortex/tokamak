use super::{Build, Host, Lease, Leases, Pool, TURN_CAPACITY, frame_id, lock, too_many_turns};
use crate::local::{Request, receive, send};
use axum::extract::ws::WebSocket;
use futures_util::{StreamExt, stream::FuturesUnordered};
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
    sync::{Semaphore, mpsc, oneshot, watch},
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
    Ordinary,
    Linked { origin: Peer, channel: &'a Channel },
}

enum Reply {
    Result(Value),
    Route(Arc<Lease>),
}

struct Pending {
    target: Option<String>,
    answer: oneshot::Sender<Reply>,
}

struct Bridge {
    output: mpsc::Sender<Value>,
    next: AtomicU64,
    slots: Semaphore,
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
        let _slot = self
            .slots
            .acquire()
            .await
            .map_err(|_| "Local worker connection closed")?;
        lock(&self.pending).insert(id, Pending { target, answer });
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
        slots: Semaphore::new(WORKER_CAPACITY),
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
    let host = pool.host(&lease.build, &lease.slot, false).await?;
    run(
        pool,
        bridge,
        root,
        &host,
        frame,
        ancestors,
        Invocation::Ordinary,
    )
    .await
}

fn open_channel<'a>(channels: &'a Channels, id: u64, frame: &Value) -> Option<OpenChannel<'a>> {
    if frame["name"] != "local.contract.call"
        || frame["channel"] != true
        || !frame["plugin"].is_null()
    {
        return None;
    }
    let channel = Arc::new(Channel {
        provider: watch::channel(None).0,
        closed: CancellationToken::new(),
    });
    lock(channels).insert(id, channel.clone());
    Some(OpenChannel {
        channels,
        id,
        channel,
    })
}

async fn in_operation(
    route: &CallRoute<'_>,
    here: &Peer,
    channels: &Channels,
    invocation: &Invocation<'_>,
    frame: Value,
    opening: Option<OpenChannel<'_>>,
    cancel: Option<CancellationToken>,
) -> Option<Result<Value, String>> {
    let work = async {
        match frame["name"].as_str() {
            Some(
                "local.contract.peer" | "local.contract.close" | "local.contract.stopPrograms",
            ) => peer_operation(channels, invocation, frame).await,
            _ => route.operation(here, frame, opening).await,
        }
    };
    if let Some(cancel) = cancel {
        tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            response = work => Some(response),
        }
    } else {
        Some(work.await)
    }
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
    let mut call = match host.begin(frame).await {
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
    let mut pending = HashMap::<u64, CancellationToken>::new();
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
                let id = frame_id(&frame["id"])?;
                if frame["type"] == "opCancel" {
                    if let Some(cancel) = pending.get(&id) {
                        cancel.cancel();
                    }
                    continue;
                }
                let cancel = if frame["cancellable"] == true {
                    let cancel = CancellationToken::new();
                    if pending.insert(id, cancel.clone()).is_some() {
                        return Err("Duplicate cancellable local host operation".into());
                    }
                    Some(cancel)
                } else {
                    None
                };
                let opening = open_channel(&channels, id, &frame);
                let work = in_operation(&route, &here, &channels, &invocation, frame, opening, cancel);
                operations.push(async move { (id, work.await) });
            }
            Some((id, response)) = operations.next() => {
                pending.remove(&id);
                let Some(response) = response else { continue; };
                let mut reply = match response {
                    Ok(reply) => reply,
                    Err(error) => json!({"error":error}),
                };
                reply["id"] = json!(id);
                reply["type"] = json!("opResult");
                if let Err(error) = host.send(&reply).await {
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
    let method = frame["name"].as_str();
    let close = method == Some("local.contract.close");
    let stop = method == Some("local.contract.stopPrograms");
    let mut payload = frame["payload"].take();
    let fields = payload
        .as_object_mut()
        .ok_or("Invalid local contract channel request")?;
    if !close
        && !stop
        && (!fields.get("method").is_some_and(Value::is_string) || !fields.contains_key("args"))
    {
        return Err("Invalid local contract channel message".into());
    }
    let remote = fields.remove("channel").unwrap_or_default();
    if remote.is_null()
        && !close
        && !stop
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
            if stop {
                peer.host.stop_programs(peer.call).await?;
                Ok(json!({"value":null}))
            } else {
                peer.request(payload).await
            }
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
        let other = match pool.host(&lease.build, &lease.slot, true).await {
            Ok(other) => other,
            Err(error) => return Ok(json!({"error":error, "unavailable":true})),
        };
        let response = if let Some(open) = &opening {
            let _slot = pool
                .linked
                .try_acquire()
                .map_err(|_| too_many_turns(TURN_CAPACITY))?;
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
                })) => response,
            }
        } else {
            Box::pin(run(
                pool,
                bridge,
                root,
                &other,
                frame,
                &ancestors,
                Invocation::Ordinary,
            ))
            .await
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => return Ok(json!({"error":error, "unavailable":true})),
        };
        if let Some(error) = response["error"].as_str() {
            return Ok(json!({
                "error":format!("Plugin {}: {error}", artifact.id),
                "providerError":true,
            }));
        }
        Ok(json!({"value":response["value"]}))
    }
}
