//! Thin WebSocket adapter. All execution and outbound ordering remain
//! in the same Tower session used by desktop; network failures drop that owner.

use crate::{
    Server,
    identity::{AuthContext, DeviceSocket, Identities, RevokeError, Role, User},
    protocol::Request,
};
use axum::{
    Extension, Router,
    extract::{
        MatchedPath, Path, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, Method, StatusCode},
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

pub use crate::web::HostedWeb;

mod members;
mod response;
mod sign_in;
mod sign_in_limit;

use response::{account_result, snapshots};

const CONNECTIONS: u32 = 64;
const MESSAGE_BYTES: usize = engine::MAX_WIRE_MESSAGE_BYTES;
const DEVICE_SIGNED_OUT: u16 = 4001;
const DEVICE_STREAM_PATH: &str = "/devices/live";
const WS_PROTOCOL: &str = "tokamak";
const WS_BEARER_PREFIX: &str = "tokamak.bearer.";
const DEVICE_REVOKE_PATH: &str = "/devices/{id}/revoke";
const LAST_SEEN_FLUSH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone)]
struct Adapter {
    server: Arc<Server>,
    stopping: CancellationToken,
    connections: Arc<Semaphore>,
    snapshot_streams: Arc<Semaphore>,
    access: Option<LocalAccess>,
    origins: Arc<Vec<String>>,
    hosted: bool,
    identities: Arc<Identities>,
    profile_updates: Arc<tokio::sync::Mutex<()>>,
    // Keep management permission checks and writes ordered while a provider runs.
    member_edits: Arc<tokio::sync::Mutex<()>>,
    // A reset must not finish between verifying an old password and issuing a device key.
    credentials: Arc<tokio::sync::RwLock<()>>,
    owner_setup: Arc<tokio::sync::Mutex<Option<sign_in::SetupLease>>>,
    sign_in_limit: Arc<std::sync::Mutex<sign_in_limit::SignInLimit>>,
    trusted_sign_in_proxies: Vec<std::net::IpAddr>,
}

impl Adapter {
    async fn update_user(
        &self,
        save: impl FnOnce() -> Result<User, String>,
    ) -> Result<User, String> {
        let _update = self.profile_updates.lock().await;
        self.server.update_user(save).await
    }
}

fn allowed_origins(web: Option<&HostedWeb>) -> Arc<Vec<String>> {
    Arc::new({
        let mut origins: Vec<String> = std::env::var("TOKAMAK_ALLOWED_ORIGINS")
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_else(|_| {
                vec![
                    "tauri://localhost".into(),
                    "http://tauri.localhost".into(),
                    "http://127.0.0.1:1420".into(),
                ]
            });
        if let Some(web) = web {
            origins.push(web.origin.clone());
        }
        origins
    })
}

/// Bootstrap capability and local discovery metadata. Never log the token.
#[derive(Clone)]
pub struct LocalAccess {
    pub token: String,
    pub identity: serde_json::Value,
}

/// Own and await this future until completion, then close the backend. Shutdown
/// closes idle upgraded sockets too, and waits for their session owners to drop.
/// Without hosted configuration, non-loopback listeners are refused.
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
    serve_with_web(listener, server, shutdown, access, None).await
}

pub async fn serve_with_web(
    listener: TcpListener,
    server: Arc<Server>,
    shutdown: impl Future<Output = ()> + Send + 'static,
    access: Option<LocalAccess>,
    web: Option<HostedWeb>,
) -> std::io::Result<()> {
    let identities = if web.is_some() {
        Identities::bootstrap(
            access
                .as_ref()
                .map(|a| a.token.as_str())
                .unwrap_or_default(),
        )
    } else {
        Identities::local(access.as_ref().map(|a| a.token.as_str()))
    };
    serve_with_identities(
        listener,
        server,
        shutdown,
        access,
        web,
        Arc::new(identities),
    )
    .await
}

