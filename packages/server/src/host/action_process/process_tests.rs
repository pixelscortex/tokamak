//! Exercise the supervisor through the action pipe protocol.

use std::os::unix::fs::PermissionsExt;

use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    net::{TcpListener, TcpStream},
    time::timeout,
};

use super::*;

const PEER: &str = r#"#!/bin/sh
field() { value=${line#*\"$1\":}; printf "%s" "${value%%[!0-9]*}"; }
while IFS= read -r line; do
    case "$line" in
        *'"type":"ping"'*)
            printf '{"type":"pong","id":%s}\n' "$(field id)" ;;
        *'"fn":"sign-in"'*'"network":false'*)
            printf '{"type":"op","id":%s,"slot":%s,"call":%s,"name":"sign-in","payload":null}\n' "$(field id)" "$(field slot)" "$(field id)" ;;
        *'"fn":"echo"'*)
            printf '{"type":"result","id":%s,"slot":%s,"value":"ok"}\n' "$(field id)" "$(field slot)" ;;
        *'"fn":"hold"'*)
            printf '{"type":"op","id":%s,"slot":%s,"call":%s,"name":"hold","payload":null}\n' "$(field id)" "$(field slot)" "$(field id)" ;;
        *'"fn":"burst"'*)
            id=$(field id)
            slot=$(field slot)
            op=1
            while [ "$op" -le 65 ]; do
                printf '{"type":"op","id":%s,"slot":%s,"call":%s,"name":"hold","payload":null}\n' "$op" "$slot" "$id"
                op=$((op + 1))
            done ;;
        *'"type":"opResult"'*'"error"'*|*'"error"'*'"type":"opResult"'*)
            printf '{"type":"result","id":%s,"slot":%s,"error":"%s"}\n' \
                "$(field call)" "$(field slot)" "$(printf '%s\n' "$line" | /usr/bin/sed -E 's/.*"error":"([^"]*)".*/\1/')" ;;
        *'"type":"opResult"'*'"value":"anonymous"'*)
            printf '{"type":"result","id":%s,"slot":%s,"value":"anonymous"}\n' "$(field call)" "$(field slot)" ;;
    esac
done
"#;

fn setup(timing: Timing) -> (tempfile::TempDir, Arc<Supervisor>) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("action-peer");
    std::fs::write(&path, PEER).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    (
        directory,
        Supervisor::with_timing(path, 256 * 1024 * 1024, timing),
    )
}

fn source(name: &str) -> Arc<Source> {
    Source::new(
        name.into(),
        Snapshot::Legacy(tempfile::NamedTempFile::new().unwrap()),
        Arc::new(Bundle::new(String::new(), None).unwrap()),
        true,
    )
}

fn signal(process: &Running, signal: libc::c_int) {
    assert_eq!(unsafe { libc::kill(process.pid as i32, signal) }, 0);
}

fn hold() -> (Arc<OpRegistry>, mpsc::UnboundedReceiver<()>) {
    let (send, receive) = mpsc::unbounded_channel();
    let mut ops = OpRegistry::new();
    ops.register_async("hold", move |_| {
        let send = send.clone();
        async move {
            send.send(()).unwrap();
            std::future::pending().await
        }
    })
    .unwrap();
    ops.register_sync("sign-in", |_| Ok(json!("anonymous")))
        .unwrap();
    (Arc::new(ops), receive)
}

async fn echo(supervisor: &Supervisor, source: Arc<Source>) {
    assert_eq!(
        supervisor
            .invoke(source, "echo".into(), Value::Null, Arc::new(action_ops()))
            .await
            .unwrap(),
        "ok"
    );
}

const QUICKJS_ACTIONS: &str = r#"
const action = (invoke) => ({ kind: "action", args: { kind: "any" }, invoke });
export const functions = {
    echo: action(() => "ok"),
    stuck: action(async (url) => (await fetch(url)).text()),
};
"#;

const TEST_LIMIT: Duration = Duration::from_secs(5);

fn action_ops() -> OpRegistry {
    let mut ops = OpRegistry::new();
    ops.register_sync("auth.current", |_| Ok(Value::Null))
        .unwrap();
    ops
}

