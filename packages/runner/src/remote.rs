use crate::local::{Local, quickjs};
use anyhow::{Context, Result, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use reqwest::{StatusCode, header};
use server::{
    RunnerAction, RunnerActionUpstream,
    machine_wire::{self, Incoming, Packet, Peer, Request},
};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        Message,
        handshake::{client::generate_key, derive_accept_key},
        protocol::{Role, WebSocketConfig},
    },
};
use tokio_util::sync::CancellationToken;

const FRAME_BYTES: usize = engine::MAX_WIRE_MESSAGE_BYTES;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const BACKOFF_MIN: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(15);

pub(super) struct Config {
    url: reqwest::Url,
    key_file: PathBuf,
    plugins: PathBuf,
    data: PathBuf,
}

impl Config {
    pub(super) fn new(
        address: String,
        key_file: PathBuf,
        plugins: PathBuf,
        data: PathBuf,
    ) -> Result<Self> {
        let mut url =
            reqwest::Url::parse(&address).map_err(|_| anyhow::anyhow!("Invalid --server URL"))?;
        ensure!(
            url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && url.path() == "/",
            "--server must be an origin without credentials, path, query or fragment"
        );
        let scheme = match url.scheme() {
            "http" | "ws" => {
                ensure!(
                    url.host_str().is_some_and(|host| {
                        host == "localhost"
                            || host
                                .trim_matches(['[', ']'])
                                .parse::<std::net::IpAddr>()
                                .is_ok_and(|ip| ip.is_loopback())
                    }),
                    "Use an HTTPS or WSS server address outside loopback"
                );
                "http"
            }
            "https" | "wss" => "https",
            _ => bail!("Expected an HTTP(S) or WS(S) server address"),
        };
        url.set_scheme(scheme)
            .map_err(|_| anyhow::anyhow!("Invalid --server scheme"))?;
        url.set_path(machine_wire::PATH);
        Ok(Self {
            url,
            key_file,
            plugins,
            data,
        })
    }
}

pub(super) async fn run(config: Config, stop: CancellationToken) -> Result<()> {
    let secret = crate::read_secret(&config.key_file).context("Could not read device key file")?;
    crate::check_plugin_host().await?;
    crate::signals(stop.clone()).await?;
    let plugins = config.plugins.canonicalize()?;
    crate::ownership::private_directory(&config.data)?;
    let local = Local::new(plugins, config.data.canonicalize()?);
    let workspace: Arc<str> = Arc::from(config.url.as_str());
    let mut key = header::HeaderValue::from_str(&format!("Bearer {secret}"))
        .map_err(|_| anyhow::anyhow!("Invalid device key"))?;
    key.set_sensitive(true);

    let result = reconnect(&local, &config.url, workspace, key, stop).await;
    local.shutdown().await;
    result
}

async fn reconnect(
    local: &Local,
    url: &reqwest::Url,
    workspace: Arc<str>,
    key: header::HeaderValue,
    stop: CancellationToken,
) -> Result<()> {
    let mut client = reqwest::Client::builder()
        .http1_only()
        .redirect(reqwest::redirect::Policy::none());
    if url.scheme() == "http" {
        client = client.no_proxy();
        if url.host_str() == Some("localhost") {
            client =
                client.resolve_to_addrs("localhost", &["127.0.0.1:0".parse()?, "[::1]:0".parse()?]);
        }
    }
    let client = client.build()?;
    let mut delay = BACKOFF_MIN;
    loop {
        let attempt = tokio::select! {
            () = stop.cancelled() => return Ok(()),
            result = tokio::time::timeout(CONNECT_TIMEOUT, connect(&client, url, &key)) => result,
        };
        match attempt {
            Ok(Ok(Some(socket))) => {
                let connected = tokio::time::Instant::now();
                connection(local, socket, workspace.clone(), &stop).await?;
                if connected.elapsed() >= machine_wire::HEARTBEAT_LIMIT {
                    delay = BACKOFF_MIN;
                }
            }
            Ok(Ok(None)) => bail!("Server refused the device key (invalid or revoked)"),
            Ok(Err(error)) => eprintln!("Machine connection failed: {error}"),
            Err(_) => eprintln!("Machine connection timed out"),
        }

        // Show a stable error for credential failures; never print handshake headers.
        let jitter = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |time| u64::from(time.subsec_nanos()) % 250);
        tokio::select! {
            () = stop.cancelled() => return Ok(()),
            () = tokio::time::sleep(delay + Duration::from_millis(jitter)) => {},
        }
        delay = (delay * 2).min(BACKOFF_MAX);
    }
}