pub async fn serve_with_identities(
    listener: TcpListener,
    server: Arc<Server>,
    shutdown: impl Future<Output = ()> + Send + 'static,
    access: Option<LocalAccess>,
    web: Option<HostedWeb>,
    identities: Arc<Identities>,
) -> std::io::Result<()> {
    if web.is_some()
        && access
            .as_ref()
            .is_none_or(|access| access.token.chars().count() < 32)
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Hosted mode requires an access token of at least 32 characters",
        ));
    }
    if !listener.local_addr()?.ip().is_loopback() && (web.is_none() || access.is_none()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "unauthenticated POC must bind loopback",
        ));
    }
    // Revocation is persisted before cleanup. Retry it before serving clients
    // in case the previous process stopped between those steps.
    server
        .clear_revoked_window_state(&identities)
        .await
        .map_err(io::Error::other)?;
    let stopping = CancellationToken::new();
    let connections = Arc::new(Semaphore::new(CONNECTIONS as usize));
    let hosted = web.is_some();
    let adapter = Adapter {
        server,
        hosted,
        identities: identities.clone(),
        profile_updates: Arc::default(),
        member_edits: Arc::default(),
        credentials: Arc::default(),
        owner_setup: Arc::default(),
        sign_in_limit: Arc::default(),
        trusted_sign_in_proxies: std::env::var("TOKAMAK_TRUSTED_PROXY")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| {
                value
                    .parse::<std::net::IpAddr>()
                    .map(|ip| ip.to_canonical())
            })
            .collect::<Result<_, _>>()
            .map_err(io::Error::other)?,
        stopping: stopping.clone(),
        connections: connections.clone(),
        snapshot_streams: Arc::new(Semaphore::new(CONNECTIONS as usize)),
        access,
        origins: allowed_origins(web.as_ref()),
    };
    let app = routes(adapter, web);
    // Axum owns and awaits HTTP connection tasks, but graceful HTTP shutdown
    // alone can wait forever on an incomplete upgrade header. Give EVERY
    // accepted socket cancellable I/O before handing it to Hyper, not just the
    // connections that eventually reach our WebSocket handler.
    let listener = ShutdownListener {
        listener,
        stopping: stopping.clone(),
    };
    let presence = hosted.then(|| start_last_seen_timer(identities.clone(), stopping.clone()));
    let trigger = stopping.clone();
    let result = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<PeerAddr>(),
    )
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
    if let Some(presence) = presence {
        if let Err(error) = presence.await {
            eprintln!("Device last-seen timer failed: {error}");
        }
        flush_last_seen(identities).await;
    }
    result
}

fn routes(adapter: Adapter, web: Option<HostedWeb>) -> Router {
    let mut app = Router::new()
        .route("/account", get(whoami).post(rename))
        .route("/ws", get(upgrade))
        .route("/plugins", get(plugins))
        .route("/plugins/{id}/{revision}/assets/{*name}", get(plugin_asset));
    if adapter.hosted {
        app = app
            .route("/health", get(|| async { "ok" }))
            .merge(members::routes())
            .merge(sign_in::routes())
            .route(DEVICE_STREAM_PATH, get(devices_live))
            .route(DEVICE_REVOKE_PATH, post(revoke_device));
    } else if adapter.access.is_some() {
        app = app.route("/health", get(health));
    }
    if adapter.access.is_some() {
        app = app
            .route("/shutdown", post(stop))
            .route("/plugins/{id}/reload", post(reload_plugin));
    }
    let app = app
        .layer(middleware::from_fn_with_state(adapter.clone(), authorize))
        .with_state(adapter);
    if let Some(web) = web {
        app.fallback_service(
            Router::new()
                .fallback(get(crate::web::shell))
                .with_state(web),
        )
    } else {
        app
    }
}

fn start_last_seen_timer(
    identities: Arc<Identities>,
    stopping: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // Start one interval from now, rather than flushing on the first connection.
        let mut ticks = tokio::time::interval_at(
            tokio::time::Instant::now() + LAST_SEEN_FLUSH_INTERVAL,
            LAST_SEEN_FLUSH_INTERVAL,
        );
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                biased;
                _ = stopping.cancelled() => break,
                _ = ticks.tick() => flush_last_seen(identities.clone()).await,
            }
        }
    })
}

async fn flush_last_seen(identities: Arc<Identities>) {
    // A lost display timestamp must never prevent use of an otherwise valid key.
    match tokio::task::spawn_blocking(move || identities.flush_last_seen()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("Could not save device last seen: {error}"),
        Err(error) => eprintln!("Device last-seen task failed: {error}"),
    }
}

