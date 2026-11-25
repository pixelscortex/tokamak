use super::{Artifact, Host, Lease, Leases, Pool, TURN_CAPACITY, frame_id, lock, too_many_turns};
use crate::local::{Request, receive, send};
use axum::extract::ws::WebSocket;
use futures_util::{StreamExt, stream::FuturesUnordered};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};
use tokamak_worker::{CHAT_THREAD_ID_PREFIX, WORKER_CAPACITY, WORKER_FRAME_BYTES, next_call_depth};
use tokio::{
    sync::{Semaphore, mpsc, oneshot, watch},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

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

#[derive(Default)]
struct ChannelCalls {
    open: HashMap<u64, Arc<Channel>>,
    reaping: VecDeque<(u64, Peer)>,
}

type Channels = Mutex<ChannelCalls>;

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
        lock(self.channels).open.remove(&self.id);
    }
}

impl OpenChannel<'_> {
    fn keep_program_control(&self) {
        let Some(peer) = self.channel.provider.borrow().clone() else {
            return;
        };
        // The result ends messaging. Keep only a bounded native stop target
        // in the owning invocation while its provider's programs are reaped.
        let mut calls = lock(self.channels);
        if calls.reaping.len() == WORKER_CAPACITY {
            calls.reaping.pop_front();
        }
        calls.reaping.push_back((self.id, peer));
    }
}

enum Invocation<'a> {
    Root,
    Ordinary,
    Linked { origin: Peer, channel: &'a Channel },
}

enum Reply {
    Result(Value),
    Route(Arc<Lease>),
    Here,
}

enum Target {
    Own(Artifact),
    Other(String),
}

struct Pending {
    target: Option<Target>,
    answer: oneshot::Sender<Reply>,
}

struct Bridge {
    output: mpsc::Sender<Value>,
    next: AtomicU64,
    slots: Semaphore,
    pending: Mutex<HashMap<u64, Pending>>,
    leases: Leases,
    retiring: CancellationToken,
}