async fn connect(
    client: &reqwest::Client,
    url: &reqwest::Url,
    key: &header::HeaderValue,
) -> Result<Option<WebSocketStream<reqwest::Upgraded>>> {
    // Tungstenite's client handshake traces raw HTTP bytes. Use the existing
    // HTTP client with a sensitive header, then give tungstenite only the data stream.
    let nonce = generate_key();
    let protocol = server::websocket::WS_PROTOCOL;
    let response = client
        .get(url.clone())
        .header(header::AUTHORIZATION, key.clone())
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, &nonce)
        .header(header::SEC_WEBSOCKET_PROTOCOL, protocol)
        .header(machine_wire::STAGE_PLANS_HEADER, machine_wire::STAGE_PLANS)
        .send()
        .await?;
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Ok(None);
    }
    let headers = response.headers();
    let matches_header = |name: header::HeaderName, expected: &str| {
        headers.get(name).and_then(|value| value.to_str().ok()) == Some(expected)
    };
    ensure!(
        response.status() == StatusCode::SWITCHING_PROTOCOLS
            && matches_header(
                header::SEC_WEBSOCKET_ACCEPT,
                &derive_accept_key(nonce.as_bytes())
            )
            && matches_header(header::SEC_WEBSOCKET_PROTOCOL, protocol)
            && !headers.contains_key(header::SEC_WEBSOCKET_EXTENSIONS),
        "Invalid server machine socket handshake (HTTP {})",
        response.status()
    );
    let settings = WebSocketConfig::default()
        .max_frame_size(Some(FRAME_BYTES))
        .max_message_size(Some(FRAME_BYTES));
    Ok(Some(
        WebSocketStream::from_raw_socket(response.upgrade().await?, Role::Client, Some(settings))
            .await,
    ))
}

async fn connection(
    local: &Local,
    mut socket: WebSocketStream<reqwest::Upgraded>,
    workspace: Arc<str>,
    stopping: &CancellationToken,
) -> Result<()> {
    let (peer, mut outgoing) = Peer::new();
    let mut incoming = Incoming::default();
    let (interval, limit) = machine_wire::heartbeat();
    let mut ticks = tokio::time::interval(interval);
    let mut deadline = tokio::time::Instant::now() + limit;
    let mut refused = None;
    loop {
        let send = tokio::select! {
            biased;
            () = stopping.cancelled() => break,
            () = peer.stop().cancelled() => break,
            () = tokio::time::sleep_until(deadline) => break,
            reaped = incoming.reap() => if reaped { continue } else { break },
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let Ok(packet) = serde_json::from_str::<Packet>(&text) else { break };
                    let pool = local.pool.clone();
                    let workspace = workspace.clone();
                    let peer_for_call = peer.clone();
                    incoming.receive(&peer, packet, move |id, request, retiring| async move {
                        let Request::Invoke { plugin, entry_hash, code_hash, name, args } = request else {
                            return Err("Expected a machine action invocation".into());
                        };
                        let leases = Arc::new(quickjs::Leases::new(&pool, workspace));
                        quickjs::action(pool, leases, RunnerAction {
                            plugin, entry_hash, code_hash, name, args,
                            upstream: RunnerActionUpstream::connected(peer_for_call, id),
                            retiring,
                        }).await.map_err(Into::into)
                    });
                    continue;
                }
                Some(Ok(Message::Pong(_))) => {
                    deadline = tokio::time::Instant::now() + limit;
                    continue;
                }
                Some(Ok(Message::Ping(_))) => continue,
                Some(Ok(Message::Close(frame))) => {
                    refused = match frame.map(|frame| u16::from(frame.code)) {
                        Some(server::websocket::DEVICE_SIGNED_OUT) => Some("Server revoked the device key"),
                        Some(machine_wire::DUPLICATE) => Some("A Runner is already connected with this device key"),
                        _ => None,
                    };
                    break;
                }
                _ => break,
            },
            Some(packet) = outgoing.recv() => {
                let Ok(text) = serde_json::to_string(&packet) else { break };
                if text.len() > FRAME_BYTES { break; }
                Message::Text(text.into())
            },
            _ = ticks.tick() => Message::Ping(Default::default()),
        };
        if !matches!(
            tokio::time::timeout_at(deadline, socket.send(send)).await,
            Ok(Ok(()))
        ) {
            break;
        }
    }
    peer.stop().cancel();
    drop(socket);
    incoming.shutdown().await;
    if let Some(message) = refused {
        bail!(message);
    }
    Ok(())
}