async fn authorize(
    State(adapter): State<Adapter>,
    headers: HeaderMap,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    let path = request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str);
    let members_route = adapter.hosted && members::matches_path(path);
    let browser_route = members_route
        || request.uri().path() == "/account"
        || request.uri().path() == "/ws"
        || request.uri().path().starts_with("/devices/")
        || (adapter.hosted && request.uri().path().starts_with("/auth/"))
        || request.uri().path() == "/plugins"
        || (request.uri().path().starts_with("/plugins/")
            && request.uri().path().contains("/assets/"));
    let origin = headers.get("origin");
    if let Some(origin) = origin
        && (!browser_route
            || !(adapter
                .origins
                .iter()
                .any(|allowed| origin.as_bytes() == allowed.as_bytes())
                || (adapter.hosted && same_http_origin(&headers, origin))))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if request.method() == Method::OPTIONS
        && let Some((methods, allowed_headers)) = preflight_route(path)
    {
        return with_origin(
            authorization_preflight(&headers, methods, allowed_headers),
            origin,
        );
    }
    let public = adapter.hosted
        && (request.uri().path() == "/health"
            || matches!(path, Some(sign_in::METHODS | sign_in::SIGN_IN)));
    if !public {
        let socket_bearer = (path == Some("/ws"))
            .then(|| websocket_bearer(&headers))
            .flatten();
        let bearer = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));
        let actual = bearer.or(socket_bearer.as_deref()).unwrap_or_default();
        let Some(auth) = adapter.identities.authenticate(actual) else {
            // An allowed origin may read the 401, so a client can tell a rejected
            // token from a refused origin or an unreachable server.
            return with_origin(StatusCode::UNAUTHORIZED.into_response(), origin);
        };
        let path = request.uri().path();
        if ((path == "/shutdown" || path.ends_with("/reload")) && auth.user.role != Role::Owner)
            || (members_route && !members::can_manage(auth.user.role))
        {
            return with_origin(StatusCode::FORBIDDEN.into_response(), origin);
        }
        request.extensions_mut().insert(auth);
    }
    with_origin(next.run(request).await, origin)
}

fn preflight_route(path: Option<&str>) -> Option<(&'static str, &'static str)> {
    match path {
        Some("/account") => Some(("GET, POST", "authorization")),
        Some(members::MEMBERS) => Some(("GET, POST", "authorization, content-type")),
        Some(members::LIVE) => Some(("GET", "authorization")),
        Some(members::ROLE | members::REVOKE | members::RESET) => {
            Some(("POST", "authorization, content-type"))
        }
        Some(sign_in::SIGN_IN | sign_in::OWNER_KEY | sign_in::OWNER_SETUP) => {
            Some(("POST", "authorization, content-type"))
        }
        Some(
            sign_in::METHODS
            | DEVICE_STREAM_PATH
            | "/plugins"
            | "/plugins/{id}/{revision}/assets/{*name}",
        ) => Some(("GET", "authorization")),
        Some(DEVICE_REVOKE_PATH) => Some(("POST", "authorization")),
        _ => None,
    }
}

// Only called once the origin has passed the allowlist above.
fn with_origin(mut response: Response, origin: Option<&axum::http::HeaderValue>) -> Response {
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert("access-control-allow-origin", origin.clone());
        response
            .headers_mut()
            .insert("vary", "Origin".parse().expect("header"));
    }
    response
}

// Direct HTTP hosting needs no origin configuration, even on a wildcard bind.
// TLS proxies use TOKAMAK_PUBLIC_URL; never trust forwarded headers for this.
fn same_http_origin(headers: &HeaderMap, origin: &axum::http::HeaderValue) -> bool {
    headers
        .get("host")
        .and_then(|host| host.to_str().ok())
        .and_then(|host| reqwest::Url::parse(&format!("http://{host}")).ok())
        .is_some_and(|url| origin.as_bytes() == url.origin().ascii_serialization().as_bytes())
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

async fn whoami(Extension(caller): Extension<AuthContext>) -> Response {
    account_result(Ok(serde_json::json!(caller.user)))
}

#[derive(serde::Deserialize)]
struct DisplayName {
    name: String,
}

async fn rename(
    State(adapter): State<Adapter>,
    Extension(caller): Extension<AuthContext>,
    body: String,
) -> Response {
    let result = async {
        let input: DisplayName = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let user = adapter
            .update_user(|| adapter.identities.rename(&caller.user.id, &input.name))
            .await?;
        Ok(serde_json::json!(user))
    }
    .await;
    account_result(result)
}

async fn devices_live(
    State(adapter): State<Adapter>,
    Extension(caller): Extension<AuthContext>,
) -> Response {
    snapshots(adapter, caller, Identities::devices)
}

fn authorization_preflight(
    headers: &HeaderMap,
    methods: &'static str,
    allowed_headers: &'static str,
) -> Response {
    let requested_method = headers
        .get("access-control-request-method")
        .and_then(|method| method.to_str().ok());
    if !headers.contains_key("origin")
        || !requested_method
            .is_some_and(|requested| methods.split(", ").any(|method| method == requested))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    (
        StatusCode::NO_CONTENT,
        [
            ("access-control-allow-methods", methods),
            ("access-control-allow-headers", allowed_headers),
        ],
    )
        .into_response()
}

fn websocket_bearer(headers: &HeaderMap) -> Option<std::borrow::Cow<'_, str>> {
    // Browser WebSockets cannot set Authorization. Read the credential from
    // the offered protocols, and negotiate only the public "tokamak" protocol.
    let protocol = headers
        .get_all("sec-websocket-protocol")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .find_map(|value| value.trim().strip_prefix(WS_BEARER_PREFIX))?;
    percent_encoding::percent_decode_str(protocol)
        .decode_utf8()
        .ok()
}

