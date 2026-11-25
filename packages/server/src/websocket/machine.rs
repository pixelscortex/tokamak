use super::*;
use crate::{
    RunnerAction, RunnerActionUpstream,
    machine_wire::{self, Incoming, Packet, Peer, Request},
};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex};

pub(super) async fn upgrade(
    State(adapter): State<Adapter>,
    Extension(auth): Extension<AuthContext>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(revoked) = adapter.identities.issued_device(&auth) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(permit) = adapter.connections.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    ws.protocols([WS_PROTOCOL])
        .max_frame_size(MESSAGE_BYTES)
        .max_message_size(MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            connection(socket, adapter, auth, revoked).await;
        })
        .into_response()
}

type Scopes = Arc<Mutex<HashMap<u64, Arc<Scope>>>>;
struct Scope {
    upstreams: Mutex<HashMap<u64, Arc<RunnerActionUpstream>>>,
    ended: CancellationToken,
}

struct Invocation<'a> {
    scopes: &'a Scopes,
    root: u64,
    ended: CancellationToken,
}

impl Drop for Invocation<'_> {
    fn drop(&mut self) {
        self.ended.cancel();
        self.scopes
            .lock()
            .expect("machine scopes")
            .remove(&self.root);
    }
}

async fn dispatch(peer: Peer, scopes: Scopes, action: RunnerAction) -> Result<Value, String> {
    let root = peer.next_id();
    let upstream = Arc::new(action.upstream);
    let ended = CancellationToken::new();
    let scope = Scope {
        upstreams: Mutex::new(HashMap::from([(0, upstream.clone())])),
        ended: ended.clone(),
    };
    scopes
        .lock()
        .expect("machine scopes")
        .insert(root, Arc::new(scope));
    let _invocation = Invocation {
        scopes: &scopes,
        root,
        ended,
    };
    let call = peer.call(
        root,
        Request::Invoke {
            plugin: action.plugin,
            entry_hash: action.entry_hash,
            code_hash: action.code_hash,
            name: action.name,
            args: action.args,
        },
    );
    tokio::pin!(call);
    let result = tokio::select! {
        biased;
        result = &mut call => result,
        () = action.retiring.cancelled() => {
            peer.retire(root);
            call.await
        }
    };
    if peer.stop().is_cancelled() {
        return Ok(crate::actions::MachineFailure::MachineLost.value());
    }
    result.map_err(|error| upstream.redact(error))
}

async fn operation(scopes: Scopes, id: u64, request: Request) -> Result<Value, String> {
    let Request::Operation {
        root,
        scope,
        name,
        payload,
    } = request
    else {
        return Err("Machine may only call operations within a server invocation".into());
    };
    let scopes = scopes
        .lock()
        .expect("machine scopes")
        .get(&root)
        .cloned()
        .ok_or("Machine invocation has ended")?;
    let upstream = scopes
        .upstreams
        .lock()
        .expect("machine invocation scopes")
        .get(&scope)
        .cloned()
        .ok_or("Unknown machine invocation scope")?;
    tokio::select! {
        biased;
        () = scopes.ended.cancelled() => Err("Machine invocation has ended".into()),
        result = invoke_operation(&scopes, upstream, id, &name, payload) => result,
    }
}

async fn invoke_operation(
    scopes: &Scope,
    upstream: Arc<RunnerActionUpstream>,
    id: u64,
    name: &str,
    payload: Value,
) -> Result<Value, String> {
    match name {
        "action.env" => Err("Connected Runner actions use their local environment".into()),
        "local.contracts" => upstream.local_contracts(&payload).await,
        "local.contract.route" => {
            let label = payload["label"].as_str().ok_or("Missing contract label")?;
            let route = upstream.local_contract(label, &payload["args"]).await?;
            let mut scopes = scopes.upstreams.lock().expect("machine invocation scopes");
            if scopes.len() >= 128 {
                return Err("Machine contract scope capacity exceeded".into());
            }
            scopes.insert(id, Arc::new(route.upstream));
            Ok(json!({"entryHash":route.entry_hash, "codeHash":route.code_hash}))
        }
        _ => Ok(match upstream.dispatch(name, payload).await {
            Ok(value) => json!({"value":value}),
            Err(error) => {
                json!({"error":error.details.unwrap_or_else(|| json!(upstream.redact(error.message)))})
            }
        }),
    }
}

async fn connection(
    mut socket: WebSocket,
    adapter: Adapter,
    auth: AuthContext,
    revoked: CancellationToken,
) {
    if revoked.is_cancelled() || adapter.stopping.is_cancelled() {
        return;
    }
    let (peer, mut outgoing) = Peer::new();
    let scopes = Scopes::default();
    let dispatch_peer = peer.clone();
    let dispatch_scopes = scopes.clone();
    let Some(registration) = adapter.server.machines().connect(
        &auth,
        Arc::new(move |action| {
            Box::pin(dispatch(
                dispatch_peer.clone(),
                dispatch_scopes.clone(),
                action,
            ))
        }),
    ) else {
        close(
            &mut socket,
            machine_wire::DUPLICATE,
            "Machine already connected",
        )
        .await;
        return;
    };
    adapter
        .identities
        .record_last_seen(&auth, DeviceSocket::MachineOpened);
    let (interval, limit) = machine_wire::heartbeat();
    let mut ticks = tokio::time::interval(interval);
    let mut deadline = tokio::time::Instant::now() + limit;
    let mut incoming = Incoming::default();
    loop {
        let send = tokio::select! {
            biased;
            () = adapter.stopping.cancelled() => break,
            () = revoked.cancelled() => break,
            () = peer.stop().cancelled() => break,
            () = tokio::time::sleep_until(deadline) => break,
            reaped = incoming.reap() => if reaped { continue } else { break },
            message = socket.recv() => match message {
                Some(Ok(Message::Text(text))) => {
                    let Ok(packet) = serde_json::from_str::<Packet>(&text) else { break };
                    let scopes = scopes.clone();
                    incoming.receive(&peer, packet, move |id, request, _| operation(scopes, id, request));
                    continue;
                }
                Some(Ok(Message::Pong(_))) => {
                    deadline = tokio::time::Instant::now() + limit;
                    continue;
                }
                Some(Ok(Message::Ping(_))) => continue,
                _ => break,
            },
            Some(packet) = outgoing.recv() => {
                let Ok(text) = serde_json::to_string(&packet) else { break };
                if text.len() > MESSAGE_BYTES { break; }
                Message::Text(text.into())
            },
            _ = ticks.tick() => Message::Ping(Default::default()),
        };
        if !matches!(
            tokio::time::timeout_at(deadline, socket.send(send)).await,
            Ok(Ok(()))
        ) {
            break;
        }
    }
    peer.stop().cancel();
    adapter
        .identities
        .record_last_seen(&auth, DeviceSocket::MachineClosed);
    drop(registration);
    if revoked.is_cancelled() {
        close(&mut socket, DEVICE_SIGNED_OUT, "Device signed out").await;
    }
    drop(socket);
    incoming.shutdown().await;
}

async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let close = Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }));
    let _ = tokio::time::timeout(Duration::from_millis(250), socket.send(close)).await;
}
