use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};
use tokamak_worker::runner::Runner;
use tokio::{io::AsyncBufReadExt, net::TcpStream, process::Command, time::timeout};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Error, Message, client::IntoClientRequest},
};

const BINARY: &str = env!("CARGO_BIN_EXE_tokamak-runner");
const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DEADLINE: Duration = Duration::from_secs(15);
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn fixture() -> &'static Path {
    static INHERITED: OnceLock<Option<PathBuf>> = OnceLock::new();
    if let Some(path) =
        INHERITED.get_or_init(|| std::env::var_os("TOKAMAK_TEST_FIXTURE").map(PathBuf::from))
    {
        return path;
    }
    static BUILT: OnceLock<tempfile::TempDir> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture");
            let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            let target = repo.join("target");
            std::fs::create_dir_all(&target).unwrap();
            let directory = tempfile::tempdir_in(target).unwrap();
            std::fs::create_dir_all(directory.path().join("src/server")).unwrap();
            for file in [
                "package.json",
                "plugin.ts",
                "src/server/work.ts",
                "src/server/workspace.ts",
            ] {
                std::fs::copy(source.join(file), directory.path().join(file)).unwrap();
            }
            #[cfg(unix)]
            std::os::unix::fs::symlink(
                repo.join("app/node_modules"),
                directory.path().join("node_modules"),
            )
            .unwrap();
            #[cfg(windows)]
            std::os::windows::fs::symlink_dir(
                repo.join("app/node_modules"),
                directory.path().join("node_modules"),
            )
            .unwrap();
            let output = std::process::Command::new("bun")
                .arg(repo.join("packages/build/src/build.ts"))
                .arg(directory.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            directory
        })
        .path()
}

async fn socket(address: &str, token: Option<&str>) -> Result<Socket, Error> {
    socket_from(address, token, "tauri://localhost").await
}

async fn socket_from(address: &str, token: Option<&str>, origin: &str) -> Result<Socket, Error> {
    let mut request = address.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", origin.parse().unwrap());
    if let Some(token) = token {
        request.headers_mut().insert(
            "sec-websocket-protocol",
            format!("tokamak, tokamak.bearer.{token}").parse().unwrap(),
        );
    }
    timeout(DEADLINE, connect_async(request))
        .await
        .unwrap()
        .map(|(socket, _)| socket)
}

async fn send(socket: &mut Socket, frame: Value) {
    timeout(
        DEADLINE,
        socket.send(Message::Text(frame.to_string().into())),
    )
    .await
    .unwrap()
    .unwrap();
}

async fn read(socket: &mut Socket) -> Value {
    let frame = timeout(DEADLINE, socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(frame.to_text().unwrap()).unwrap()
}

fn worker_address(ws: &str) -> String {
    format!("{}/local-worker", ws.strip_suffix("/ws").unwrap())
}

async fn open_worker(ws: &str, token: &str) -> Socket {
    open_worker_for(ws, token, "runner-fixture").await
}

async fn open_worker_for(ws: &str, token: &str, plugin: &str) -> Socket {
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(fixture().join("dist/manifest.json")).unwrap())
            .unwrap();
    let mut socket = socket(&worker_address(ws), Some(token)).await.unwrap();
    send(
        &mut socket,
        json!({"type":"start","artifact":{
            "id":plugin,
            "entryHash":manifest["hashes"]["local-entry.js"],
            "codeHash":manifest["hashes"]["local.js"],
        }}),
    )
    .await;
    assert_eq!(read(&mut socket).await["type"], "started");
    socket
}

async fn invoke(client: &mut Socket, worker: &mut Socket, name: &str, path: &Path) {
    send(worker, json!({"type":"write","message":{"type":"invoke","id":1,"fn":format!("work:{name}"),"args":{"path":path}}})).await;
    let request = read(worker).await;
    assert_eq!(request["message"]["name"], "auth.current", "{request}");
    send(
        client,
        json!({"type":"query","id":2,"name":"auth:caller","args":{}}),
    )
    .await;
    let caller = read(client).await;
    let auth = caller["result"]["Ok"].as_object().expect("caller identity");
    send(worker, json!({"type":"write","message":{"type":"opResult","id":request["message"]["id"],"value":auth}})).await;
}

async fn action(socket: &mut Socket) {
    send(
        socket,
        json!({"type":"action","id":1,"name":"runner-fixture/workspace:ready","args":{}}),
    )
    .await;
    assert_eq!(
        read(socket).await,
        json!({"type":"response","id":1,"result":{"Ok":"workspace ready"}})
    );
}

