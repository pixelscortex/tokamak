#![cfg(any(target_os = "linux", target_os = "macos"))]

use engine::PoolConfig;
use serde_json::{Value, json};
use server::{Backend, Event, data::Storage, websocket};
use std::{path::Path, process::Command, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    time::{advance, pause, resume, timeout},
};

#[tokio::test]
async fn http_actions_stream_and_cancel_without_using_normal_action_slots() {
    let fixture = build_fixture();
    let mut pool = PoolConfig::default();
    pool.limits.call_timeout = Duration::from_millis(50);
    let backend = Backend::start_plugins(Storage::Memory, pool, fixture.path())
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (stop, shutdown) = oneshot::channel();
    let server = tokio::spawn(serve(listener, &backend, shutdown));
    let route = format!("{origin}/plugins/http-proxy/ACME/v1/messages");
    check_routing(&origin, &route).await;
    check_uploads(&origin, &route).await;
    check_slot_wait(&origin).await;
    check_response_failures(&origin).await;
    check_streams(&backend, &origin, &route).await;
    check_abort_grace(&origin, &route).await;
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
    backend.close().await.unwrap();
}

fn build_fixture() -> tempfile::TempDir {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    // The compiler resolves SDK packages through the workspace installation.
    let target = workspace.join("packages/server/target");
    std::fs::create_dir_all(&target).unwrap();
    let fixture = tempfile::tempdir_in(target).unwrap();
    let output = Command::new("proto")
        .args([
            "run",
            "bun",
            "--",
            "packages/server/tests/build-http-actions.mjs",
        ])
        .arg(fixture.path())
        .current_dir(workspace)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "fixture build:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );

    fixture
}

fn serve(
    listener: TcpListener,
    backend: &Backend,
    shutdown: oneshot::Receiver<()>,
) -> impl Future<Output = std::io::Result<()>> + Send + 'static + use<> {
    let server = Arc::clone(backend.server());
    let access = websocket::LocalAccess {
        token: "owner-access-test-with-32-characters".into(),
        identity: json!({}),
    };
    let shutdown = async {
        let _ = shutdown.await;
    };
    #[cfg(feature = "local-runtime")]
    return websocket::serve_runner(
        listener,
        server,
        shutdown,
        access,
        "fixture-runner".into(),
        axum::routing::get(|| async { "unused" }),
    );
    #[cfg(not(feature = "local-runtime"))]
    websocket::serve_with_access(listener, server, shutdown, Some(access))
}

async fn check_routing(origin: &str, route: &str) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let tail = "/plugins/http-proxy/ACME/v1%20messages?q=one&q=two";
    let url = format!("{origin}{tail}");
    let response = client
        .patch(&url)
        .header("host", "untrusted.invalid")
        .header("x-key", "test-key")
        .body("request bytes")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    assert_eq!(response.headers()["x-fixture"], "proxy");
    let server_url = if cfg!(feature = "local-runtime") {
        origin.to_owned()
    } else {
        std::env::var("TOKAMAK_PUBLIC_URL").map_or_else(
            |_| "Set TOKAMAK_PUBLIC_URL to read ctx.serverUrl on a hosted Server".into(),
            |value| value.trim_end_matches('/').to_owned(),
        )
    };
    let request_origin = if server_url.starts_with("http") {
        &server_url
    } else {
        origin
    };
    let url = format!("{request_origin}{tail}");
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({
            "serverUrl": server_url, "originalHost": "untrusted.invalid", "path": "/ACME/v1%20messages", "params": { "profile": "ACME", "*": "v1 messages" },
            "url": url, "method": "PATCH", "body": "request bytes",
        })
    );
    assert_eq!(client.get(route).send().await.unwrap().status(), 401);
    assert_eq!(
        client
            .request(reqwest::Method::OPTIONS, route)
            .header("x-key", "test-key")
            .send()
            .await
            .unwrap()
            .status(),
        202
    );
    check_invalid_paths(origin).await;
    for path in [
        "/plugins/not-installed/missing",
        "/plugins/http-peer/undeclared",
    ] {
        assert_eq!(
            client
                .get(format!("{origin}{path}"))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
    }
    assert_eq!(
        client
            .get(format!("{origin}/plugins/http-proxy/fail/now"))
            .send()
            .await
            .unwrap()
            .status(),
        502
    );
}

