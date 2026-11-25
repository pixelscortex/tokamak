//! Route lookup uses the installed catalog. HTTP I/O stays outside the coordinator.
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    process::Stdio,
    sync::Arc,
};

use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{OwnedSemaphorePermit, Semaphore},
};
use tokio_util::sync::CancellationToken;

use crate::{Server, plugins::Asset};

const CHUNK_BYTES: usize = 64 * 1024;
const HEAD_BYTES: usize = 256 * 1024;
const REQUEST_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const PLUGIN_CAPACITY: usize = 8;

pub(crate) struct Route {
    pub code: Arc<Asset>,
    pub pattern: String,
    pub params: BTreeMap<String, String>,
    pub permissions: Vec<String>,
    pub slots: Arc<Semaphore>,
}

#[derive(Clone)]
struct HttpActions {
    server: Arc<Server>,
    server_url: String,
    stopping: CancellationToken,
    slots: Arc<Semaphore>,
}

pub(crate) fn router(
    server: Arc<Server>,
    stopping: CancellationToken,
    web: Option<crate::web::HostedWeb>,
    listen: std::net::SocketAddr,
) -> Router {
    let state = HttpActions {
        server,
        server_url: web
            .as_ref()
            .map_or_else(|| format!("http://{listen}"), |web| web.origin.clone()),
        stopping,
        slots: Arc::new(Semaphore::new(64)),
    };
    let route = || axum::routing::any(handle);
    let router = Router::new()
        .route("/plugins/{id}", route())
        .route("/plugins/{id}/", route())
        .route("/plugins/{id}/{*path}", route())
        .with_state(state);
    match web {
        Some(web) => router.fallback_service(
            Router::new()
                .fallback(axum::routing::get(crate::web::shell))
                .with_state(web),
        ),
        None => router,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Segment<'a> {
    Literal(&'a str),
    Parameter(&'a str),
    Rest,
}

fn segments(pattern: &str) -> impl Iterator<Item = Segment<'_>> {
    pattern[1..].split('/').map(|part| match part {
        "*" => Segment::Rest,
        _ => part
            .strip_prefix(':')
            .map_or(Segment::Literal(part), Segment::Parameter),
    })
}

pub(crate) fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() || paths.len() > 128 {
        return Err("HTTP action entry must declare between 1 and 128 paths".into());
    }
    let mut shapes = BTreeSet::new();
    for path in paths {
        let invalid = || format!("Invalid HTTP action path: {path}");
        if !path.starts_with('/') || path.len() > 2048 || path.contains(['?', '#', '\\']) {
            return Err(invalid());
        }
        let mut params = BTreeSet::new();
        let mut shape = Vec::new();
        let mut parts = segments(path).peekable();
        while let Some(part) = parts.next() {
            match part {
                Segment::Literal(value) if value.contains(['*', ':']) => return Err(invalid()),
                Segment::Parameter(name)
                    if name.is_empty()
                        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                        || !params.insert(name) =>
                {
                    return Err(invalid());
                }
                Segment::Rest if parts.peek().is_some() => return Err(invalid()),
                _ => {}
            }
            shape.push(match part {
                Segment::Literal(value) => value,
                Segment::Parameter(_) => ":",
                Segment::Rest => "*",
            });
        }
        if !shapes.insert(shape) {
            return Err(format!("Ambiguous HTTP action path: {path}"));
        }
    }
    Ok(())
}

pub(crate) fn match_path<'a>(
    patterns: &'a [String],
    path: &str,
) -> Option<(&'a str, BTreeMap<String, String>)> {
    let parts = path
        .strip_prefix('/')?
        .split('/')
        .map(|part| percent_encoding::percent_decode_str(part).decode_utf8())
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    patterns
        .iter()
        .filter_map(|pattern| {
            let mut remaining = parts.iter();
            let mut specificity = Vec::new();
            let mut params = BTreeMap::new();
            for segment in segments(pattern) {
                match segment {
                    Segment::Literal(value) if remaining.next()?.as_ref() == value => {
                        specificity.push(2)
                    }
                    Segment::Literal(_) => return None,
                    Segment::Parameter(name) => {
                        let part = remaining.next()?.as_ref();
                        if part.is_empty() {
                            return None;
                        }
                        params.insert(name.to_owned(), part.to_owned());
                        specificity.push(1);
                    }
                    Segment::Rest => {
                        let tail = remaining
                            .by_ref()
                            .map(|part| part.as_ref())
                            .collect::<Vec<_>>()
                            .join("/");
                        params.insert("*".into(), tail);
                        specificity.push(0);
                    }
                }
            }
            if remaining.next().is_some() {
                return None;
            }
            // Exact matches win over a wildcard matching an empty suffix.
            specificity.push(3);
            Some((specificity, pattern.as_str(), params))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, pattern, params)| (pattern, params))
}