#[tokio::test]
async fn desktop_runner_starts_one_workspace_and_closes_it_on_shutdown() {
    let temporary = tempfile::tempdir().unwrap();
    let runner = Runner::start(BINARY.into(), temporary.path().into(), fixture().into());
    let endpoint = timeout(DEADLINE, runner.endpoint()).await.unwrap().unwrap();
    let same = runner.endpoint().await.unwrap();
    assert_eq!(endpoint.ws, same.ws);
    assert_eq!(endpoint.token, same.token);
    let mut client = socket(&endpoint.ws, Some(&endpoint.token)).await.unwrap();
    action(&mut client).await;
    timeout(DEADLINE, runner.shutdown()).await.unwrap();
    assert!(socket(&endpoint.ws, Some(&endpoint.token)).await.is_err());
    assert!(runner.endpoint().await.is_err());
}

#[tokio::test]
async fn workspace_and_local_worker_refuse_missing_or_wrong_secret() {
    let temporary = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(temporary.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let install = tempfile::tempdir().unwrap();
    let manifest = copy_fixture(install.path());
    let runner = Runner::start(
        BINARY.into(),
        temporary.path().into(),
        install.path().into(),
    );
    let endpoint = timeout(DEADLINE, runner.endpoint()).await.unwrap().unwrap();
    for address in [&endpoint.ws, &worker_address(&endpoint.ws)] {
        for token in [None, Some(SECRET)] {
            let result = socket(address, token).await;
            assert!(matches!(result, Err(Error::Http(response)) if response.status() == 401));
        }
        assert!(socket(address, Some(&endpoint.token)).await.is_ok());
    }
    let worker = worker_address(&endpoint.ws);
    let foreign = socket_from(&worker, Some(&endpoint.token), "https://other.invalid").await;
    assert!(matches!(foreign, Err(Error::Http(response)) if response.status() == 403));

    let control_file = temporary.path().join("runner.control");
    let discovery_file = temporary.path().join("runner.json");
    let control = std::fs::read_to_string(&control_file).unwrap();
    assert_ne!(control, endpoint.token);
    let discovery: Value =
        serde_json::from_slice(&std::fs::read(&discovery_file).unwrap()).unwrap();
    assert_eq!(discovery["url"], endpoint.ws);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            temporary.path().metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
        for path in [&control_file, &discovery_file] {
            assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    assert_http_authorization(&endpoint, &control).await;
    reload_fixture(&endpoint, &control, &manifest).await;
    for address in [&endpoint.ws, &worker] {
        assert!(
            matches!(socket(address, Some(&control)).await, Err(Error::Http(response)) if response.status() == 401)
        );
    }
    // Use the application credential after control reload: the new catalog
    // still supports running the action.
    action(&mut socket(&endpoint.ws, Some(&endpoint.token)).await.unwrap()).await;
    runner.shutdown().await;
    assert!(!control_file.exists());
    assert!(!discovery_file.exists());
}

async fn assert_http_authorization(endpoint: &tokamak_worker::runner::Endpoint, control: &str) {
    let routes = [
        ("GET", "/health"),
        ("GET", "/account"),
        ("POST", "/account"),
        ("GET", "/plugins"),
        ("GET", "/plugins/runner-fixture/revision/assets/index.js"),
        ("POST", "/shutdown"),
        ("POST", "/plugins/runner-fixture/reload"),
    ];
    for (method, path) in routes {
        for token in [None, Some(SECRET)] {
            assert_eq!(
                request(endpoint, method, path, token).await.status(),
                401,
                "{method} {path}"
            );
        }
        if !matches!(path, "/plugins" | "/plugins/runner-fixture/reload") {
            assert_eq!(
                request(endpoint, method, path, Some(control))
                    .await
                    .status(),
                401,
                "{method} {path}"
            );
        }
    }
    for (method, path) in [
        ("HEAD", "/plugins"),
        ("GET", "/plugins/runner-fixture/reload"),
    ] {
        assert_eq!(
            request(endpoint, method, path, Some(control))
                .await
                .status(),
            401,
            "{method} {path}"
        );
    }
}

fn copy_fixture(install: &Path) -> PathBuf {
    let dist = install.join("dist");
    std::fs::create_dir(&dist).unwrap();
    for item in std::fs::read_dir(fixture().join("dist")).unwrap() {
        let item = item.unwrap();
        if item.file_type().unwrap().is_file() {
            std::fs::copy(item.path(), dist.join(item.file_name())).unwrap();
        }
    }
    dist.join("manifest.json")
}

async fn reload_fixture(
    endpoint: &tokamak_worker::runner::Endpoint,
    control: &str,
    manifest: &Path,
) {
    let list = request(endpoint, "GET", "/plugins", Some(control)).await;
    assert_eq!(list.status(), 200);
    let before = list.json::<Value>().await.unwrap();
    assert_eq!(before["plugins"][0]["plugin"]["id"], "runner-fixture");
    let mut next: Value = serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
    next["plugin"]["version"] = json!("1.0.1");
    std::fs::write(manifest, next.to_string()).unwrap();
    let reload = request(
        endpoint,
        "POST",
        "/plugins/runner-fixture/reload",
        Some(control),
    )
    .await;
    assert_eq!(reload.status(), 200);
    let output = reload.json::<Value>().await.unwrap();
    assert_eq!(output["plugins"][0]["plugin"]["version"], "1.0.1");
    assert_ne!(output["revision"], before["revision"]);
}

async fn request(
    endpoint: &tokamak_worker::runner::Endpoint,
    method: &str,
    path: &str,
    token: Option<&str>,
) -> reqwest::Response {
    let client = server::local_endpoint::client(DEADLINE).unwrap();
    let request = client.request(method.parse().unwrap(), format!("{}{path}", endpoint.http));
    let request = if let Some(token) = token {
        request.bearer_auth(token)
    } else {
        request
    };
    request.send().await.unwrap()
}

#[tokio::test]
async fn store_conflict_names_the_owner_and_does_not_retry_after_release() {
    let temp = tempfile::tempdir().unwrap();
    let first = Runner::start(BINARY.into(), temp.path().into(), fixture().into());
    let endpoint = timeout(DEADLINE, first.endpoint()).await.unwrap().unwrap();
    let expected_pid = request(&endpoint, "GET", "/health", Some(&endpoint.token))
        .await
        .json::<Value>()
        .await
        .unwrap()["pid"]
        .as_u64()
        .unwrap();
    let second = Runner::start(BINARY.into(), temp.path().into(), fixture().into());
    let error = timeout(DEADLINE, second.endpoint())
        .await
        .unwrap()
        .err()
        .unwrap();
    assert!(
        error.contains(&format!(
            "Store is in use by tokamak-runner (PID {expected_pid})"
        )),
        "{error}"
    );
    first.shutdown().await;
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(
        second.endpoint().await.err().as_deref(),
        Some(error.as_str())
    );
    second.shutdown().await;
    let replacement = Runner::start(BINARY.into(), temp.path().into(), fixture().into());
    let replacement_endpoint = timeout(DEADLINE, replacement.endpoint())
        .await
        .unwrap()
        .unwrap();
    assert_ne!(replacement_endpoint.token, endpoint.token);
    replacement.shutdown().await;
}

#[tokio::test]
async fn replaces_an_authenticated_legacy_desktop_server_holding_the_store() {
    use axum::{
        Router,
        http::{HeaderMap, StatusCode},
        routing::{get, post},
    };
    use std::fs::OpenOptions;
    use tokio_util::sync::CancellationToken;

    let temp = tempfile::tempdir().unwrap();
    let lock = OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(temp.path().join("server-owner.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    let token = temp.path().join("server.token");
    std::fs::write(&token, SECRET).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = json!({
        "pid": std::process::id(),
        "url": format!("ws://{}/ws", listener.local_addr().unwrap()),
        "buildId": SECRET,
        "bundleHash": SECRET,
    });
    let ready = temp.path().join("server.json");
    std::fs::write(&ready, identity.to_string()).unwrap();
    let stopped = CancellationToken::new();
    let shutdown = stopped.clone();
    let legacy = tokio::spawn(async move {
        let authorized = |headers: &HeaderMap| {
            headers
                .get("authorization")
                .is_some_and(|value| value == format!("Bearer {SECRET}").as_str())
        };
        let app = Router::new()
            .route(
                "/health",
                get(move |headers: HeaderMap| async move {
                    if authorized(&headers) {
                        Ok(identity.to_string())
                    } else {
                        Err(StatusCode::UNAUTHORIZED)
                    }
                }),
            )
            .route(
                "/shutdown",
                post(move |headers: HeaderMap| async move {
                    if !authorized(&headers) {
                        return StatusCode::UNAUTHORIZED;
                    }
                    shutdown.cancel();
                    StatusCode::NO_CONTENT
                }),
            );
        axum::serve(listener, app)
            .with_graceful_shutdown(stopped.cancelled_owned())
            .await
            .unwrap();
        std::fs::remove_file(ready).unwrap();
        drop(lock);
    });
    let runner = Runner::start(BINARY.into(), temp.path().into(), fixture().into());
    let endpoint = timeout(DEADLINE, runner.endpoint()).await.unwrap().unwrap();
    assert!(!temp.path().join("server.json").exists());
    legacy.await.unwrap();
    action(&mut socket(&endpoint.ws, Some(&endpoint.token)).await.unwrap()).await;
    runner.shutdown().await;
}

#[tokio::test]
async fn a_runner_started_by_hand_leaves_the_server_that_holds_the_store_running() {
    let temp = tempfile::tempdir().unwrap();
    let lock = std::fs::OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(temp.path().join("server-owner.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    // No server listens here: taking the store over would need a request.
    let descriptor = json!({
        "pid": std::process::id(),
        "url": "ws://127.0.0.1:9/ws",
        "buildId": SECRET,
        "bundleHash": SECRET,
    });
    std::fs::write(temp.path().join("server.json"), descriptor.to_string()).unwrap();
    let secret = temp.path().join("secret");
    std::fs::write(&secret, SECRET).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    let output = Command::new(BINARY)
        .args(["--plugins"])
        .arg(fixture())
        .args(["--data"])
        .arg(temp.path().join("store"))
        .args(["--token-file"])
        .arg(secret)
        .args(["--listen", "127.0.0.1:0"])
        .kill_on_drop(true)
        .output();
    let output = timeout(DEADLINE, output).await.unwrap().unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains(&format!(
            "Store is in use by tokamak-server (PID {})",
            std::process::id()
        )),
        "{error}"
    );
    assert!(temp.path().join("server.json").exists());
    drop(lock);
}

#[tokio::test]
async fn standalone_runner_serves_a_workspace_and_runs_a_local_function() {
    use tokio::io::AsyncWriteExt;

    for runtime in ["quickjs", "bun"] {
        if runtime == "quickjs" && !cfg!(any(target_os = "macos", target_os = "linux")) {
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("local");
        std::fs::write(&path, "read on the Runner's machine").unwrap();
        let secret = dir.path().join("secret");
        let mut file = tokio::fs::OpenOptions::new();
        file.create_new(true).write(true);
        #[cfg(unix)]
        file.mode(0o600);
        file.open(&secret)
            .await
            .unwrap()
            .write_all(SECRET.as_bytes())
            .await
            .unwrap();

        let mut child = Command::new(BINARY)
            .args(["--plugins"])
            .arg(fixture())
            .args(["--data"])
            .arg(dir.path().join("store"))
            .args(["--token-file"])
            .arg(secret)
            .args(["--listen", "127.0.0.1:0"])
            .env("TOKAMAK_PLUGIN_RUNTIME", runtime)
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut output = tokio::io::BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        timeout(DEADLINE, output.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        let address = line.trim().strip_prefix("Tokamak listening on ").unwrap();
        let mut server = socket(address, Some(SECRET)).await.unwrap();
        action(&mut server).await;
        let mut worker = open_worker(address, SECRET).await;
        invoke(&mut server, &mut worker, "read", &path).await;
        let frame = read(&mut worker).await;
        assert_eq!(
            frame["message"]["value"], "read on the Runner's machine",
            "{runtime}: {frame}"
        );
        send(&mut worker, json!({"type":"close"})).await;
        assert_eq!(read(&mut worker).await["type"], "closed");
        #[cfg(unix)]
        signal(child.id().unwrap(), libc::SIGTERM);
        #[cfg(not(unix))]
        child.start_kill().unwrap();
        let exit = timeout(DEADLINE, child.wait()).await.unwrap().unwrap();
        #[cfg(unix)]
        assert!(exit.success());
        #[cfg(not(unix))]
        let _ = exit;
        println!("standalone {runtime}: workspace action and local file read passed");
    }
}

#[cfg(unix)]
fn signal(pid: u32, signal: libc::c_int) {
    // SAFETY: The signal is sent only to the live child started by the test.
    assert_eq!(unsafe { libc::kill(pid.try_into().unwrap(), signal) }, 0);
}

#[cfg(unix)]
async fn runner_pid(endpoint: &tokamak_worker::runner::Endpoint) -> u32 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let address = endpoint.http.strip_prefix("http://").unwrap();
    let mut socket = TcpStream::connect(address).await.unwrap();
    socket.write_all(format!(
        "GET /health HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
        endpoint.token
    ).as_bytes()).await.unwrap();
    let mut response = String::new();
    timeout(DEADLINE, socket.read_to_string(&mut response))
        .await
        .unwrap()
        .unwrap();
    let value: Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
    value["pid"].as_u64().unwrap().try_into().unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn a_killed_runner_disconnects_and_is_restarted_with_a_new_secret() {
    let temp = tempfile::tempdir().unwrap();
    let runner = Runner::start(BINARY.into(), temp.path().into(), fixture().into());
    let first = timeout(DEADLINE, runner.endpoint()).await.unwrap().unwrap();
    let mut client = socket(&first.ws, Some(&first.token)).await.unwrap();
    let pid = runner_pid(&first).await;
    let first_control = std::fs::read_to_string(temp.path().join("runner.control")).unwrap();
    signal(pid, libc::SIGKILL);
    let closed = timeout(DEADLINE, client.next()).await.unwrap();
    assert!(!matches!(closed, Some(Ok(Message::Text(_)))));
    // Wait for the supervisor to observe the exit, before the replacement can be ready.
    timeout(DEADLINE, async {
        loop {
            if runner.endpoint().await.is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let again = timeout(DEADLINE, async {
        loop {
            if let Ok(endpoint) = runner.endpoint().await
                && endpoint.token != first.token
            {
                break endpoint;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_ne!(runner_pid(&again).await, pid);
    assert_ne!(
        std::fs::read_to_string(temp.path().join("runner.control")).unwrap(),
        first_control
    );
    let mut client = socket(&again.ws, Some(&again.token)).await.unwrap();
    action(&mut client).await;
    runner.shutdown().await;
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tokio::test]
async fn force_killing_the_supervisor_leaves_no_runner_plugin_or_program() {
    let parent_directory = std::env::var_os("TOKAMAK_TEST_SUPERVISOR");
    if let Some(directory) = parent_directory {
        // This subprocess uses the actual desktop supervisor and publishes
        // readiness only once the server, workers and program are live.
        supervise_child(PathBuf::from(directory)).await;
        return;
    }
    for runtime in ["quickjs", "bun"] {
        assert_no_orphans(runtime).await;
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn assert_no_orphans(runtime: &str) {
    let temp = tempfile::tempdir().unwrap();
    let mut parent = Command::new(std::env::current_exe().unwrap())
        .args([
            "--nocapture",
            "--exact",
            "force_killing_the_supervisor_leaves_no_runner_plugin_or_program",
        ])
        .env("TOKAMAK_TEST_SUPERVISOR", temp.path())
        .env("TOKAMAK_TEST_FIXTURE", fixture())
        .env("TOKAMAK_PLUGIN_RUNTIME", runtime)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let ready = temp.path().join("ready");
    let pids: Vec<u32> = tokio::select! {
        content = wait_for_file(&ready) => serde_json::from_str(&content).unwrap(),
        status = parent.wait() => panic!("Supervisor exited before its process tree was ready: {status:?}"),
    };
    for &pid in &pids {
        assert!(
            alive(pid),
            "Expected {pid} to be running before killing the supervisor"
        );
    }
    parent.kill().await.unwrap();
    assert_no_running_pids(pids).await;
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn assert_no_running_pids(pids: Vec<u32>) {
    timeout(DEADLINE, async {
        while pids.iter().any(|&pid| alive(pid)) {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "orphans: {:?}",
            pids.into_iter()
                .filter(|&pid| alive(pid))
                .collect::<Vec<_>>()
        )
    });
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn supervise_child(directory: PathBuf) {
    let plugins = copy_process_fixtures(&directory);
    let runner = Runner::start(BINARY.into(), directory.clone(), plugins);
    let (pids, _sockets) = process_tree(&runner, &directory).await;
    std::fs::write(directory.join("writing"), json!(pids).to_string()).unwrap();
    std::fs::rename(directory.join("writing"), directory.join("ready")).unwrap();
    std::future::pending::<()>().await;
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tokio::test]
async fn graceful_quit_reaps_the_workspace_action_local_plugin_and_program() {
    let temp = tempfile::tempdir().unwrap();
    let plugins = copy_process_fixtures(temp.path());
    let runner = Runner::start(BINARY.into(), temp.path().into(), plugins);
    let (pids, _sockets) = process_tree(&runner, temp.path()).await;
    assert!(pids.iter().copied().all(alive), "{pids:?}");
    timeout(DEADLINE, runner.shutdown()).await.unwrap();
    assert_no_running_pids(pids).await;
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn copy_process_fixtures(directory: &Path) -> PathBuf {
    let plugins = directory.join("plugins");
    for id in ["runner-fixture", "runner-other"] {
        let folder = plugins.join(id);
        std::fs::create_dir_all(&folder).unwrap();
        let manifest = copy_fixture(&folder);
        if id != "runner-fixture" {
            let mut value: Value =
                serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
            value["plugin"]["id"] = json!(id);
            std::fs::write(manifest, value.to_string()).unwrap();
        }
    }
    plugins
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn process_tree(runner: &Runner, directory: &Path) -> (Vec<u32>, Vec<Socket>) {
    let endpoint = timeout(DEADLINE, runner.endpoint()).await.unwrap().unwrap();
    let pid = runner_pid(&endpoint).await;
    let mut client = socket(&endpoint.ws, Some(&endpoint.token)).await.unwrap();
    action(&mut client).await;
    let before_local = child_commands(pid);
    let mut worker = open_worker(&endpoint.ws, &endpoint.token).await;
    let program = directory.join("program");
    invoke(&mut client, &mut worker, "stay", &program).await;
    let program: u32 = wait_for_file(&program).await.trim().parse().unwrap();
    let mut other = open_worker_for(&endpoint.ws, &endpoint.token, "runner-other").await;
    let other_program = directory.join("other-program");
    invoke(&mut client, &mut other, "stay", &other_program).await;
    let other_program: u32 = wait_for_file(&other_program).await.trim().parse().unwrap();

    let children = child_commands(pid);
    let host = |line: &str| {
        line.split_whitespace()
            .any(|part| part.ends_with("/tokamak-plugin-host"))
    };
    let quickjs =
        tokamak_worker::LocalRuntime::selected().unwrap() == tokamak_worker::LocalRuntime::QuickJs;
    let action = before_local
        .iter()
        .find(|(_, cmd)| {
            if quickjs {
                host(cmd) && cmd.ends_with(" --actions")
            } else {
                cmd.ends_with(".mjs")
            }
        })
        .unwrap()
        .0;
    let local: Vec<_> = children
        .iter()
        .filter(|(pid, cmd)| {
            if quickjs {
                host(cmd) && cmd.ends_with(".mjs")
            } else {
                cmd.ends_with(".mjs") && !before_local.iter().any(|(before, _)| before == pid)
            }
        })
        .map(|(pid, _)| *pid)
        .collect();
    assert_eq!(local.len(), 2, "{children:?}");
    let mut pids = vec![pid, action, program, other_program];
    pids.extend(local);
    (pids, vec![client, worker, other])
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn child_commands(pid: u32) -> Vec<(u32, String)> {
    let processes = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
        .unwrap();
    let processes = String::from_utf8(processes.stdout).unwrap();
    processes
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let child = fields.next()?.parse::<u32>().ok()?;
            (fields.next()?.parse::<u32>().ok()? == pid).then_some((child, line.to_owned()))
        })
        .collect()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn wait_for_file(path: &Path) -> String {
    timeout(DEADLINE, async {
        loop {
            if let Ok(value) = tokio::fs::read_to_string(path).await
                && !value.trim().is_empty()
            {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("Waited for {}", path.display()))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn alive(pid: u32) -> bool {
    let output = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8(output.stdout).unwrap();
    let state = state.trim();
    !state.is_empty() && !state.starts_with('Z')
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn plain_contracts_route_between_persistent_plugin_processes() {
    routing_test("local-routing.mjs");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn production_agent_info_uses_dedicated_hosts_and_reuses_live_imports() {
    routing_test("agent-routing.mjs");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn routing_test(name: &str) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join(name);
    let output = std::process::Command::new("proto")
        .args(["run", "bun", "--"])
        .arg(script)
        .arg(BINARY)
        .output()
        .expect("run the QuickJS routing integration test");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr),
    );
    print!("{stdout}");
}
