use super::*;
use crate::{
    RunnerAction, RunnerActionUpstream,
    machine_wire::{self, Incoming, Packet, Peer, Request},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, hash_map::Entry},
    sync::Mutex,
};

pub(super) async fn upgrade(
    State(adapter): State<Adapter>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(key) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let (identity, revoked) =
        if let Some((id, plugin, revoked)) = adapter.identities.authenticate_plugin_machine(key) {
            (Identity::Plugin { id, plugin }, revoked)
        } else if let Some(auth) = adapter.identities.authenticate(key)
            && let Some(revoked) = adapter.identities.issued_device(&auth)
        {
            (Identity::Person(auth), revoked)
        } else {
            return StatusCode::UNAUTHORIZED.into_response();
        };
    let stage_plans = headers
        .get(machine_wire::STAGE_PLANS_HEADER)
        .is_some_and(|value| value == machine_wire::STAGE_PLANS);
    let Ok(permit) = adapter.connections.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    ws.protocols([WS_PROTOCOL])
        .max_frame_size(MESSAGE_BYTES)
        .max_message_size(MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            connection(socket, adapter, identity, revoked, stage_plans).await;
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

async fn dispatch(
    peer: Peer,
    scopes: Scopes,
    action: RunnerAction,
) -> Result<Value, engine::CallError> {
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
    result.map_err(|error| upstream.redact_call_error(error.into()))
}

async fn operation(
    scopes: Scopes,
    peer: Peer,
    plugin: Option<Arc<str>>,
    request: Request,
) -> Result<Value, String> {
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
        result = invoke_operation(&scopes, upstream, &peer, plugin.as_deref(), &name, payload) => result,
    }
}

async fn invoke_operation(
    scopes: &Scope,
    upstream: Arc<RunnerActionUpstream>,
    peer: &Peer,
    plugin: Option<&str>,
    name: &str,
    payload: Value,
) -> Result<Value, String> {
    match name {
        "action.env" => Err("Connected Runner actions use their local environment".into()),
        "local.contracts" => {
            let mut providers = upstream.local_contracts(&payload).await?;
            if let (Some(owner), Some(routes)) = (plugin, providers.as_array_mut()) {
                routes.retain(|route| owns_contract(Some(owner), route));
            }
            Ok(providers)
        }
        "local.contract.route" => {
            let label = payload["label"].as_str().ok_or("Missing contract label")?;
            let args = &payload["args"];
            if !owns_contract(plugin, args) {
                return Err("Contract provider does not own this machine".into());
            }
            let route = upstream.local_contract(label, args).await?;
            let mut scopes = scopes.upstreams.lock().expect("machine invocation scopes");
            if scopes.len() >= machine_wire::CAPACITY {
                return Err("Machine contract scope capacity exceeded".into());
            }
            let id = peer.next_id();
            let Entry::Vacant(slot) = scopes.entry(id) else {
                return Err("Duplicate machine contract scope".into());
            };
            slot.insert(Arc::new(route.upstream));
            Ok(json!({"scope":id, "entryHash":route.entry_hash, "codeHash":route.code_hash}))
        }
        _ => Ok(match upstream.dispatch(name, payload).await {
            Ok(value) => json!({"value":value}),
            Err(error) => {
                json!({"error":error.details.unwrap_or_else(|| json!(upstream.redact(error.message)))})
            }
        }),
    }
}

fn owns_contract(owner: Option<&str>, route: &Value) -> bool {
    owner.is_none_or(|owner| route["plugin"].as_str() == Some(owner))
}

fn dispatch_to(
    peer: Peer,
    scopes: Scopes,
    owner: Option<Arc<str>>,
) -> crate::actions::RunnerDispatch {
    Arc::new(move |action| {
        if owner.as_deref().is_some_and(|owner| owner != action.plugin) {
            return Box::pin(async { Ok(crate::actions::MachineFailure::Forbidden.value()) });
        }
        Box::pin(dispatch(peer.clone(), scopes.clone(), action))
    })
}

enum Identity {
    Person(AuthContext),
    Plugin { id: String, plugin: String },
}

impl Identity {
    fn machine(&self) -> (&str, crate::actions::MachineOwner, Option<Arc<str>>) {
        use crate::actions::MachineOwner;
        match self {
            Self::Person(auth) => (
                &auth.device.id,
                MachineOwner::Person(auth.user.id.clone()),
                None,
            ),
            Self::Plugin { id, plugin } => (
                id,
                MachineOwner::Plugin(plugin.clone()),
                Some(Arc::from(plugin.as_str())),
            ),
        }
    }

    fn seen(&self, identities: &Identities, event: DeviceSocket) {
        match self {
            Self::Person(auth) => identities.record_last_seen(auth, event),
            Self::Plugin { id, .. } => identities.plugin_machine_seen(id, event),
        }
    }
}

async fn connection(
    mut socket: WebSocket,
    adapter: Adapter,
    identity: Identity,
    revoked: CancellationToken,
    stage_plans: bool,
) {
    if revoked.is_cancelled() || adapter.stopping.is_cancelled() {
        return;
    }
    let (peer, mut outgoing) = Peer::new();
    let scopes = Scopes::default();
    let replaced = CancellationToken::new();
    identity.seen(&adapter.identities, DeviceSocket::MachineOpened);
    let (id, owner, plugin) = identity.machine();
    let Some(registration) = adapter.server.machines().connect(
        id,
        owner,
        crate::actions::RunnerConnection {
            dispatch: dispatch_to(peer.clone(), scopes.clone(), plugin.clone()),
            stage_plans,
        },
        replaced.clone(),
        revoked.clone(),
    ) else {
        identity.seen(&adapter.identities, DeviceSocket::MachineClosed);
        return;
    };
    let (interval, limit) = machine_wire::heartbeat();
    let mut ticks = tokio::time::interval(interval);
    let mut deadline = tokio::time::Instant::now() + limit;
    let mut incoming = Incoming::default();
    loop {
        let send = tokio::select! {
            biased;
            () = adapter.stopping.cancelled() => break,
            () = revoked.cancelled() => break,
            () = replaced.cancelled() => break,
            () = peer.stop().cancelled() => break,
            () = tokio::time::sleep_until(deadline) => break,
            reaped = incoming.reap() => if reaped { continue } else { break },
            message = socket.recv() => match message {
                Some(Ok(Message::Text(text))) => {
                    let Ok(packet) = serde_json::from_str::<Packet>(&text) else { break };
                    let scopes = scopes.clone();
                    let (operation_peer, plugin) = (peer.clone(), plugin.clone());
                    incoming.receive(&peer, packet, move |_, request, _| async move { operation(scopes, operation_peer, plugin, request).await.map_err(Into::into) });
                    continue;
                }
                Some(Ok(Message::Pong(_))) => {
                    deadline = tokio::time::Instant::now() + limit;
                    identity.seen(&adapter.identities, DeviceSocket::MachineHeartbeat);
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
        if !tokio::select! {
            biased;
            () = replaced.cancelled() => false,
            () = revoked.cancelled() => false,
            result = tokio::time::timeout_at(deadline, socket.send(send)) => matches!(result, Ok(Ok(()))),
        } {
            break;
        }
    }
    peer.stop().cancel();
    drop(registration);
    identity.seen(&adapter.identities, DeviceSocket::MachineClosed);
    if revoked.is_cancelled() {
        close(&mut socket, DEVICE_SIGNED_OUT, "Device signed out").await;
    } else if replaced.is_cancelled() {
        close(
            &mut socket,
            machine_wire::DUPLICATE,
            "Machine already connected",
        )
        .await;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_machine_contracts_stay_with_the_owner() {
        let other = json!({"plugin": "other"});
        assert!(owns_contract(None, &other));
        assert!(!owns_contract(Some("owner"), &other));
        assert!(!owns_contract(Some("owner"), &json!({})));
        assert!(owns_contract(Some("owner"), &json!({"plugin": "owner"})));
    }
}
