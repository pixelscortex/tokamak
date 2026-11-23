//! Exercise the supervisor with a real process and the action pipe protocol.

use std::os::unix::fs::PermissionsExt;

use super::*;

const PEER: &str = r#"#!/bin/sh
field() { printf '%s\n' "$line" | /usr/bin/sed -E "s/.*\"$1\":([0-9]+).*/\1/"; }
while IFS= read -r line; do
    case "$line" in
        *'"type":"ping"'*)
            printf '{"type":"pong","id":%s}\n' "$(field id)" ;;
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
    (Arc::new(ops), receive)
}

async fn echo(supervisor: &Supervisor, source: Arc<Source>) {
    assert_eq!(
        supervisor
            .invoke(
                source,
                "echo".into(),
                Value::Null,
                Arc::new(OpRegistry::new())
            )
            .await
            .unwrap(),
        "ok"
    );
}

#[tokio::test]
async fn stopped_child_fails_running_calls_and_is_replaced() {
    let (_directory, supervisor) = setup(Timing {
        ping: Duration::from_millis(25),
        unresponsive: Duration::from_millis(500),
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
    tokio::time::timeout(Duration::from_secs(2), entered.recv())
        .await
        .unwrap()
        .unwrap();
    let old = supervisor.process().await.unwrap();
    signal(&old, libc::SIGSTOP);
    let error = tokio::time::timeout(Duration::from_secs(2), waiting)
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
        supervisor.state.lock().await.restart.retry_at,
        healthy
            .stopped_at
            .get()
            .map(|stopped| *stopped + BASE_DELAY)
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
