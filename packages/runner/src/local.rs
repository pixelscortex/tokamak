//! One authenticated socket owns one plugin process. The window answers its
//! host operations using the workspace connection it already has.

use crate::artifact::{artifact, artifact_folder, client_env, snapshot};
use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{MethodRouter, get},
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tempfile::TempPath;
use tokamak_worker::{LocalRuntime, Process, WORKER_CAPACITY, WORKER_FRAME_BYTES};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{Semaphore, mpsc},
};
use tokio_util::{
    codec::{FramedRead, LinesCodec},
    sync::CancellationToken,
    task::AbortOnDropHandle,
};

const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(super) struct Local {
    plugins: Arc<PathBuf>,
    app_data: Arc<PathBuf>,
    stopping: CancellationToken,
    slots: Arc<Semaphore>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    id: String,
    entry_hash: String,
    code_hash: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Start { artifact: Artifact },
    Write { message: Value },
    Load { id: u32, artifact: Artifact },
    Close,
}

impl Local {
    pub(super) fn new(plugins: PathBuf, app_data: PathBuf) -> Self {
        Self {
            plugins: Arc::new(plugins),
            app_data: Arc::new(app_data),
            stopping: CancellationToken::new(),
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
                    "reason": result.err().unwrap_or_else(|| "Local worker stopped".into()),
                }),
            )
            .await;
        })
        .into_response()
}

async fn connection(socket: &mut WebSocket, local: &Local) -> Result<(), String> {
    let started = async {
        let Some(Request::Start {
            artifact: requested,
        }) = receive(socket).await?
        else {
            return Err("Expected a local worker artifact".into());
        };
        let Artifact {
            id,
            entry_hash,
            code_hash,
        } = requested;
        let plugins = local.plugins.clone();
        let verified = tokio::task::spawn_blocking(move || {
            let files = artifact(&plugins, &id, &entry_hash, &code_hash)?;
            Ok::<_, String>((id, files))
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok::<_, String>(verified)
    };
    let (plugin, (entry, code)) = tokio::select! {
        _ = local.stopping.cancelled() => return Ok(()),
        result = tokio::time::timeout(TIMEOUT, started) => result.map_err(|_| "Local worker startup stalled")??,
    };
    let paths = tokamak_worker::search_paths();
    let mut env = client_env(|name| std::env::var(name).ok());
    env.insert(
        "TOKAMAK_APP_DATA_DIR".into(),
        local.app_data.to_string_lossy().into_owned(),
    );
    if let Ok(path) = std::env::join_paths(&paths) {
        env.insert("PATH".into(), path.to_string_lossy().into_owned());
    }
    let cwd = local.plugins.parent().unwrap_or(&local.plugins);
    let (mut process, runtime) = Process::launch_local(&entry, &code, cwd, &env, &paths)?;
    let (input, output, mut stderr) = process.pipes()?;
    let _drain = AbortOnDropHandle::new(tokio::spawn(async move {
        let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
    }));
    let (writes, outgoing) = mpsc::channel(WORKER_CAPACITY);
    let relay = async {
        send(socket, json!({ "type": "started" })).await?;
        relay(socket, output, writes, &local.plugins, &plugin).await
    };
    let result = tokio::select! {
        _ = local.stopping.cancelled() => Ok(()),
        reason = process.exited() => Err(reason),
        error = write(input, outgoing) => Err(error),
        result = relay => result,
    };
    process.stop().await;
    result.map_err(|reason| match runtime {
        LocalRuntime::QuickJs => format!("Plugin host closed: {reason}"),
        LocalRuntime::Bun => reason,
    })
}

async fn relay(
    socket: &mut WebSocket,
    output: impl AsyncRead + Unpin,
    writes: mpsc::Sender<Vec<u8>>,
    plugins: &Path,
    plugin: &str,
) -> Result<(), String> {
    let mut output = FramedRead::new(
        BufReader::new(output),
        LinesCodec::new_with_max_length(WORKER_FRAME_BYTES - 1),
    );
    let mut providers = Vec::new();
    loop {
        tokio::select! {
            request = receive(socket) => match request? {
                Some(Request::Write { message }) => {
                    let mut line = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
                    if line.len() >= WORKER_FRAME_BYTES {
                        return Err("Local worker message exceeds 1 MiB".into());
                    }
                    line.push(b'\n');
                    writes.try_send(line).map_err(|_| "Local worker input queue full or closed")?;
                }
                Some(Request::Load { id, artifact }) => {
                    let result = provider(plugins.to_owned(), artifact).await.and_then(|code| {
                        let path = code.to_str().ok_or("Local provider path is not UTF-8")?.to_owned();
                        providers.push(code);
                        Ok(path)
                    });
                    let response = match result {
                        Ok(path) => json!({ "type": "loaded", "id": id, "path": path }),
                        Err(error) => json!({ "type": "loaded", "id": id, "error": error }),
                    };
                    send(socket, response).await?;
                }
                Some(Request::Close) | None => return Ok(()),
                Some(Request::Start { .. }) => return Err("Local worker already started".into()),
            },
            line = output.next() => {
                let line = line.ok_or("Local worker output closed")?.map_err(|e| e.to_string())?;
                let message: Value = serde_json::from_str(&line).map_err(|_| "Invalid local worker JSON")?;
                if message["type"] == "log" {
                    let level = message["level"].as_str().unwrap_or("info");
                    let text = message["text"].as_str().unwrap_or("");
                    tokamak_worker::log(format!("Plugin {plugin} [{level}]: {text}"));
                } else {
                    send(socket, json!({ "type": "message", "message": message })).await?;
                }
            },
        }
    }
}

async fn provider(plugins: PathBuf, artifact: Artifact) -> Result<TempPath, String> {
    tokio::task::spawn_blocking(move || {
        let folder = artifact_folder(
            &plugins,
            &artifact.id,
            &artifact.entry_hash,
            &artifact.code_hash,
        )?;
        snapshot(&folder, "local.js", &artifact.code_hash)
    })
    .await
    .map_err(|e| e.to_string())?
}

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
            Some(Ok(_)) => return Err("Expected a JSON local worker frame".into()),
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
    .map_err(|_| "Local worker socket write stalled")?
    .map_err(|error| error.to_string())
}

async fn write(
    mut input: impl AsyncWrite + Unpin,
    mut outgoing: mpsc::Receiver<Vec<u8>>,
) -> String {
    while let Some(line) = outgoing.recv().await {
        match tokio::time::timeout(TIMEOUT, input.write_all(&line)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return error.to_string(),
            Err(_) => return "Local worker input stalled".into(),
        }
    }
    "Local worker input closed".into()
}