async fn quickjs() -> (Arc<Supervisor>, Arc<Source>, TcpListener, Arc<OpRegistry>) {
    let host = tokamak_worker::Process::action_host_path().expect("locate tokamak-plugin-host");
    let supervisor = Supervisor::new(host, 32 * 1024 * 1024);
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(QUICKJS_ACTIONS.as_bytes()).unwrap();
    let plugin = Source::new(
        "deadline-test".into(),
        Snapshot::Legacy(file),
        Arc::new(Bundle::new(QUICKJS_ACTIONS, None).unwrap()),
        true,
    );
    timeout(TEST_LIMIT, echo(&supervisor, plugin.clone()))
        .await
        .expect("action process did not start");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut ops = action_ops();
    ops.set_network_permissions(vec!["net:127.0.0.1".into()]);
    (supervisor, plugin, listener, Arc::new(ops))
}

async fn stalled_request(listener: &TcpListener) -> TcpStream {
    timeout(TEST_LIMIT, async {
        let (peer, _) = listener.accept().await.unwrap();
        let mut peer = BufReader::new(peer);
        let mut line = String::new();
        assert_ne!(peer.read_line(&mut line).await.unwrap(), 0);
        assert!(line.starts_with("GET / "), "{line:?}");
        loop {
            line.clear();
            assert_ne!(peer.read_line(&mut line).await.unwrap(), 0);
            if line == "\r\n" {
                // Leave the request pending without sending any response.
                return peer.into_inner();
            }
        }
    })
    .await
    .expect("the stuck action never sent its request")
}

async fn assert_cancelled_and_recovered(
    mut peer: TcpStream,
    supervisor: &Supervisor,
    plugin: Arc<Source>,
) {
    // The dispatcher can stay alive; the cancelled QuickJS invocation must
    // release its own socket before the test releases the peer.
    let read = timeout(TEST_LIMIT, peer.read(&mut [0]))
        .await
        .expect("the cancelled action left its fetch open");
    assert_eq!(read.unwrap(), 0, "unexpected trailing request bytes");
    timeout(TEST_LIMIT, echo(supervisor, plugin))
        .await
        .expect("next action did not finish");
    supervisor.stop().await;
}

#[tokio::test]
async fn ordinary_action_deadline_cancels_stuck_call_and_next_call_succeeds() {
    let (supervisor, plugin, listener, ops) = quickjs().await;
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let call = supervisor.invoke_with(
        plugin.clone(),
        "stuck".into(),
        json!(url),
        ops,
        InvocationOptions {
            timeout: Duration::from_secs(1),
            ..InvocationOptions::default()
        },
    );
    tokio::pin!(call);
    let peer = tokio::select! {
        result = &mut call => panic!("action ended before it got stuck: {result:?}"),
        peer = stalled_request(&listener) => peer,
    };
    assert_eq!(call.await.unwrap_err(), "Plugin action deadline exceeded");
    assert_cancelled_and_recovered(peer, &supervisor, plugin).await;
}

#[tokio::test]
async fn dropping_an_action_cancels_stuck_call_and_next_call_succeeds() {
    let (supervisor, plugin, listener, ops) = quickjs().await;
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let mut call = Box::pin(supervisor.invoke(plugin.clone(), "stuck".into(), json!(url), ops));
    let peer = tokio::select! {
        result = &mut call => panic!("action ended before cancellation: {result:?}"),
        peer = stalled_request(&listener) => peer,
    };
    drop(call);
    assert_cancelled_and_recovered(peer, &supervisor, plugin).await;
}

#[tokio::test]
async fn stopped_child_fails_running_calls_and_is_replaced() {
    let (_directory, supervisor) = setup(Timing {
        ping: Duration::from_millis(500),
        unresponsive: Duration::from_secs(2),
        ..Timing::default()
    });
    let source = source("waiting");
    let (ops, mut entered) = hold();
    let waiting = tokio::spawn({
        let supervisor = supervisor.clone();
        let source = source.clone();
        async move {
            supervisor
                .invoke(source, "hold".into(), Value::Null, ops)
                .await
        }
    });
    if tokio::time::timeout(Duration::from_secs(8), entered.recv())
        .await
        .unwrap()
        .is_none()
    {
        panic!(
            "test invocation failed to start: {:?}",
            waiting.await.unwrap()
        );
    }
    let old = supervisor.process().await.unwrap();
    signal(&old, libc::SIGSTOP);
    let error = tokio::time::timeout(Duration::from_secs(9), waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error, "Action process is unresponsive: heartbeat timed out");

    echo(&supervisor, source).await;
    assert_ne!(supervisor.process().await.unwrap().pid, old.pid);
    supervisor.stop().await;
}

