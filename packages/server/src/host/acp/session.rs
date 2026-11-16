use super::{
    limits,
    process::{Actor, Command, Pending, Process},
};
use agent_client_protocol::v1::schema::{
    CancelNotification, LoadSessionRequest, NewSessionRequest, PromptRequest, ResumeSessionRequest,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::mpsc;

pub(super) struct Events {
    sender: mpsc::UnboundedSender<Result<Value, String>>,
    bytes: Arc<AtomicUsize>,
}

pub(super) struct EventReceiver {
    receiver: mpsc::UnboundedReceiver<Result<Value, String>>,
    bytes: Arc<AtomicUsize>,
}

pub(super) fn events() -> (Events, EventReceiver) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let bytes = Arc::new(AtomicUsize::new(0));
    (
        Events {
            sender,
            bytes: bytes.clone(),
        },
        EventReceiver { receiver, bytes },
    )
}

fn event_bytes(event: &Result<Value, String>) -> usize {
    match event {
        Ok(value) => value.to_string().len(),
        Err(_) => 0,
    }
}

impl Events {
    pub fn send(&self, event: Result<Value, String>) -> Result<(), String> {
        let size = event_bytes(&event);
        let previous = self.bytes.fetch_add(size, Ordering::Relaxed);
        if previous + size > limits::TURN_BYTES {
            self.bytes.fetch_sub(size, Ordering::Relaxed);
            let error = "ACP turn event queue exceeds 4 MiB limit".to_owned();
            let _ = self.sender.send(Err(error.clone()));
            return Err(error);
        }
        if self.sender.send(event).is_err() {
            self.bytes.fetch_sub(size, Ordering::Relaxed);
        }
        Ok(())
    }
}

impl EventReceiver {
    pub async fn recv(&mut self) -> Option<Result<Value, String>> {
        let event = self.receiver.recv().await?;
        self.bytes.fetch_sub(event_bytes(&event), Ordering::Relaxed);
        Some(event)
    }
}

pub(super) struct Turn {
    pub owner: String,
    pub events: Events,
    pub permissions: BTreeMap<String, Value>,
    pub cancelled: bool,
}

pub(super) struct Stream {
    pub process: Arc<Process>,
    pub session: String,
    pub events: tokio::sync::Mutex<EventReceiver>,
}

pub(super) struct Lease {
    pub id: String,
    pub streams: Mutex<BTreeMap<String, Arc<Stream>>>,
}

impl Default for Lease {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            streams: Mutex::default(),
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        for stream in self.streams.lock().expect("ACP streams").values() {
            stream.process.cancel(&self.id, &stream.session);
        }
    }
}

pub(super) async fn open(
    process: &Process,
    cwd: &str,
    session: Option<&str>,
) -> Result<Value, String> {
    let capabilities = &process.capabilities;
    if let Some(session) = session {
        let method = if capabilities["sessionCapabilities"]["resume"].is_object() {
            Some("session/resume")
        } else if capabilities["loadSession"] == true {
            Some("session/load")
        } else {
            None
        };
        if let Some(method) = method {
            let params = if method == "session/resume" {
                wire(ResumeSessionRequest::new(session.to_owned(), cwd))?
            } else {
                wire(LoadSessionRequest::new(session.to_owned(), cwd))?
            };
            process.request(method, params).await?;
            return Ok(json!({"sessionId": session, "restored": true}));
        }
    }

    let result = process
        .request("session/new", wire(NewSessionRequest::new(cwd))?)
        .await?;
    let session = result["sessionId"]
        .as_str()
        .ok_or("ACP agent returned no sessionId")?;
    Ok(json!({"sessionId": session, "restored": false}))
}

impl Actor {
    fn busy(&self, session: &str) -> bool {
        self.turns.contains_key(session)
            || self.pending.values().any(
                |pending| matches!(pending, Pending::Restore { session: id, .. } if id == session),
            )
    }