impl Bridge {
    async fn request(&self, mut frame: Value, root: u64, here: &Artifact) -> Result<Reply, String> {
        let (answer, receive) = oneshot::channel();
        let target = match frame["name"].as_str() {
            Some("local.contract.call" | "local.contract.describe") => {
                let id = frame["payload"]["plugin"]
                    .as_str()
                    .ok_or("Missing local contract provider")?;
                Some(if id == here.id {
                    Target::Own(here.clone())
                } else {
                    Target::Other(id.to_owned())
                })
            }
            _ => None,
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let _slot = self
            .slots
            .acquire()
            .await
            .map_err(|_| "Plugin process connection closed")?;
        lock(&self.pending).insert(id, Pending { target, answer });
        let _operation = Operation { bridge: self, id };
        frame["id"] = json!(id);
        frame["call"] = json!(root);
        self.output
            .send(json!({"type":"message", "message":frame}))
            .await
            .map_err(|_| "Plugin process connection closed")?;
        receive
            .await
            .map_err(|_| "Plugin process operation closed".into())
    }

    fn answer(&self, id: u64, reply: Reply) {
        if let Some(pending) = lock(&self.pending).remove(&id) {
            let _ = pending.answer.send(reply);
        }
    }

    fn route(&self, id: &Value, artifact: Value) {
        let Ok(id) = frame_id(id).and_then(|id| {
            (id != 0)
                .then_some(id)
                .ok_or_else(|| "zero operation id".into())
        }) else {
            let recovered = id
                .as_str()
                .and_then(|text| text.parse::<u64>().ok())
                .filter(|&id| id > 0 && id < (1 << 53));
            eprintln!("Invalid local contract route frame: expected a numeric operation ID");
            if let Some(id) = recovered {
                self.answer(
                    id,
                    Reply::Result(json!({"error":"Invalid local contract route operation ID"})),
                );
            }
            return;
        };
        let Some(pending) = lock(&self.pending).remove(&id) else {
            return; // The invocation may have ended.
        };
        let reply = match (serde_json::from_value::<Artifact>(artifact), pending.target) {
            (Ok(build), Some(Target::Own(current))) if build == current => Reply::Here,
            (Ok(build), Some(Target::Other(target))) if build.id == target => {
                self.leases.get(&build).map_or_else(
                    |error| Reply::Result(json!({"error":error, "unavailable":true})),
                    Reply::Route,
                )
            }
            (Ok(_), _) => Reply::Result(
                json!({"error":"Local contract route does not match its host operation"}),
            ),
            (Err(error), _) => {
                Reply::Result(json!({"error":format!("Invalid local contract route: {error}")}))
            }
        };
        let _ = pending.answer.send(reply);
    }

    fn retire(&self, current: &Artifact, artifact: Value) {
        let Ok(retired) = serde_json::from_value::<Artifact>(artifact) else {
            return; // Invalid retirement frames cannot affect admitted calls.
        };
        if &retired == current {
            self.retiring.cancel();
        }
        self.leases.retire(&retired);
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
    build: Artifact,
    workspace: String,
) -> Result<(), String> {
    let (output, mut outgoing) = mpsc::channel(WORKER_CAPACITY);
    if workspace.len() > 2048 {
        return Err("Invalid plugin process workspace".into());
    }
    let workspace: Arc<str> = workspace.into();
    let bridge = Arc::new(Bridge {
        output,
        next: AtomicU64::new(0),
        slots: Semaphore::new(WORKER_CAPACITY),
        pending: Mutex::default(),
        leases: Leases::new(pool, workspace),
        retiring: CancellationToken::new(),
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
                        return Err("Plugin process message exceeds 1 MiB".into());
                    }
                    let id = frame_id(&message["id"])?;
                    match message["type"].as_str() {
                        Some("invoke") if message.get("contract").is_none() => {
                            if active.contains_key(&id) {
                                return Err("Duplicate plugin process invocation".into());
                            }
                            if active.len() >= WORKER_CAPACITY {
                                send(socket, result(id, Some("Plugin process invocation capacity exceeded"), Value::Null)).await?;
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
                        _ => return Err("Invalid plugin process request".into()),
                    }
                }
                Some(Request::Route { id, artifact }) => bridge.route(&id, artifact),
                Some(Request::Retire { artifact }) => bridge.retire(&build, artifact),
                Some(Request::Load { .. }) => return Err("Plugin processes do not load other plugins".into()),
                Some(Request::Close) | None => return Ok(()),
                Some(Request::Start { .. }) => return Err("Plugin process already started".into()),
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
    let label = format!("Plugin {} local function cancelled", lease.build.id);
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
    mut frame: Value,
) -> Result<Value, String> {
    if let Some(fields) = frame.as_object_mut() {
        fields.remove("threadId");
    }
    let id = &lease.build.id;
    let ancestors = std::slice::from_ref(id);
    let host = pool.host(&lease.build, &lease.slot, false).await?;
    run(
        pool,
        bridge,
        root,
        &host,
        frame,
        ancestors,
        Invocation::Root,
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
    lock(channels).open.insert(id, channel.clone());
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
    mut frame: Value,
    ancestors: &[String],
    invocation: Invocation<'_>,
) -> Result<Value, String> {
    let mut call = match host.begin(&mut frame).await {
        Ok(call) => call,
        Err(error) => return Err(host.call_error(error).await),
    };
    let here = Peer {
        host: host.clone(),
        call: call.id,
        channel: None,
    };
    let channels = Channels::default();
    let thread = frame["threadId"]
        .as_str()
        .map_or_else(OnceLock::new, |id| OnceLock::from(id.to_owned()));
    let route = CallRoute {
        pool,
        bridge,
        root,
        ancestors,
        thread,
        args: &frame["args"],
    };
    let mut operations = FuturesUnordered::new();
    let mut pending = HashMap::<u64, CancellationToken>::new();
    let mut notify_retirement = matches!(invocation, Invocation::Root);
    if let Invocation::Linked { channel, .. } = &invocation {
        channel.provider.send_replace(Some(here.clone()));
    }
    loop {
        tokio::select! {
            () = bridge.retiring.cancelled(), if notify_retirement => {
                notify_retirement = false;
                host.send(&json!({"type":"retire", "id":call.id})).await?;
            }
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
                let mut reply = match response {
                    Some(Ok(reply)) => reply,
                    Some(Err(error)) => json!({"error":error}),
                    // Return the SDK's operation slot only after the Runner has
                    // consumed the operation and dropped its nested work.
                    None => json!({"error":"Local contract call cancelled"}),
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
    let (channel, reaping) = {
        let calls = lock(channels);
        let reaping = stop
            .then(|| calls.reaping.iter().find(|(call, _)| *call == id))
            .flatten()
            .map(|(_, peer)| peer.clone());
        (calls.open.get(&id).cloned(), reaping)
    };
    if let Some(peer) = reaping {
        peer.host.stop_programs(peer.call).await?;
        return Ok(json!({"value":null}));
    }
    let Some(channel) = channel else {
        return if stop {
            Ok(json!({"value":null}))
        } else {
            Err("Local contract channel ended".into())
        };
    };
    if close {
        channel.closed.cancel();
        return Ok(json!({"value":null}));
    }
    let mut provider = channel.provider.subscribe();
    if stop {
        let peer = tokio::select! {
            biased;
            result = provider.wait_for(Option::is_some) => result.ok().and_then(|peer| peer.clone()),
            () = channel.closed.cancelled() => None,
        };
        if let Some(peer) = peer {
            peer.host.stop_programs(peer.call).await?;
        }
        return Ok(json!({"value":null}));
    }
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

fn contains_string(value: &Value, needle: &str) -> bool {
    match value {
        Value::String(value) => value == needle,
        Value::Array(values) => values.iter().any(|value| contains_string(value, needle)),
        Value::Object(fields) => fields.values().any(|value| contains_string(value, needle)),
        _ => false,
    }
}

fn contract_target_name(plugin: &str, target: &Value) -> String {
    match target["method"].as_str() {
        Some(method) => format!("plugin {plugin}/{method}"),
        None => format!("plugin {plugin} contract {}", target["name"]),
    }
}

struct CallRoute<'a> {
    pool: &'a Pool,
    bridge: &'a Bridge,
    root: u64,
    ancestors: &'a [String],
    thread: OnceLock<String>,
    args: &'a Value,
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
            frame["plugin"] = json!(host.build.id);
        }
        let wants_note = frame["name"] == "auth.current" && frame["payload"]["call"] == true;
        self.attach_continuation(&mut frame, wants_note);
        let reply = self
            .bridge
            .request(frame.clone(), self.root, &host.build)
            .await?;
        let lease = match reply {
            Reply::Route(lease) => Some(lease),
            // An admitted call can use its own build while that build drains.
            // Reuse the running host without starting or leasing it again.
            Reply::Here => None,
            Reply::Result(mut value) => {
                if wants_note && value["value"].is_object() {
                    let note = value["value"].as_object_mut().expect("object checked");
                    note.remove("threadId");
                    if let Some(thread_id) = self.thread.get() {
                        note.insert("threadId".into(), json!(thread_id));
                    }
                    value["value"]["depth"] = json!(self.ancestors.len() - 1);
                }
                return Ok(value);
            }
        };
        self.invoke(
            lease.as_deref(),
            here,
            frame,
            opening,
            self.thread.get().map(String::as_str),
        )
        .await
    }

    fn attach_continuation(&self, frame: &mut Value, wants_note: bool) {
        let Some(fields) = frame.as_object_mut() else {
            return;
        };
        fields.remove("continuation");
        // The host dispatcher identifies a typed ID before running the handler.
        // Check it against the admitted arguments and retain the first thread in Rust.
        let candidate = fields.remove("threadId");
        if wants_note
            && self.thread.get().is_none()
            && let Some(thread) = candidate.as_ref().and_then(Value::as_str)
            && thread.starts_with(CHAT_THREAD_ID_PREFIX)
            && contains_string(self.args, thread)
        {
            let _ = self.thread.set(thread.to_owned());
        }

        if matches!(
            fields.get("name").and_then(Value::as_str),
            Some("local.runQuery" | "local.runMutation" | "local.runAction")
        ) {
            fields.insert(
                "continuation".into(),
                json!({
                    "depth": self.ancestors.len() - 1,
                    "thread": self.thread.get(),
                }),
            );
        }
    }

    async fn invoke(
        &self,
        lease: Option<&Lease>,
        here: &Peer,
        mut frame: Value,
        opening: Option<OpenChannel<'_>>,
        thread_id: Option<&str>,
    ) -> Result<Value, String> {
        let Self {
            pool,
            bridge,
            root,
            ancestors,
            ..
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
        let artifact = lease.map_or(&here.host.build, |lease| &lease.build);
        let name = contract_target_name(&artifact.id, &target);
        next_call_depth(ancestors.len() - 1, &name)?;
        if lease.is_some() && ancestors.contains(&artifact.id) {
            return Err(format!(
                "Local contract call cycle or depth limit at plugin {}",
                artifact.id
            ));
        }
        let frame = json!({
            "type":"invoke", "fn":"", "contract":target, "args":args, "threadId":thread_id
        });
        let mut ancestors = ancestors.to_vec();
        ancestors.push(artifact.id.clone());
        let other = match lease {
            None => here.host.clone(),
            Some(lease) => match pool.host(&lease.build, &lease.slot, true).await {
                Ok(other) => other,
                Err(error) => return Ok(json!({"error":error, "unavailable":true})),
            },
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
            let response = tokio::select! {
                biased;
                () = open.channel.closed.cancelled() => return Err("Local contract channel closed".into()),
                response = Box::pin(run(pool, bridge, root, &other, frame, &ancestors, Invocation::Linked {
                    origin,
                    channel: &open.channel,
                })) => response,
            };
            if response.is_ok() {
                open.keep_program_control();
            }
            response
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
        Ok(provider_result(response, &artifact.id, opening.is_some()))
    }
}

fn provider_result(response: Result<Value, String>, plugin: &str, linked: bool) -> Value {
    let response = match response {
        Ok(response) => response,
        Err(error) => return json!({"error":error, "unavailable":true}),
    };
    if let Some(error) = response["error"].as_str() {
        // An agent's error becomes the persisted turn reason.
        let error = if linked {
            error.to_owned()
        } else {
            format!("Plugin {plugin}: {error}")
        };
        return json!({"error":error, "providerError":true});
    }
    json!({"value":response["value"]})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn build(id: String) -> Artifact {
        Artifact {
            id,
            entry_hash: String::new(),
            code_hash: String::new(),
        }
    }

    #[tokio::test]
    async fn continuation_uses_only_the_admitted_ancestry_and_thread() {
        let pool = Pool::new(
            Default::default(),
            Default::default(),
            CancellationToken::new(),
        );
        let (output, _) = mpsc::channel(1);
        let bridge = Bridge {
            output,
            next: AtomicU64::new(0),
            slots: Semaphore::new(1),
            pending: Mutex::default(),
            leases: Leases::new(&pool, "".into()),
            retiring: CancellationToken::new(),
        };
        let route = CallRoute {
            pool: &pool,
            bridge: &bridge,
            root: 1,
            ancestors: &["first".into(), "second".into()],
            thread: OnceLock::new(),
            args: &json!({"selection": "chat/threads:admitted"}),
        };
        let mut auth = json!({
            "name": "auth.current",
            "payload": {"call": true},
            "continuation": {"depth": 0, "thread": "chat/threads:forged"},
            "threadId": "chat/threads:forged",
        });
        route.attach_continuation(&mut auth, true);
        assert_eq!(
            auth,
            json!({"name": "auth.current", "payload": {"call": true}})
        );
        assert!(route.thread.get().is_none());

        let mut query = json!({
            "name": "local.runQuery",
            "continuation": {"depth": 0, "thread": "chat/threads:forged"},
            "threadId": "chat/threads:forged",
        });
        route.attach_continuation(&mut query, false);
        assert_eq!(
            query,
            json!({"name": "local.runQuery", "continuation": {"depth": 1, "thread": null}})
        );
    }

    #[tokio::test]
    async fn a_full_process_pool_reports_a_hook_provider_as_unavailable() {
        let pool = Pool::new(
            Default::default(),
            Default::default(),
            CancellationToken::new(),
        );
        let (output, _) = mpsc::channel(1);
        let bridge = Bridge {
            output,
            next: AtomicU64::new(0),
            slots: Semaphore::new(1),
            pending: Mutex::default(),
            leases: Leases::new(&pool, "".into()),
            retiring: CancellationToken::new(),
        };
        for index in 0..WORKER_CAPACITY {
            bridge.leases.get(&build(format!("busy-{index}"))).unwrap();
        }
        let (answer, response) = oneshot::channel();
        lock(&bridge.pending).insert(
            1,
            Pending {
                target: Some(Target::Other("hook".into())),
                answer,
            },
        );
        bridge.route(
            &json!(1),
            json!({"id":"hook", "entryHash":"", "codeHash":""}),
        );
        let Reply::Result(value) = response.await.unwrap() else {
            panic!("a full pool cannot lease a hook provider");
        };
        assert_eq!(
            value,
            json!({
                "error": "Plugin hook process: local plugin process limit reached",
                "unavailable": true,
            })
        );
        pool.stopping.cancel();
        pool.wait().await;
    }
}
