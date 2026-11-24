use super::{Build, Host, Lease, Leases, Pool, frame_id, lock};
use crate::local::{Request, receive, send};
use axum::extract::ws::WebSocket;
use futures_util::{
    StreamExt,
    future::{AbortHandle, Abortable, try_join_all},
    stream::FuturesUnordered,
};
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
    sync::{mpsc, oneshot},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

const MAX_DEPTH: usize = 16;

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
        let route = match build {
            Ok(build) if pending.target.as_deref() == Some(&build.artifact.id) => self
                .leases
                .get(&build)
                .map(Reply::Route)
                .unwrap_or_else(|error| Reply::Result(json!({"error":error, "unavailable":true}))),
            Ok(_) => Reply::Result(
                json!({"error":"Local contract route does not match its host operation"}),
            ),
            Err(error) => Reply::Result(json!({"error":error})),
        };
        let _ = pending.answer.send(route);
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
    // Temporary: turns still hold live objects in `ai`'s realm, so follow-ups
    // for a turn must reach the realm that started it, and the Runner has to
    // know `ai`'s function names to do that. TKM-247 and TKM-248 move turns
    // across processes and remove this block.
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
                return run(pool, bridge, root, &realm.host, frame, ancestors, None).await;
            }
        }
        if matches!(name, "working:list" | "working:stopAll") {
            let list = name == "working:list";
            return working(pool, bridge, root, lease, frame, ancestors, list).await;
        }
    }
    let host = pool.host(&lease.build, &lease.slot, false).await?;
    let binds_turn = id == "ai" && name == "run:turn";
    run(
        pool,
        bridge,
        root,
        &host,
        frame,
        ancestors,
        binds_turn.then_some(&turn),
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
            None,
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
    turn: Option<&Turn<'_>>,
) -> Result<Value, String> {
    let mut call = match host.begin(frame) {
        Ok(call) => call,
        Err(error) => return Err(host.call_error(error).await),
    };
    let mut operations = FuturesUnordered::new();
    let mut pending = HashMap::<u64, AbortHandle>::new();
    loop {
        tokio::select! {
            frame = call.next() => {
                let frame = frame?;
                if frame["type"] == "result" {
                    return Ok(frame);
                }
                let id = frame_id(&frame["id"])?;
                if frame["type"] == "opCancel" {
                    if let Some(handle) = pending.remove(&id) {
                        handle.abort();
                    }
                    continue;
                }
                let registration = if frame["cancellable"] == true {
                    let (handle, registration) = AbortHandle::new_pair();
                    if pending.insert(id, handle).is_some() {
                        return Err("Duplicate cancellable local host operation".into());
                    }
                    Some(registration)
                } else {
                    None
                };
                // A crashed or cancelled caller drops its nested work.
                let work = operation(pool, bridge, root, ancestors, host, frame, turn);
                operations.push(async move {
                    let response = match registration {
                        Some(registration) => Abortable::new(work, registration).await.ok(),
                        None => Some(work.await),
                    };
                    (id, response)
                });
            }
            Some((id, response)) = operations.next() => {
                pending.remove(&id);
                // Dropping a routed invocation sends cancel to the provider.
                let Some(response) = response else { continue };
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

async fn operation(
    pool: &Pool,
    bridge: &Bridge,
    root: u64,
    ancestors: &[String],
    host: &Arc<Host>,
    mut frame: Value,
    turn: Option<&Turn<'_>>,
) -> Result<Value, String> {
    host.authorize(&frame["plugin"])?;
    if frame["plugin"].is_null() && ancestors.len() > 1 {
        frame["plugin"] = json!(host.id);
    }
    frame["host"] = json!(host.id);
    let reply = bridge.request(frame.clone(), root).await?;
    let lease = match reply {
        Reply::Route(lease) => lease,
        Reply::Result(mut value) => {
            if frame["name"] == "local.contracts" && value["error"].is_null() {
                host.prepare_providers(&mut value)?;
            }
            if let Some(turn) = turn
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
    let response = match Box::pin(run(pool, bridge, root, &other, frame, &ancestors, None)).await {
        Ok(response) => response,
        Err(error) => return Ok(json!({"error":error, "unavailable":true})),
    };
    if let Some(error) = response["error"].as_str() {
        return Ok(
            json!({"error":format!("Plugin {}: {error}", artifact.id), "providerError":true}),
        );
    }
    Ok(json!({"value":response["value"]}))
}