async fn revoke_device(
    State(adapter): State<Adapter>,
    Extension(caller): Extension<AuthContext>,
    Path(id): Path<String>,
) -> Response {
    match adapter.identities.revoke_device(&caller, &id) {
        Ok(()) => account_result(Ok(serde_json::json!({"revoked": id}))),
        Err(RevokeError::Unknown) => StatusCode::NOT_FOUND.into_response(),
        Err(RevokeError::Forbidden) => StatusCode::FORBIDDEN.into_response(),
        Err(RevokeError::Store(error)) => {
            eprintln!("Could not save device sign-out: {error}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
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
    Path((id, revision, name)): Path<(String, String, String)>,
) -> Response {
    match adapter
        .server
        .plugin_asset_at(id, name.clone(), Some(revision))
        .await
    {
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
                    ("cache-control", "private, max-age=31536000, immutable"),
                ],
                axum::body::Body::from_stream(stream),
            )
                .into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => plugin_result(Err(error)),
    }
}

async fn upgrade(
    State(adapter): State<Adapter>,
    Extension(auth): Extension<AuthContext>,
    ws: WebSocketUpgrade,
) -> Response {
    let Ok(permit) = adapter.connections.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if adapter.stopping.is_cancelled() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    ws.protocols([WS_PROTOCOL])
        .max_message_size(MESSAGE_BYTES)
        .max_frame_size(MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            connection(socket, adapter, auth).await;
        })
        .into_response()
}

async fn connection(mut socket: WebSocket, adapter: Adapter, caller: AuthContext) {
    let (session, revoked) = {
        // The HTTP upgrade may have identified an older name or role. Admit
        // with the latest profile, ordered against changes to existing sessions.
        let _profiles = adapter.profile_updates.lock().await;
        let Some((auth, revoked)) = adapter.identities.active_caller(&caller) else {
            return;
        };
        let session = tokio::select! {
            _ = adapter.stopping.cancelled() => return,
            _ = revoked.cancelled() => return,
            session = adapter.server.connect_authenticated(auth, revoked.clone()) => match session { Ok(session) => session, Err(_) => return },
        };
        (session, revoked)
    };
    adapter
        .identities
        .record_last_seen(&caller, DeviceSocket::Opened);
    tokio::select! {
        biased;
        _ = revoked.cancelled() => {
            let close = Message::Close(Some(CloseFrame { code: DEVICE_SIGNED_OUT, reason: "Device signed out".into() }));
            let _ = tokio::time::timeout(Duration::from_millis(250), socket.send(close)).await;
        },
        _ = connection_session(&mut socket, session, adapter.stopping) => {},
    }
    adapter
        .identities
        .record_last_seen(&caller, DeviceSocket::Closed);
}

async fn connection_session(
    socket: &mut WebSocket,
    mut session: crate::Session,
    stopping: CancellationToken,
) {
    let mut service = session.sender();
    loop {
        tokio::select! {
            _ = stopping.cancelled() => break,
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
pub(crate) struct ShutdownListener {
    pub(crate) listener: TcpListener,
    pub(crate) stopping: CancellationToken,
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

#[derive(Clone)]
struct PeerAddr(SocketAddr);

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, ShutdownListener>>
    for PeerAddr
{
    fn connect_info(stream: axum::serve::IncomingStream<'_, ShutdownListener>) -> Self {
        Self(*stream.remote_addr())
    }
}

pub(crate) struct ShutdownIo {
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

#[cfg(test)]
mod access_tests {
    use super::same_http_origin;

    #[test]
    fn direct_http_origin_matches_the_request_host_only() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("host", "localhost:43123".parse().unwrap());
        assert!(same_http_origin(
            &headers,
            &"http://localhost:43123".parse().unwrap()
        ));
        for origin in [
            "https://localhost:43123",
            "http://localhost:43124",
            "http://untrusted.invalid",
        ] {
            assert!(!same_http_origin(&headers, &origin.parse().unwrap()));
        }
    }
}
