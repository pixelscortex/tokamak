//! The window answers host operations using its own workspace connection.
//! Bun keeps the original socket-owned worker; QuickJS hosts belong to the Runner.

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod quickjs;

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
#[cfg(any(target_os = "macos", target_os = "linux"))]
use tokamak_worker::LocalRuntime;
use tokamak_worker::{Process, WORKER_CAPACITY, WORKER_FRAME_BYTES};
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pool: quickjs::Pool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    id: String,
    entry_hash: String,
    code_hash: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Start {
        artifact: Artifact,
        #[serde(default)]
        live: Vec<Artifact>,
        #[serde(default)]
        workspace: String,
    },
    Write {
        message: Value,
    },
    Load {
        id: u32,
        artifact: Artifact,
    },
    Route {
        id: u64,
        artifact: Artifact,
        #[serde(default)]
        live: Vec<Artifact>,
    },
    Retire {
        artifact: Artifact,
        live: Vec<Artifact>,
        changed: String,
    },
    Close,
}

impl Local {
    pub(super) fn new(plugins: PathBuf, app_data: PathBuf) -> Self {
        let stopping = CancellationToken::new();
        let plugins = Arc::new(plugins);
        let app_data = Arc::new(app_data);
        Self {
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            pool: quickjs::Pool::new(plugins.clone(), app_data.clone(), stopping.clone()),
            plugins,
            app_data,
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
        if LocalRuntime::selected() == Ok(LocalRuntime::QuickJs) {
            self.pool
                .observe(server, server.connect().await?, workspace.into());
        }
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
            artifact,
            live,
            workspace,
        }) = receive(socket).await?
        else {
            return Err("Expected a local worker artifact".into());
        };
        Ok::<_, String>((artifact, live, workspace))
    };
    let (requested, live, workspace) = tokio::select! {
        _ = local.stopping.cancelled() => return Ok(()),
        result = tokio::time::timeout(TIMEOUT, started) => result.map_err(|_| "Local worker startup stalled")??,
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if LocalRuntime::selected()? == LocalRuntime::QuickJs {
        return quickjs::connection(
            socket,
            &local.pool,
            quickjs::Build::new(requested, live)?,
            workspace,
        )
        .await;
    }
    drop((live, workspace));
    let Artifact {
        id: plugin,
        entry_hash,
        code_hash,
    } = requested;
    let plugins = local.plugins.clone();
    let verified = tokio::task::spawn_blocking(move || {
        let files = artifact(&plugins, &plugin, &entry_hash, &code_hash)?;
        Ok::<_, String>((plugin, files))
    });
    let (plugin, (entry, code)) = tokio::select! {
        _ = local.stopping.cancelled() => return Ok(()),
        result = tokio::time::timeout(TIMEOUT, verified) => {
            result.map_err(|_| "Local worker startup stalled")?.map_err(|e| e.to_string())??
        }
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
    let (mut process, _) = Process::launch_local(&entry, &code, cwd, &env, &paths)?;
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
    result
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
                Some(Request::Route { id, artifact, live }) => {
                    drop((id, artifact, live));
                    return Err("Bun does not route local contract calls".into());
                }
                Some(Request::Retire { artifact, live, changed }) => {
                    drop((artifact, live, changed));
                    return Err("Bun local workers belong to their socket".into());
                }
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
