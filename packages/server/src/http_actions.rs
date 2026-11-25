//! Route lookup uses the installed catalog. HTTP I/O stays outside the coordinator.
mod config;

use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};

use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::{Request, State},
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
const REQUEST_BYTES: usize = 32 * 1024 * 1024;
const BODY_TIMEOUT: Duration = Duration::from_secs(30);
const SLOT_WAIT: Duration = Duration::from_millis(250);
const ABORT_GRACE: Duration = Duration::from_millis(500);

pub(crate) struct Route {
    pub code: Arc<Asset>,
    pub pattern: String,
    pub params: BTreeMap<String, String>,
    pub permissions: Vec<String>,
    pub slots: Arc<OnceLock<Arc<Semaphore>>>,
}

#[derive(Clone)]
struct HttpActions {
    server: Arc<Server>,
    request_origin: String,
    server_url: Option<String>,
    config: Arc<config::Config>,
    stopping: CancellationToken,
    slots: Arc<Semaphore>,
}

pub(crate) fn router(
    server: Arc<Server>,
    stopping: CancellationToken,
    web: Option<crate::web::HostedWeb>,
    public_origin: Option<String>,
    listen: std::net::SocketAddr,
) -> io::Result<Router> {
    let config = Arc::new(config::Config::load()?);
    let server_url = match &web {
        Some(web) => web.public_origin.clone(),
        None if cfg!(feature = "local-runtime") => Some(format!("http://{listen}")),
        None => public_origin,
    };
    if server_url.is_none() {
        eprintln!(
            "TOKAMAK_PUBLIC_URL is unset; HTTP actions cannot read ctx.serverUrl on this hosted Server"
        );
    }
    let state = HttpActions {
        server,
        request_origin: server_url
            .clone()
            .unwrap_or_else(|| format!("http://{listen}")),
        server_url,
        slots: Arc::new(Semaphore::new(config.total_slots)),
        config,
        stopping,
    };
    let route = || axum::routing::any(handle);
    let router = Router::new()
        .route("/plugins/{id}", route())
        .route("/plugins/{id}/", route())
        .route("/plugins/{id}/{*path}", route())
        .with_state(state);
    Ok(match web {
        Some(web) => router.fallback_service(
            Router::new()
                .fallback(axum::routing::get(crate::web::shell))
                .with_state(web),
        ),
        None => router,
    })
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

async fn handle(State(state): State<HttpActions>, request: Request) -> Response {
    let Some(rest) = request.uri().path().strip_prefix("/plugins/") else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (plugin, path) = rest
        .find('/')
        .map_or((rest, "/"), |index| rest.split_at(index));
    // Validate before matching or building a WHATWG URL, which normalizes dot segments.
    let Ok(plugin) = safe_segment(plugin) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if path
        .split('/')
        .any(|segment| safe_segment(segment).is_err())
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let (plugin, path) = (plugin.into_owned(), path.to_owned());
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok()?.parse::<u64>().ok())
        .is_some_and(|length| length > REQUEST_BYTES as u64)
    {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let route = match state.server.http_action(plugin.clone(), path).await {
        Ok(Some(route)) => route,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return busy(),
    };
    let stopping = state.stopping.clone();
    tokio::select! {
        () = stopping.cancelled() => busy(),
        response = run_request(state, route, request, &plugin) => response,
    }
}

fn safe_segment(segment: &str) -> Result<std::borrow::Cow<'_, str>, ()> {
    let decoded = percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .map_err(|_| ())?;
    if matches!(decoded.as_ref(), "." | "..") || decoded.contains(['/', '\\']) {
        return Err(());
    }
    Ok(decoded)
}

fn busy() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::RETRY_AFTER, "1")],
    )
        .into_response()
}

async fn run_request(state: HttpActions, route: Route, request: Request, plugin: &str) -> Response {
    let (parts, incoming) = request.into_parts();
    let body = match tokio::time::timeout(BODY_TIMEOUT, to_bytes(incoming, REQUEST_BYTES)).await {
        Ok(Ok(body)) => body,
        Ok(Err(error)) => {
            use std::error::Error;
            return if error
                .source()
                .is_some_and(|cause| cause.is::<http_body_util::LengthLimitError>())
            {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::BAD_REQUEST
            }
            .into_response();
        }
        Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
    };
    let plugin_slots = route
        .slots
        .get_or_init(|| Arc::new(Semaphore::new(state.config.plugin_slots)));
    let Ok(Some(slots)) = tokio::time::timeout(SLOT_WAIT, async {
        let plugin = plugin_slots.clone().acquire_owned().await.ok()?;
        let shared = state.slots.clone().acquire_owned().await.ok()?;
        Some([shared, plugin])
    })
    .await
    else {
        return busy();
    };
    match tokio::time::timeout(
        state.config.first_headers,
        invoke(state, route, parts, body, slots),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            eprintln!("HTTP action for {plugin}: {error}");
            StatusCode::BAD_GATEWAY.into_response()
        }
        Err(_) => StatusCode::GATEWAY_TIMEOUT.into_response(),
    }
}

