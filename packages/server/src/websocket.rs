//! Thin loopback WebSocket adapter. All execution and outbound ordering remain
//! in the same Tower session used by desktop; network failures drop that owner.

use crate::{Server, protocol::Request};
use axum::{
    Router,
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use std::{
    future::Future,
    io,
    net::SocketAddr,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
};

use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

const CONNECTIONS: u32 = 64;
const MESSAGE_BYTES: usize = engine::MAX_WIRE_MESSAGE_BYTES;

#[derive(Clone)]
struct Adapter {
    server: Arc<Server>,
    stopping: CancellationToken,
    connections: Arc<Semaphore>,
    access: Option<LocalAccess>,
}

/// Local desktop capability. Never place the token in discovery, URLs or logs.
#[derive(Clone)]
pub struct LocalAccess {
    pub token: String,
    pub identity: serde_json::Value,
}

/// Own and await this future until completion, then close the backend. Shutdown
/// closes idle upgraded sockets too, and waits for their session owners to drop.
/// No authentication/TLS: non-loopback listeners are deliberately refused.
pub async fn serve(
    listener: TcpListener,
    server: Arc<Server>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    serve_with_access(listener, server, shutdown, None).await
}

pub async fn serve_with_access(
    listener: TcpListener,
    server: Arc<Server>,
    shutdown: impl Future<Output = ()> + Send + 'static,
    access: Option<LocalAccess>,
) -> std::io::Result<()> {
    if !listener.local_addr()?.ip().is_loopback() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "unauthenticated POC must bind loopback",
        ));
    }
    let stopping = CancellationToken::new();
    let connections = Arc::new(Semaphore::new(CONNECTIONS as usize));
    let adapter = Adapter {
        server,
        stopping: stopping.clone(),
        connections: connections.clone(),
        access: access.clone(),
    };
    let mut app = Router::new().route("/ws", get(upgrade));
    if let Some(access) = access {
        app = app
            .route("/health", get(health))
            .route("/shutdown", post(stop))
            .route("/plugins", get(plugins))
            .route("/plugins/{id}/reload", post(reload_plugin))
            .route("/plugins/{id}/assets/{*name}", get(plugin_asset))
            .layer(middleware::from_fn_with_state(access, authorize));
    }
    let app = app.with_state(adapter);
    // Axum owns and awaits HTTP connection tasks, but graceful HTTP shutdown
    // alone can wait forever on an incomplete upgrade header. Give EVERY
    // accepted socket cancellable I/O before handing it to Hyper, not just the
    // connections that eventually reach our WebSocket handler.
    let listener = ShutdownListener {
        listener,
        stopping: stopping.clone(),
    };
    let trigger = stopping.clone();
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = shutdown => {},
                _ = trigger.cancelled() => {},
            }
            trigger.cancel();
        })
        .await;
    stopping.cancel();
    // Axum does not wait for upgraded connections. Permits include the upgrade
    // handshake, so none can escape this barrier and outlive storage shutdown.
    let _all = connections.acquire_many(CONNECTIONS).await;
    result
}

