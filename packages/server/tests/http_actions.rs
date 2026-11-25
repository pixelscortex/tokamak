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
    let backend = Backend::start_plugins(Storage::Memory, PoolConfig::default(), fixture.path())
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (stop, shutdown) = oneshot::channel();
    let server = tokio::spawn(serve(listener, &backend, shutdown));
    let route = format!("{origin}/plugins/http-proxy/ACME/v1/messages");
    check_routing(&origin, &route).await;
    check_streams(&backend, &origin, &route).await;
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
    let url = format!("{route}?q=one&q=two");
    let response = client
        .patch(&url)
        .header("x-key", "test-key")
        .body("request bytes")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    assert_eq!(response.headers()["x-fixture"], "proxy");
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({
            "serverUrl": origin, "path": "/ACME/v1/messages", "params": { "profile": "ACME", "*": "v1/messages" },
            "url": url, "method": "PATCH", "body": "request bytes",
        })
    );
    assert_eq!(client.get(route).send().await.unwrap().status(), 401);
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
    };
    let deadline = Duration::from_secs(10);
    let mut stream = timeout(deadline, request().send()).await.unwrap().unwrap();
    assert_eq!(stream.status(), 206);
    assert_eq!(stream.headers()["x-upstream"], "mock");
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
    // Move the server's clock beyond the normal one-hour action deadline
    // while the upstream is still waiting. The HTTP path has no such timer.
    pause();
    advance(Duration::from_secs(3601)).await;
    resume();

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
    release.send(()).unwrap();
    assert_eq!(
        timeout(deadline, stream.text()).await.unwrap().unwrap(),
        "last"
    );

    check_disconnect(origin, &request_url, request(), wait_for_upstream).await;
    upstream_server.await.unwrap();
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
    let mut complete = accept_upstream(&upstream).await;
    complete.write_all(b"HTTP/1.1 206 Partial Content\r\nTransfer-Encoding: chunked\r\nX-Upstream: mock\r\n\r\n5\r\nfirst\r\n").await.unwrap();
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
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut request = Vec::new();
    while !request.ends_with(b"\r\n\r\n") {
        request.push(socket.read_u8().await.unwrap());
    }
    socket
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
