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
    let mut request = address.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", "tauri://localhost".parse().unwrap());
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
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(fixture().join("dist/manifest.json")).unwrap())
            .unwrap();
    let mut socket = socket(&worker_address(ws), Some(token)).await.unwrap();
    send(
        &mut socket,
        json!({"type":"start","artifact":{
            "id":"runner-fixture",
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
    let runner = Runner::start(BINARY.into(), temporary.path().into(), fixture().into());
    let endpoint = timeout(DEADLINE, runner.endpoint()).await.unwrap().unwrap();
    for address in [&endpoint.ws, &worker_address(&endpoint.ws)] {
        for token in [None, Some(SECRET)] {
            let result = socket(address, token).await;
            assert!(matches!(result, Err(Error::Http(response)) if response.status() == 401));
        }
        assert!(socket(address, Some(&endpoint.token)).await.is_ok());
    }
    runner.shutdown().await;
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
    signal(pid, libc::SIGKILL);
    let closed = timeout(DEADLINE, client.next()).await.unwrap();
    assert!(!matches!(closed, Some(Ok(Message::Text(_)))));
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
    let temp = tempfile::tempdir().unwrap();
    let mut parent = Command::new(std::env::current_exe().unwrap())
        .args([
            "--nocapture",
            "--exact",
            "force_killing_the_supervisor_leaves_no_runner_plugin_or_program",
        ])
        .env("TOKAMAK_TEST_SUPERVISOR", temp.path())
        .env("TOKAMAK_TEST_FIXTURE", fixture())
        .env_remove("TOKAMAK_PLUGIN_RUNTIME")
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
    let plugin = PathBuf::from(std::env::var_os("TOKAMAK_TEST_FIXTURE").unwrap());
    let runner = Runner::start(BINARY.into(), directory.clone(), plugin);
    let endpoint = timeout(DEADLINE, runner.endpoint()).await.unwrap().unwrap();
    let pid = runner_pid(&endpoint).await;
    let mut client = socket(&endpoint.ws, Some(&endpoint.token)).await.unwrap();
    action(&mut client).await;
    let mut worker = open_worker(&endpoint.ws, &endpoint.token).await;
    let program = directory.join("program");
    invoke(&mut client, &mut worker, "stay", &program).await;
    let program: u32 = wait_for_file(&program).await.trim().parse().unwrap();

    let processes = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
        .unwrap();
    let processes = String::from_utf8(processes.stdout).unwrap();
    let children: Vec<_> = processes
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let child = fields.next()?.parse::<u32>().ok()?;
            (fields.next()?.parse::<u32>().ok()? == pid).then_some((child, line))
        })
        .collect();
    let host = |line: &str| {
        line.split_whitespace()
            .any(|part| part.ends_with("/tokamak-plugin-host"))
    };
    let action = children
        .iter()
        .find(|(_, cmd)| host(cmd) && cmd.ends_with(" --actions"))
        .unwrap()
        .0;
    let local = children
        .iter()
        .find(|(_, cmd)| host(cmd) && cmd.ends_with(".mjs"))
        .unwrap()
        .0;
    std::fs::write(
        directory.join("writing"),
        json!([pid, action, local, program]).to_string(),
    )
    .unwrap();
    std::fs::rename(directory.join("writing"), directory.join("ready")).unwrap();
    std::future::pending::<()>().await;
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
