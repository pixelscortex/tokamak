//! The window answers host operations using its own workspace connection.

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod quickjs;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::artifact::client_env;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::artifact::quickjs_bundle;
use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{MethodRouter, get},
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokamak_worker::{WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::sync::Semaphore;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(super) struct Local {
    stopping: CancellationToken,
    slots: Arc<Semaphore>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pool: quickjs::Pool,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(super) struct Artifact {
    pub(super) id: String,
    pub(super) entry_hash: String,
    pub(super) code_hash: String,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Start {
        artifact: Artifact,
        #[serde(default)]
        workspace: String,
    },
    Write {
        message: Value,
    },
    // Recognize the old frame so the connection can reject it explicitly.
    Load {},
    Route {
        #[serde(default)]
        id: Value,
        #[serde(default)]
        artifact: Value,
    },
    Retire {
        #[serde(default)]
        artifact: Value,
    },
    Close,
}

impl Local {
    pub(super) fn new(plugins: PathBuf, app_data: PathBuf) -> Self {
        let stopping = CancellationToken::new();
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let _ = (plugins, app_data);
        Self {
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            pool: quickjs::Pool::new(Arc::new(plugins), Arc::new(app_data), stopping.clone()),
            stopping,
            slots: Arc::new(Semaphore::new(WORKER_CAPACITY)),
        }
    }

    pub(super) fn route(&self) -> MethodRouter {
        get(upgrade).with_state(self.clone())
    }

    pub(super) async fn shutdown(&self) {
        self.stopping.cancel();
        // Includes sockets upgraded but not yet running a worker.
        let _ = self.slots.acquire_many(WORKER_CAPACITY as u32).await;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        self.pool.wait().await;
    }

    pub(super) async fn observe(
        &self,
        server: &Arc<server::Server>,
        workspace: &str,
    ) -> Result<(), server::Error> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let pool = self.pool.clone();
            let leases = Arc::new(quickjs::Leases::new(&pool, workspace.into()));
            self.pool
                .observe(server, server.connect().await?, leases.clone());
            server.attach_runner(move |action| {
                Box::pin(quickjs::action(pool.clone(), leases.clone(), action))
            })?;
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let _ = (server, workspace);
        Ok(())
    }
}

async fn upgrade(State(local): State<Local>, ws: WebSocketUpgrade) -> Response {
    let Ok(slot) = local.slots.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if local.stopping.is_cancelled() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    ws.protocols([server::websocket::WS_PROTOCOL])
        .max_message_size(WORKER_FRAME_BYTES + 1024)
        .max_frame_size(WORKER_FRAME_BYTES + 1024)
        .on_upgrade(move |mut socket| async move {
            let _slot = slot;
            let result = connection(&mut socket, &local).await;
            // A clean close is acknowledged after reaping the plugin process.
            let _ = send(
                &mut socket,
                json!({
                    "type": "closed",
                    "reason": result.err().unwrap_or_else(|| "Plugin process stopped".into()),
                }),
            )
            .await;
        })
        .into_response()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn connection(socket: &mut WebSocket, local: &Local) -> Result<(), String> {
    let started = async {
        let Some(Request::Start {
            artifact,
            workspace,
        }) = receive(socket).await?
        else {
            return Err("Expected a plugin process artifact".into());
        };
        Ok::<_, String>((artifact, workspace))
    };
    let (requested, workspace) = tokio::select! {
        _ = local.stopping.cancelled() => return Ok(()),
        result = tokio::time::timeout(TIMEOUT, started) => result.map_err(|_| "Plugin process did not start in time")??,
    };
    quickjs::connection(socket, &local.pool, requested, workspace).await
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
async fn connection(_: &mut WebSocket, _: &Local) -> Result<(), String> {
    tokamak_worker::require_plugin_platform(std::env::consts::OS).map_err(str::to_owned)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn stderr_tail(mut input: impl AsyncRead + Unpin) -> String {
    use std::collections::VecDeque;
    use tokio::io::AsyncReadExt;

    const STDERR_BYTES: usize = 4096;
    const STDERR_LINES: usize = 8;
    let mut tail = VecDeque::with_capacity(STDERR_BYTES);
    let mut chunk = [0; STDERR_BYTES];
    while let Ok(count) = input.read(&mut chunk).await {
        if count == 0 {
            break;
        }
        let discard = (tail.len() + count).saturating_sub(STDERR_BYTES);
        tail.drain(..discard);
        tail.extend(&chunk[..count]);
    }
    let text = String::from_utf8_lossy(tail.make_contiguous());
    let text = text.trim_end();
    let start = text.match_indices('\n').rev().nth(STDERR_LINES - 1);
    let text = start.map_or(text, |(index, _)| &text[index + 1..]);
    text[text.ceil_char_boundary(text.len().saturating_sub(STDERR_BYTES))..].to_owned()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn receive(socket: &mut WebSocket) -> Result<Option<Request>, String> {
    loop {
        match socket.recv().await {
            Some(Ok(Message::Text(text))) => {
                return serde_json::from_str::<Request>(&text)
                    .map(Some)
                    .map_err(|e| e.to_string());
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            Some(Ok(Message::Close(_))) | None => return Ok(None),
            Some(Ok(_)) => return Err("Expected a JSON plugin process frame".into()),
            Some(Err(error)) => return Err(error.to_string()),
        }
    }
}

async fn send(socket: &mut WebSocket, message: Value) -> Result<(), String> {
    tokio::time::timeout(
        TIMEOUT,
        socket.send(Message::Text(message.to_string().into())),
    )
    .await
    .map_err(|_| "Plugin process socket write stalled")?
    .map_err(|error| error.to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn write(
    mut input: impl AsyncWrite + Unpin,
    mut outgoing: mpsc::Receiver<Vec<u8>>,
) -> String {
    while let Some(line) = outgoing.recv().await {
        match tokio::time::timeout(TIMEOUT, input.write_all(&line)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return error.to_string(),
            Err(_) => return "Plugin process input stalled".into(),
        }
    }
    "Plugin process input closed".into()
}