async fn handle(
    State(state): State<HttpActions>,
    Path(params): Path<BTreeMap<String, String>>,
    request: Request,
) -> Response {
    let Some(plugin) = params.get("id") else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Use the URI rather than the wildcard extractor: decoding separators
    // before matching would change how many segments the caller supplied.
    let path = request
        .uri()
        .path()
        .strip_prefix("/plugins/")
        .and_then(|path| path.find('/').map(|index| &path[index..]))
        .unwrap_or("/");
    let route = match state
        .server
        .http_action(plugin.clone(), path.to_owned())
        .await
    {
        Ok(Some(route)) => route,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let Ok(plugin_slot) = route.slots.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Ok(slot) = state.slots.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let stopping = state.stopping.clone();
    tokio::select! {
        () = stopping.cancelled() => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        result = invoke(state, route, path.to_owned(), request, [slot, plugin_slot]) => match result {
            Ok(response) => response,
            Err(error) => {
                eprintln!("HTTP action for {plugin}: {error}");
                StatusCode::BAD_GATEWAY.into_response()
            }
        }
    }
}

async fn invoke(
    state: HttpActions,
    route: Route,
    path: String,
    request: Request,
    slots: [OwnedSemaphorePermit; 2],
) -> io::Result<Response> {
    let (parts, incoming) = request.into_parts();
    let body = match to_bytes(incoming, REQUEST_BYTES).await {
        Ok(body) => body,
        Err(_) => return Ok(StatusCode::PAYLOAD_TOO_LARGE.into_response()),
    };
    let url = format!(
        "{}{}",
        state.server_url,
        parts
            .uri
            .path_and_query()
            .map_or("/", |value| value.as_str())
    );
    let headers: Vec<_> = parts
        .headers
        .iter()
        .map(|(name, value)| {
            (
                name.as_str(),
                value
                    .as_bytes()
                    .iter()
                    .copied()
                    .map(char::from)
                    .collect::<String>(),
            )
        })
        .collect();
    let heap = tokamak_worker::configured_action_heap_bytes().map_err(io::Error::other)?;
    let head = serde_json::to_vec(&json!({
        "method": parts.method.as_str(),
        "url": url,
        "headers": headers,
        "length": body.len(),
        "heap": heap,
        "permissions": route.permissions,
        "pattern": route.pattern,
        "context": { "serverUrl": state.server_url, "path": path, "params": route.params },
    }))?;
    if head.len() > HEAD_BYTES {
        return Ok(StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE.into_response());
    }
    let host = tokamak_worker::Process::action_host_path().map_err(io::Error::other)?;
    let mut child = Command::new(host)
        .arg("--http-action")
        .arg(route.code.path())
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("Missing HTTP action input"))?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Missing HTTP action output"))?;

    input.write_u32(head.len() as u32).await?;
    input.write_all(&head).await?;
    input.write_all(&body).await?;
    drop(body);
    let running = Running {
        _child: child,
        _input: input,
        output,
        _slots: slots,
        stopping: state.stopping,
    };
    // Keep the verified bundle available until the child has loaded it.
    let response = read_response(running, parts.method).await;
    drop(route);
    response
}

async fn read_response(mut running: Running, method: Method) -> io::Result<Response> {
    let message = read_packet(&mut running.output, HEAD_BYTES).await?;
    let head: ResponseHead = serde_json::from_slice(&message)?;
    let status = StatusCode::from_u16(head.status).map_err(io::Error::other)?;
    let headers = response_headers(head.headers)?;
    let body = if method == Method::HEAD || matches!(head.status, 204 | 205 | 304) {
        Body::empty()
    } else {
        // Hyper drops this state on disconnect. Closing stdin and killing the
        // isolated host also closes any upstream request it was waiting on.
        let stream = futures_util::stream::try_unfold(running, |mut running| async move {
            let packet = tokio::select! {
                () = running.stopping.cancelled() => return Ok(None),
                result = read_packet(&mut running.output, CHUNK_BYTES) => result?,
            };
            Ok::<_, io::Error>((!packet.is_empty()).then(|| (Bytes::from(packet), running)))
        });
        Body::from_stream(stream)
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}

#[derive(Deserialize)]
struct ResponseHead {
    status: u16,
    headers: Vec<(String, String)>,
}

fn response_headers(incoming: Vec<(String, String)>) -> io::Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    for (name, value) in incoming {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(io::Error::other)?;
        let bytes = value
            .chars()
            .map(|c| u8::try_from(c as u32))
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        headers.append(
            name,
            HeaderValue::from_bytes(&bytes).map_err(io::Error::other)?,
        );
    }
    let connection: Vec<_> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect();
    for name in connection {
        headers.remove(name);
    }
    for name in [
        "connection",
        "keep-alive",
        "proxy-connection",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "set-cookie",
        "clear-site-data",
    ] {
        headers.remove(name);
    }
    // The plugin route shares the workspace's origin. A navigated plugin
    // response must not run scripts with access to the workspace window.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(headers)
}

struct Running {
    _child: Child,
    _input: ChildStdin,
    output: ChildStdout,
    _slots: [OwnedSemaphorePermit; 2],
    stopping: CancellationToken,
}

async fn read_packet(
    input: &mut (impl AsyncReadExt + Unpin),
    maximum: usize,
) -> io::Result<Vec<u8>> {
    let length = input.read_u32().await? as usize;
    if length > maximum {
        return Err(io::Error::other("HTTP action packet exceeds its limit"));
    }
    let mut packet = vec![0; length];
    input.read_exact(&mut packet).await?;
    Ok(packet)
}