fn request_head(
    state: &HttpActions,
    route: &Route,
    parts: &mut axum::http::request::Parts,
    length: usize,
) -> io::Result<Vec<u8>> {
    let url = format!(
        "{}{}",
        state.request_origin,
        parts
            .uri
            .path_and_query()
            .map_or("/", |value| value.as_str())
    );
    let original_host = parts
        .headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    strip_hop_headers(&mut parts.headers);
    parts.headers.remove(header::HOST);
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
    // A buffered 32 MiB request may also be decoded to a JS string and parsed.
    let heap = tokamak_worker::configured_action_heap_bytes()
        .map_err(io::Error::other)?
        .max(192 * 1024 * 1024);
    Ok(serde_json::to_vec(&json!({
        "method": parts.method.as_str(),
        "url": url,
        "headers": headers,
        "length": length,
        "heap": heap,
        "permissions": route.permissions,
        "pattern": route.pattern,
        "context": { "serverUrl": state.server_url, "params": route.params, "originalHost": original_host },
    }))?)
}

async fn invoke(
    state: HttpActions,
    route: Route,
    mut parts: axum::http::request::Parts,
    body: Bytes,
    slots: [OwnedSemaphorePermit; 2],
) -> io::Result<Response> {
    let head = request_head(&state, &route, &mut parts, body.len())?;
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
    let input = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("Missing HTTP action input"))?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Missing HTTP action output"))?;

    let mut running = Running {
        child: Some(child),
        input: Some(input),
        output: Some(output),
        slots: Some(slots),
        stopping: state.stopping,
    };
    if let Some(input) = &mut running.input {
        input.write_u32(head.len() as u32).await?;
        input.write_all(&head).await?;
        input.write_all(&body).await?;
    }
    drop(body);
    // Keep the verified bundle available until the child has loaded it.
    let response = read_response(running, parts.method).await;
    drop(route);
    response
}

async fn read_response(mut running: Running, method: Method) -> io::Result<Response> {
    let message = running.read(HEAD_BYTES).await?;
    let head: ResponseHead = serde_json::from_slice(&message)?;
    let status = StatusCode::from_u16(head.status).map_err(io::Error::other)?;
    if status.is_informational() {
        return Err(io::Error::other(
            "HTTP actions cannot return informational statuses",
        ));
    }
    let headers = response_headers(head.headers)?;
    let body = if method == Method::HEAD || matches!(head.status, 204 | 205 | 304) {
        Body::empty()
    } else {
        // Dropping the stream starts cancellation even if the child is idle.
        let stream = futures_util::stream::try_unfold(running, |mut running| async move {
            let stopping = running.stopping.clone();
            let packet = tokio::select! {
                () = stopping.cancelled() => return Ok(None),
                result = running.read(CHUNK_BYTES) => result?,
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
    strip_hop_headers(&mut headers);
    for name in ["set-cookie", "clear-site-data"] {
        headers.remove(name);
    }
    // Do not let plugin responses execute scripts in the workspace origin.
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

fn strip_hop_headers(headers: &mut HeaderMap) {
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
    ] {
        headers.remove(name);
    }
}

struct Running {
    child: Option<Child>,
    input: Option<ChildStdin>,
    output: Option<ChildStdout>,
    slots: Option<[OwnedSemaphorePermit; 2]>,
    stopping: CancellationToken,
}

impl Running {
    async fn read(&mut self, maximum: usize) -> io::Result<Vec<u8>> {
        let output = self
            .output
            .as_mut()
            .ok_or_else(|| io::Error::other("Missing HTTP action output"))?;
        read_packet(output, maximum).await
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        // EOF signals AbortController in the child. Drain its pipe while cleanup
        // runs so a full pipe cannot prevent JS from seeing cancellation.
        self.input.take();
        let (Some(mut child), Some(mut output)) = (self.child.take(), self.output.take()) else {
            return;
        };
        let slots = self.slots.take();
        tokio::spawn(async move {
            let _slots = slots;
            let cleanup = async {
                let mut sink = tokio::io::sink();
                let (status, _) =
                    tokio::join!(child.wait(), tokio::io::copy(&mut output, &mut sink));
                status
            };
            if tokio::time::timeout(ABORT_GRACE, cleanup).await.is_err() {
                let _ = child.kill().await;
            }
        });
    }
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