async fn check_invalid_paths(origin: &str) {
    for path in [
        "/../../account",
        "/%2e",
        "/.%2E/no",
        "/v1%2F..%2Fadmin",
        "/v1%5cadmin",
    ] {
        let mut socket = raw(origin, &format!("GET /plugins/http-proxy{path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")).await;
        assert_eq!(raw_status(&mut socket).await, 400, "{path}");
    }
}

async fn check_streams(backend: &Backend, origin: &str, route: &str) {
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = format!("http://{}/upstream", upstream.local_addr().unwrap());
    let (release, barrier) = oneshot::channel();
    let (upstream_ready, wait_for_upstream) = oneshot::channel();
    let upstream_server = tokio::spawn(mock_upstream(upstream, barrier, upstream_ready));
    let mut request_url = reqwest::Url::parse(route).unwrap();
    request_url.query_pairs_mut().append_pair("target", &target);
    let streaming_client = reqwest::Client::new();
    let request = || {
        streaming_client
            .get(request_url.clone())
            .header("x-key", "test-key")
            .header("host", "not-the-upstream.invalid")
            .header("connection", "x-hop")
            .header("x-hop", "strip-me")
            .header("content-length", "0")
    };
    let deadline = Duration::from_secs(10);
    let mut stream = timeout(deadline, request().send()).await.unwrap().unwrap();
    assert_eq!(stream.status(), 206);
    assert_eq!(stream.headers()["x-upstream"], "mock, second");
    assert!(!stream.headers().contains_key("set-cookie"));
    assert_eq!(
        timeout(deadline, stream.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        "first"
    );

    assert_eq!(
        streaming_client
            .get(format!("{origin}/plugins/http-peer/ready"))
            .timeout(deadline)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "ready"
    );
    check_normal_calls(backend).await;
    // The real delay exceeds the configured engine call budget (50 ms).
    // The action host has a separate wall deadline. Advance only the test
    // runtime's clock beyond that deadline; the child clock does not move.
    tokio::time::sleep(Duration::from_millis(100)).await;
    pause();
    advance(Duration::from_secs(3601)).await;
    resume();

    release.send(()).unwrap();
    assert_eq!(
        timeout(deadline, stream.text()).await.unwrap().unwrap(),
        "last"
    );

    check_disconnect(origin, &request_url, request(), wait_for_upstream).await;
    upstream_server.await.unwrap();
}

async fn check_normal_calls(backend: &Backend) {
    let mut session = backend.connect().await.unwrap();
    session.call(1, "http-peer/ops:normal", json!({})).unwrap();
    let Some(Event::Response { result, .. }) = timeout(Duration::from_secs(5), session.recv())
        .await
        .unwrap()
        .unwrap()
    else {
        panic!("normal action did not answer while HTTP action was streaming");
    };
    assert_eq!(result.unwrap(), "normal");

    session
        .call(2, "http-peer/ops:overBudget", json!({}))
        .unwrap();
    let Some(Event::Response { result, .. }) = timeout(Duration::from_secs(5), session.recv())
        .await
        .unwrap()
        .unwrap()
    else {
        panic!("over-budget query did not end");
    };
    assert!(format!("{:?}", result.unwrap_err()).contains("wall-clock budget"));
}

async fn check_disconnect(
    origin: &str,
    request_url: &reqwest::Url,
    request: reqwest::RequestBuilder,
    wait_for_upstream: oneshot::Receiver<()>,
) {
    let deadline = Duration::from_secs(10);
    let mut stream = timeout(deadline, request.send()).await.unwrap().unwrap();
    assert_eq!(
        timeout(deadline, stream.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        "first"
    );
    drop(stream);

    let mut peer = TcpStream::connect(origin.strip_prefix("http://").unwrap())
        .await
        .unwrap();
    peer.write_all(
        format!(
            "GET {}?{} HTTP/1.1\r\nHost: localhost\r\nX-Key: test-key\r\n\r\n",
            request_url.path(),
            request_url.query().unwrap()
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    // Make sure the upstream request is running before closing the caller.
    timeout(Duration::from_secs(5), wait_for_upstream)
        .await
        .unwrap()
        .unwrap();
    drop(peer);
}

async fn mock_upstream(
    upstream: TcpListener,
    barrier: oneshot::Receiver<()>,
    upstream_ready: oneshot::Sender<()>,
) {
    let (mut complete, headers) = read_upstream(&upstream).await;
    let headers = headers.to_ascii_lowercase();
    assert!(
        headers.contains(&format!("host: {}\r\n", upstream.local_addr().unwrap())),
        "{headers}"
    );
    assert!(headers.contains("x-key: test-key\r\n"));
    assert!(!headers.contains("x-hop:"));
    assert!(!headers.contains("not-the-upstream.invalid"));
    complete.write_all(b"HTTP/1.1 206 Partial Content\r\nTransfer-Encoding: chunked\r\nX-Upstream: mock\r\nX-Upstream: second\r\nSet-Cookie: a=b\r\n\r\n5\r\nfirst\r\n").await.unwrap();
    // A buffering implementation deadlocks at the caller's first read.
    barrier.await.unwrap();
    complete.write_all(b"4\r\nlast\r\n0\r\n\r\n").await.unwrap();
    drop(complete);

    let mut stalled = accept_upstream(&upstream).await;
    stalled
        .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nfirst\r\n")
        .await
        .unwrap();
    assert_closed(&mut stalled).await;

    // Disconnect before the route has returned even its response headers.
    let mut stalled = accept_upstream(&upstream).await;
    upstream_ready.send(()).unwrap();
    assert_closed(&mut stalled).await;
}

async fn accept_upstream(listener: &TcpListener) -> TcpStream {
    read_upstream(listener).await.0
}

async fn read_upstream(listener: &TcpListener) -> (TcpStream, String) {
    timeout(Duration::from_secs(10), async {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(socket.read_u8().await.unwrap());
        }
        (socket, String::from_utf8(request).unwrap())
    })
    .await
    .expect("expected a request from the HTTP action")
}

async fn assert_closed(upstream: &mut TcpStream) {
    assert_eq!(
        timeout(Duration::from_secs(5), upstream.read_u8())
            .await
            .unwrap()
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::UnexpectedEof,
    );
}

async fn raw(origin: &str, request: &str) -> TcpStream {
    let mut peer = TcpStream::connect(origin.strip_prefix("http://").unwrap())
        .await
        .unwrap();
    peer.write_all(request.as_bytes()).await.unwrap();
    peer
}

async fn raw_status(peer: &mut TcpStream) -> u16 {
    timeout(Duration::from_secs(3), async {
        let mut line = Vec::new();
        while !line.ends_with(b"\r\n") {
            line.push(peer.read_u8().await.unwrap());
        }
        String::from_utf8(line)
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap()
    })
    .await
    .unwrap()
}

async fn check_uploads(origin: &str, route: &str) {
    let base = "POST /plugins/http-proxy/size HTTP/1.1\r\nHost: localhost\r\n";
    let mut huge = raw(origin, &format!("{base}Content-Length: 1073741824\r\n\r\n")).await;
    assert_eq!(raw_status(&mut huge).await, 413);
    let mut partial_headers = raw(origin, base).await;
    let mut slow = Vec::new();
    for _ in 0..70 {
        slow.push(raw(origin, &format!("{base}Content-Length: 10\r\n\r\n")).await);
    }
    let client = reqwest::Client::new();
    assert_eq!(client.get(route).send().await.unwrap().status(), 401);
    let response = client
        .post(format!("{origin}/plugins/http-proxy/size"))
        .header("x-key", "test-key")
        .body(vec![b'a'; 32 * 1024 * 1024])
        .send()
        .await
        .unwrap();
    assert_eq!(response.json::<usize>().await.unwrap(), 32 * 1024 * 1024);
    pause();
    advance(Duration::from_secs(11)).await;
    resume();
    assert_closed(&mut partial_headers).await;
    pause();
    advance(Duration::from_secs(20)).await;
    resume();
    assert_eq!(raw_status(&mut slow[0]).await, 408);
}

async fn check_slot_wait(origin: &str) {
    let cap = std::env::var("TOKAMAK_HTTP_PLUGIN_SLOTS").map_or(32, |value| value.parse().unwrap());
    let global =
        std::env::var("TOKAMAK_HTTP_TOTAL_SLOTS").map_or(96, |value| value.parse().unwrap());
    let client = reqwest::Client::new();
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = format!("http://{}/hold", upstream.local_addr().unwrap());
    let held = with_query(
        &format!("{origin}/plugins/http-proxy/stream/hold"),
        "target",
        &target,
    );
    let mut streams = Vec::new();
    let mut sockets = Vec::new();
    for _ in 0..cap.min(global) {
        let send = client.get(held.clone()).header("x-key", "test-key").send();
        let (reply, socket) = tokio::join!(send, async {
            let mut socket = accept_upstream(&upstream).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n")
                .await
                .unwrap();
            socket
        });
        streams.push(reply.unwrap());
        sockets.push(socket);
    }
    let probe = format!("{origin}/plugins/http-proxy/short/probe");
    let start = std::time::Instant::now();
    let busy = client.get(&probe).send().await.unwrap();
    assert_eq!(busy.status(), 503);
    assert_eq!(busy.headers()["retry-after"], "1");
    assert!(start.elapsed() >= Duration::from_millis(200));

    let (reply, ()) = tokio::join!(client.get(&probe).send(), async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        sockets
            .pop()
            .unwrap()
            .write_all(b"0\r\n\r\n")
            .await
            .unwrap();
        assert_eq!(streams.pop().unwrap().text().await.unwrap(), "a");
    });
    assert_eq!(reply.unwrap().status(), 401);
    for (mut socket, stream) in sockets.into_iter().zip(streams) {
        socket.write_all(b"0\r\n\r\n").await.unwrap();
        assert_eq!(stream.text().await.unwrap(), "a");
    }
}

async fn check_response_failures(origin: &str) {
    let client = reqwest::Client::new();
    let base = format!("{origin}/plugins/http-proxy");
    assert_eq!(
        client
            .get(format!("{base}/informational"))
            .send()
            .await
            .unwrap()
            .status(),
        502
    );
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gate = format!("http://{}/gate", upstream.local_addr().unwrap());
    let mut response = client
        .get(with_query(&format!("{base}/broken"), "gate", &gate))
        .send()
        .await
        .unwrap();
    assert_eq!(response.chunk().await.unwrap().unwrap(), "first");
    let mut gate = accept_upstream(&upstream).await;
    gate.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
        .await
        .unwrap();
    assert!(response.chunk().await.is_err());

    let mut peer = raw(
        origin,
        "GET /plugins/http-proxy/hang HTTP/1.1\r\nHost: localhost\r\n\r\n",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(75)).await;
    let first_headers = std::env::var("TOKAMAK_HTTP_FIRST_HEADERS_MS")
        .map_or(300_000, |value| value.parse().unwrap());
    pause();
    advance(Duration::from_millis(first_headers + 1)).await;
    resume();
    assert_eq!(raw_status(&mut peer).await, 504);
}

fn with_query(url: &str, key: &str, value: &str) -> reqwest::Url {
    let mut url = reqwest::Url::parse(url).unwrap();
    url.query_pairs_mut().append_pair(key, value);
    url
}

async fn check_abort_grace(origin: &str, route: &str) {
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let marker = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut url = with_query(
        route,
        "target",
        &format!("http://{}/wait", upstream.local_addr().unwrap()),
    );
    url.query_pairs_mut().append_pair(
        "marker",
        &format!("http://{}/cleanup", marker.local_addr().unwrap()),
    );
    let request = |url: &reqwest::Url| {
        format!(
            "GET {}?{} HTTP/1.1\r\nHost: localhost\r\nX-Key: test-key\r\n\r\n",
            url.path(),
            url.query().unwrap()
        )
    };
    let peer = raw(origin, &request(&url)).await;
    let mut held = accept_upstream(&upstream).await;
    drop(peer);
    let mut cleanup = timeout(Duration::from_secs(3), accept_upstream(&marker))
        .await
        .expect("handler finally did not observe the abort");
    cleanup
        .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
        .await
        .unwrap();
    assert_closed(&mut held).await;

    url.query_pairs_mut().append_pair("ignore", "1");
    let peer = raw(origin, &request(&url)).await;
    let mut held = accept_upstream(&upstream).await;
    let start = std::time::Instant::now();
    drop(peer);
    assert_closed(&mut held).await;
    assert!(start.elapsed() >= Duration::from_millis(400));
    // The child's orphan cleanup alone waits two seconds.
    assert!(start.elapsed() < Duration::from_millis(1800));
}
