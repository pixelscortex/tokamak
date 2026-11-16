//! A separate loopback listener with no owner or plugin control routes.
use super::{
    Operation,
    limits::{self, Joins},
};
use crate::{Server, websocket};
use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use std::{
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::{net::TcpListener, sync::Semaphore};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct GuestListener {
    server: Arc<Server>,
    stopping: CancellationToken,
    connections: Arc<Semaphore>,
    joins: Arc<Mutex<Joins>>,
}

pub async fn serve(
    listener: TcpListener,
    server: Arc<Server>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    if !listener.local_addr()?.ip().is_loopback() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Guest listener must bind loopback",
        ));
    }
    let stopping = CancellationToken::new();
    let connections = Arc::new(Semaphore::new(limits::CONNECTIONS as usize));
    let state = GuestListener {
        server,
        stopping: stopping.clone(),
        connections: connections.clone(),
        joins: Arc::new(Mutex::new(Joins::new())),
    };
    let app = Router::new()
        .route(
            "/join",
            post(join).route_layer(middleware::from_fn_with_state(state.clone(), join_limit)),
        )
        .route("/ws", get(upgrade))
        .layer(DefaultBodyLimit::max(limits::MESSAGE_BYTES))
        .layer(middleware::from_fn(no_origin))
        .with_state(state);
    let listener = websocket::ShutdownListener {
        listener,
        stopping: stopping.clone(),
    };
    let trigger = stopping.clone();
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown.await;
            trigger.cancel();
        })
        .await;
    stopping.cancel();
    let _all = connections.acquire_many(limits::CONNECTIONS).await;
    result
}

async fn no_origin(headers: HeaderMap, request: axum::extract::Request, next: Next) -> Response {
    if headers.contains_key("origin") {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

async fn join_limit(
    State(state): State<GuestListener>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if !state.joins.lock().expect("join limit").allow() {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    next.run(request).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Join {
    code: String,
    name: String,
}

async fn join(State(state): State<GuestListener>, body: Bytes) -> Response {
    let Ok(input) = serde_json::from_slice::<Join>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match state
        .server
        .members(Operation::Join {
            code: input.code,
            name: input.name,
        })
        .await
    {
        Ok(value) => (
            [
                ("content-type", "application/json"),
                ("cache-control", "no-store"),
            ],
            value.to_string(),
        )
            .into_response(),
        Err(_) => StatusCode::UNAUTHORIZED.into_response(),
    }
}

async fn upgrade(
    State(state): State<GuestListener>,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> Response {
    let Some(token) = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    // Auth and connect run in one coordinator command, ordered against revoke.
    let session = match state.server.connect_member(token.to_owned()).await {
        Ok(session) => session,
        Err(_) => return StatusCode::UNAUTHORIZED.into_response(),
    };
    let Ok(permit) = state.connections.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if state.stopping.is_cancelled() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let ws = match ws {
        Ok(ws) => ws,
        Err(error) => return error.into_response(),
    };
    ws.max_message_size(limits::MESSAGE_BYTES)
        .max_frame_size(limits::MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            websocket::connection_session(socket, session, state.stopping, true).await;
        })
        .into_response()
}