    pub(super) async fn command(&mut self, command: Command) -> Result<(), String> {
        match command {
            Command::Request {
                method,
                params,
                reply,
            } => {
                let pending = if matches!(method.as_str(), "session/load" | "session/resume") {
                    let session = params["sessionId"].as_str().unwrap_or_default();
                    if self.busy(session) {
                        let _ = reply.send(Err("ACP session is busy".into()));
                        return Ok(());
                    }
                    Pending::Restore {
                        session: session.into(),
                        reply,
                    }
                } else {
                    Pending::Request(reply)
                };
                self.request(method, params, pending).await
            }
            Command::Prompt {
                owner,
                session,
                text,
                events,
                reply,
            } => {
                if self.busy(&session) {
                    let _ = reply.send(Err("ACP session already has a running turn".into()));
                    return Ok(());
                }
                self.turns.insert(
                    session.clone(),
                    Turn {
                        owner,
                        events,
                        permissions: BTreeMap::new(),
                        cancelled: false,
                    },
                );
                let request = self
                    .request(
                        "session/prompt".into(),
                        wire(PromptRequest::new(session.clone(), vec![text.into()]))?,
                        Pending::Prompt(session),
                    )
                    .await;
                let _ = reply.send(request.clone().map(|()| Value::Null));
                request
            }
            Command::Respond {
                owner,
                request,
                option,
                reply,
            } => {
                let permission = self
                    .turns
                    .values_mut()
                    .filter(|turn| turn.owner == owner)
                    .find_map(|turn| turn.permissions.remove(&request));
                let result = match permission {
                    Some(permission) => self
                        .permission(permission, option)
                        .await
                        .map(|()| Value::Null),
                    None => Err("Unknown ACP permission request".into()),
                };
                let _ = reply.send(result);
                Ok(())
            }
            Command::Cancel { owner, session } => {
                self.cancel_turn(owner.as_deref(), &session).await
            }
        }
    }

    async fn cancel_turn(&mut self, owner: Option<&str>, session: &str) -> Result<(), String> {
        if !self
            .turns
            .get(session)
            .is_some_and(|turn| owner.is_none_or(|owner| turn.owner == owner))
        {
            return if owner.is_none() {
                self.write(json!({"jsonrpc":"2.0", "method":"session/cancel", "params":wire(CancelNotification::new(session.to_owned()))?})).await
            } else {
                Ok(())
            };
        }
        let turn = self.turns.get_mut(session).expect("checked turn");
        turn.cancelled = true;
        let permissions = std::mem::take(&mut turn.permissions);
        for (_, permission) in permissions {
            self.permission(permission, None).await?;
        }
        // Keep the turn busy until its prompt response acknowledges cancellation.
        self.write(json!({"jsonrpc":"2.0", "method":"session/cancel", "params":wire(CancelNotification::new(session.to_owned()))?})).await
    }

    async fn permission(
        &mut self,
        permission: Value,
        option: Option<String>,
    ) -> Result<(), String> {
        let outcome = option.map_or_else(
            || json!({"outcome":"cancelled"}),
            |id| json!({"outcome":"selected","optionId":id}),
        );
        self.write(json!({"jsonrpc":"2.0","id":permission["id"],"result":{"outcome":outcome}}))
            .await
    }

    async fn finish_turn(&mut self, session: &str, message: &Value) -> Result<(), String> {
        let Some(turn) = self.turns.remove(session) else {
            return Ok(());
        };
        for (_, permission) in turn.permissions {
            self.permission(permission, None).await?;
        }
        let event = if let Some(error) = message.get("error") {
            Err(format!("ACP error: {error}"))
        } else {
            Ok(json!({"type":"done", "stopReason":message["result"]["stopReason"]}))
        };
        turn.events.send(event)?;
        Ok(())
    }

    pub(super) async fn message(&mut self, message: Value) -> Result<(), String> {
        if let Some(method) = message["method"].as_str() {
            let params = &message["params"];
            let session = params["sessionId"].as_str().unwrap_or_default();
            match method {
                "session/update" => {
                    // No turn exists during session/load: replay is discarded.
                    if let Some(turn) = self.turns.get(session) {
                        turn.events.send(Ok(json!({"type":"update", "update":params["update"]})))?;
                    }
                }
                "session/request_permission" => {
                    if let Some(turn) = self.turns.get_mut(session).filter(|turn| !turn.cancelled) {
                        let id = uuid::Uuid::new_v4().to_string();
                        turn.permissions.insert(id.clone(), message.clone());
                        turn.events.send(Ok(json!({"type":"permission","requestId":id,"toolCall":params["toolCall"],"options":params["options"]})))?;
                    } else { self.permission(message, None).await?; }
                }
                _ if message.get("id").is_some() => self.write(json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":"Method not found"}})).await?,
                _ => {}
            }
        } else if let Some(id) = message["id"].as_u64() {
            match self.pending.remove(&id) {
                Some(Pending::Prompt(session)) => {
                    self.finish_turn(&session, &message).await?;
                }
                Some(Pending::Request(reply) | Pending::Restore { reply, .. }) => {
                    let result = if let Some(error) = message.get("error") {
                        Err(format!("ACP error: {error}"))
                    } else {
                        Ok(message["result"].clone())
                    };
                    let _ = reply.send(result);
                }
                None => {}
            }
        }
        Ok(())
    }
}

fn wire(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}