async fn authorize(
    State(access): State<LocalAccess>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    // Native clients send the capability explicitly; browser contexts are not
    // allowed even if a user accidentally gives a site the local token.
    if headers.contains_key("origin") {
        return StatusCode::FORBIDDEN.into_response();
    }
    let expected = format!("Bearer {}", access.token);
    let actual = headers
        .get("authorization")
        .map(|v| v.as_bytes())
        .unwrap_or_default();
    let mismatch = actual.len() != expected.len()
        || actual
            .iter()
            .zip(expected.as_bytes())
            .fold(0u8, |a, (x, y)| a | (x ^ y))
            != 0;
    if mismatch {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(request).await
}

async fn health(State(adapter): State<Adapter>) -> Response {
    (
        [("content-type", "application/json")],
        adapter.access.expect("local route").identity.to_string(),
    )
        .into_response()
}

async fn stop(State(adapter): State<Adapter>) -> StatusCode {
    adapter.stopping.cancel();
    StatusCode::ACCEPTED
}

fn plugin_result(result: Result<serde_json::Value, crate::Error>) -> Response {
    match result {
        Ok(value) => ([("content-type", "application/json")], value.to_string()).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            [("content-type", "application/json")],
            serde_json::json!({"error":error.to_string()}).to_string(),
        )
            .into_response(),
    }
}
async fn plugins(State(adapter): State<Adapter>) -> Response {
    plugin_result(adapter.server.plugins().await)
}
async fn reload_plugin(State(adapter): State<Adapter>, Path(id): Path<String>) -> Response {
    plugin_result(adapter.server.reload_plugin(id).await)
}
async fn plugin_asset(
    State(adapter): State<Adapter>,
    Path((id, name)): Path<(String, String)>,
) -> Response {
    match adapter.server.plugin_asset(id, name.clone()).await {
        Ok(Some(bytes)) => {
            let content_type = if name.ends_with(".js") {
                "text/javascript"
            } else if name.ends_with(".css") {
                "text/css"
            } else if name.ends_with(".html") {
                "text/html"
            } else {
                "application/json"
            };
            let stream =
                futures_util::stream::try_unfold((bytes, 0u64), |(asset, offset)| async move {
                    if offset == asset.len {
                        return Ok::<_, std::io::Error>(None);
                    }
                    let chunk = asset
                        .read(offset, 64 * 1024)
                        .map_err(std::io::Error::other)?;
                    let next = offset + chunk.len() as u64;
                    Ok(Some((chunk, (asset, next))))
                });
            (
                [
                    ("content-type", content_type),
                    ("cache-control", "no-store"),
                ],
                axum::body::Body::from_stream(stream),
            )
                .into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => plugin_result(Err(error)),
    }
}

async fn upgrade(State(adapter): State<Adapter>, ws: WebSocketUpgrade) -> Response {
    let Ok(permit) = adapter.connections.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if adapter.stopping.is_cancelled() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    ws.max_message_size(MESSAGE_BYTES)
        .max_frame_size(MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            connection(socket, adapter).await;
        })
        .into_response()
}

async fn connection(mut socket: WebSocket, adapter: Adapter) {
    let mut session = tokio::select! {
        _ = adapter.stopping.cancelled() => return,
        session = adapter.server.connect() => match session { Ok(session) => session, Err(_) => return },
    };
    let mut service = session.sender();
    loop {
        tokio::select! {
            _ = adapter.stopping.cancelled() => break,
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(request) = serde_json::from_str::<Request>(&text) else { break };
                        // Admission failures terminate the stream rather than
                        // race a transport-generated error ahead of prior updates.
                        if tower::Service::call(&mut service, request).await.is_err() { break; }
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                    _ => break,
                }
            }
            event = session.recv() => {
                let Ok(Some(event)) = event else { break };
                let Ok(text) = serde_json::to_string(&event) else { break };
                // A peer that stops reading must not keep its subscription alive
                // forever after the bounded coordinator queue has disconnected it.
                let sent = tokio::time::timeout(Duration::from_secs(5), socket.send(Message::Text(text.into()))).await;
                if !matches!(sent, Ok(Ok(()))) { break; }
            }
        }
    }
    // Dropping session immediately retires subscriptions, even if its command
    // queue is full. Do not await a peer close handshake before doing so.
    drop(session);
}

/// Socket cancellation is deliberately below HTTP parsing. Returning EOF/error
/// wakes Hyper's owned tasks so Axum can join them; we never detach a partial
/// request by dropping the outer serve future or racing a handler timeout.
struct ShutdownListener {
    listener: TcpListener,
    stopping: CancellationToken,
}

impl axum::serve::Listener for ShutdownListener {
    type Io = ShutdownIo;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        // Reuse Axum's maintained accept-error retry/backoff policy.
        let (stream, address) = axum::serve::Listener::accept(&mut self.listener).await;
        let stopping = Box::pin(self.stopping.clone().cancelled_owned());
        (ShutdownIo { stream, stopping }, address)
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}

struct ShutdownIo {
    stream: TcpStream,
    stopping: Pin<Box<WaitForCancellationFutureOwned>>,
}

impl AsyncRead for ShutdownIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.stopping.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Ok(())); // EOF, including a peer stuck mid-header.
        }
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}

impl AsyncWrite for ShutdownIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.stopping.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::ErrorKind::ConnectionAborted.into()));
        }
        Pin::new(&mut self.stream).poll_write(cx, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.stopping.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::ErrorKind::ConnectionAborted.into()));
        }
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