#[tokio::test]
async fn heartbeat_allows_a_healthy_child_to_reply_after_a_server_pause() {
    let (_directory, supervisor) = setup(Timing {
        ping: Duration::from_millis(500),
        unresponsive: Duration::from_secs(2),
        ..Timing::default()
    });
    let source = source("paused");
    echo(&supervisor, source.clone()).await;
    let process = supervisor.process().await.unwrap();

    // Pause the current-thread server executor, leaving the peer running.
    std::thread::sleep(Duration::from_millis(2250));
    echo(&supervisor, source).await;
    assert_eq!(supervisor.process().await.unwrap().pid, process.pid);
    supervisor.stop().await;
}

#[tokio::test]
async fn healthy_idle_child_resets_backoff_without_completing_a_call() {
    let (_directory, supervisor) = setup(Timing {
        healthy: Duration::from_millis(300),
        ..Timing::default()
    });
    let first = supervisor.process().await.unwrap();
    signal(&first, libc::SIGKILL);
    first.ended.cancelled().await;

    let healthy = supervisor.process().await.unwrap();
    tokio::time::sleep(Duration::from_millis(350)).await;
    signal(&healthy, libc::SIGKILL);
    healthy.ended.cancelled().await;
    assert_ne!(supervisor.process().await.unwrap().pid, healthy.pid);
    assert_eq!(
        supervisor.restart.lock().await.retry_at,
        healthy
            .stopped_at
            .get()
            .map(|stopped| *stopped + Duration::from_millis(250))
    );
    supervisor.stop().await;
}

#[tokio::test]
async fn full_plugin_call_and_operation_shares_leave_room_for_another_plugin() {
    let (_directory, supervisor) = setup(Timing::default());
    let plugin = source("saturated");
    let peer = source("peer");
    let (ops, mut entered) = hold();
    let mut waiting = tokio::task::JoinSet::new();
    for _ in 0..PLUGIN_CAPACITY {
        let (supervisor, plugin, ops) = (supervisor.clone(), plugin.clone(), ops.clone());
        waiting.spawn(async move {
            supervisor
                .invoke(plugin, "hold".into(), Value::Null, ops)
                .await
        });
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        for _ in 0..PLUGIN_CAPACITY {
            entered.recv().await.unwrap();
        }
    })
    .await
    .unwrap();
    let error = supervisor
        .invoke(plugin.clone(), "echo".into(), Value::Null, ops.clone())
        .await
        .unwrap_err();
    assert_eq!(error, "Plugin saturated reached its action call limit (64)");
    echo(&supervisor, peer.clone()).await;

    let timeout = Duration::from_secs(15);
    let sign_in = supervisor.try_sign_in(timeout).expect("sign-in slot");
    assert_eq!(
        supervisor
            .invoke_with(
                plugin.clone(),
                "sign-in".into(),
                Value::Null,
                ops.clone(),
                sign_in
            )
            .await
            .unwrap(),
        "anonymous"
    );
    assert_eq!(
        supervisor.slots.available_permits(),
        WORKER_CAPACITY - PLUGIN_CAPACITY
    );

    assert_anonymous_limit(&supervisor, &ops, &mut entered, timeout).await;

    waiting.shutdown().await;
    let error = supervisor
        .invoke(plugin, "burst".into(), Value::Null, ops)
        .await
        .unwrap_err();
    assert_eq!(
        error,
        "Plugin saturated reached its host operation limit (64)"
    );
    echo(&supervisor, peer).await;
    supervisor.stop().await;
}

async fn assert_anonymous_limit(
    supervisor: &Arc<Supervisor>,
    ops: &Arc<OpRegistry>,
    entered: &mut mpsc::UnboundedReceiver<()>,
    timeout: Duration,
) {
    let mut anonymous = tokio::task::JoinSet::new();
    for index in 0..ANONYMOUS_CAPACITY {
        let sign_in = supervisor.try_sign_in(timeout).expect("sign-in slot");
        let (supervisor, ops) = (supervisor.clone(), ops.clone());
        let provider = source(&format!("provider-{index}"));
        anonymous.spawn(async move {
            supervisor
                .invoke_with(provider, "hold".into(), Value::Null, ops, sign_in)
                .await
        });
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        for _ in 0..ANONYMOUS_CAPACITY {
            entered.recv().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(
        supervisor.slots.available_permits(),
        WORKER_CAPACITY - PLUGIN_CAPACITY - ANONYMOUS_CAPACITY
    );
    assert!(
        supervisor.try_sign_in(timeout).is_none(),
        "fifth sign-in was admitted"
    );
    anonymous.shutdown().await;
}
