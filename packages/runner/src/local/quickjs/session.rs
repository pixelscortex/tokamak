use super::{Pool, frame_id, lock};
use crate::local::{Artifact, Request, provider, receive, send};
use axum::extract::ws::WebSocket;
use futures_util::{StreamExt, stream::FuturesUnordered};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tempfile::TempPath;
use tokamak_worker::{WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

const MAX_DEPTH: usize = 16;

enum Reply {
    Result(Value),
    Route(Artifact),
}

struct Pending {
    target: Option<String>,
    answer: oneshot::Sender<Reply>,
}

struct Bridge {
    output: mpsc::Sender<Value>,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
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

    fn answer(&self, id: u64, reply: Reply) -> Result<(), String> {
        let Some(pending) = lock(&self.pending).remove(&id) else {
            return Ok(()); // The invocation may have ended.
        };
        if let Reply::Route(artifact) = &reply
            && pending.target.as_deref() != Some(&artifact.id)
        {
            return Err("Local contract route does not match its host operation".into());
        }
        let _ = pending.answer.send(reply);
        Ok(())
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
    artifact: Artifact,
) -> Result<(), String> {
    let (output, mut outgoing) = mpsc::channel(WORKER_CAPACITY);
    let bridge = Arc::new(Bridge {
        output,
        next: AtomicU64::new(0),
        pending: Mutex::default(),
    });
    let mut active = HashMap::<u64, CancellationToken>::new();
    let mut calls = JoinSet::new();
    let mut providers = Vec::new();
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
                            let cancel = CancellationToken::new();
                            active.insert(id, cancel.clone());
                            let (artifact, pool, bridge) = (artifact.clone(), pool.clone(), bridge.clone());
                            calls.spawn(async move {
                                let label = format!("Plugin {} local function cancelled", artifact.id);
                                let response = tokio::select! {
                                    biased;
                                    () = cancel.cancelled() => Err(label),
                                    response = invoke(&pool, &bridge, id, &artifact, message, Vec::new()) => response,
                                };
                                (id, response)
                            });
                        }
                        Some("opResult") => bridge.answer(id, Reply::Result(message))?,
                        Some("cancel") => {
                            if let Some(cancel) = active.get(&id) {
                                cancel.cancel();
                            }
                        }
                        _ => return Err("Invalid local worker request".into()),
                    }
                }
                Some(Request::Route { id, artifact }) => bridge.answer(id, Reply::Route(artifact))?,
                Some(Request::Retire { artifact }) => pool.retire(artifact).await,
                Some(Request::Load { id, artifact }) => {
                    let response = load_provider(pool, &mut providers, id, artifact).await;
                    send(socket, response).await?;
                }
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

async fn load_provider(
    pool: &Pool,
    providers: &mut Vec<TempPath>,
    id: u32,
    artifact: Artifact,
) -> Value {
    let result = provider((*pool.plugins).clone(), artifact)
        .await
        .and_then(|code| {
            let path = code
                .to_str()
                .ok_or("Local provider path is not UTF-8")?
                .to_owned();
            providers.push(code);
            Ok(path)
        });
    match result {
        Ok(path) => json!({"type":"loaded", "id":id, "path":path}),
        Err(error) => json!({"type":"loaded", "id":id, "error":error}),
    }
}

fn result(id: u64, error: Option<&str>, value: Value) -> Value {
    json!({"type":"message","message":{"type":"result","id":id,"error":error,"value":value}})
}

fn invoke<'a>(
    pool: &'a Pool,
    bridge: &'a Bridge,
    root: u64,
    artifact: &'a Artifact,
    frame: Value,
    mut ancestors: Vec<String>,
) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
    Box::pin(async move {
        if ancestors.len() == MAX_DEPTH || ancestors.contains(&artifact.id) {
            return Err(format!(
                "Local contract call cycle or depth limit at plugin {}",
                artifact.id
            ));
        }
        ancestors.push(artifact.id.clone());
        let describe = frame["contract"].is_object() && frame["contract"]["method"].is_null();
        let mut call = pool.host(artifact, !describe).await?.begin(frame)?;
        let mut operations = FuturesUnordered::new();
        loop {
            tokio::select! {
                frame = call.next() => {
                    let frame = frame?;
                    if frame["type"] == "result" {
                        return Ok(frame);
                    }
                    // A crashed or cancelled caller drops its nested work.
                    operations.push(operation(pool, bridge, root, &ancestors, frame));
                }
                Some((id, response)) = operations.next() => {
                    let mut reply = match response {
                        Ok(reply) => reply,
                        Err(error) => json!({"error":error}),
                    };
                    reply["id"] = json!(id);
                    reply["type"] = json!("opResult");
                    call.host.send(&reply)?;
                }
            }
        }
    })
}

async fn operation(
    pool: &Pool,
    bridge: &Bridge,
    root: u64,
    ancestors: &[String],
    mut frame: Value,
) -> (u64, Result<Value, String>) {
    let id = frame["id"].as_u64().unwrap_or_default();
    let result = async {
        let host = ancestors.last().ok_or("Missing local invocation host")?;
        if frame["plugin"].is_null() && ancestors.len() > 1 {
            frame["plugin"] = json!(host);
        }
        frame["host"] = json!(host);
        let reply = bridge.request(frame.clone(), root).await?;
        let artifact = match reply {
            Reply::Route(artifact) => artifact,
            Reply::Result(value) => return Ok(value),
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
        let response = invoke(pool, bridge, root, &artifact, frame, ancestors.to_vec()).await?;
        if let Some(error) = response["error"].as_str() {
            return Err(error.to_owned());
        }
        Ok(json!({"value":response["value"]}))
    }
    .await;
    (id, result)
}
