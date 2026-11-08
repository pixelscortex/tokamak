//! Exercise the production Rust socket bridge against the actual server process.
#[path = "../src/socket.rs"]
mod socket;
use futures_util::{SinkExt, StreamExt};
use render::{HostMailbox, NativeDocument};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

struct Service {
    child: Child,
    directory: PathBuf,
}
impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
fn start() -> Service {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let directory = root.join(format!(
        "dist/tests/socket-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let token = directory.join("server.token");
    std::fs::write(&token, "a".repeat(64)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let binary = root
        .join("../target/debug")
        .join(format!("tokamak{}", std::env::consts::EXE_SUFFIX));
    let child = Command::new(binary)
        .arg("--local-dir")
        .arg(&directory)
        .arg("--bundle")
        .arg(root.join("dist/bundle.js"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let service = Service { child, directory };
    let end = Instant::now() + Duration::from_secs(15);
    while !service.directory.join("server.json").exists() {
        assert!(Instant::now() < end, "server readiness deadline");
        std::thread::sleep(Duration::from_millis(10));
    }
    service
}

#[test]
fn socket_admission_bounds_messages_count_and_retired_receiver() {
    let (send, mut receiver) = socket::admission();
    assert!(send("x".repeat(65537)).is_err());
    send("x".repeat(65536)).unwrap();
    assert_eq!(receiver.try_recv().unwrap().len(), 65536);
    for n in 0..64 {
        send(n.to_string()).unwrap();
    }
    assert!(send("overflow".into()).is_err());
    drop(receiver);
    assert!(send("closed".into()).is_err());
}

#[test]
fn production_socket_drains_on_ui_close_keeps_server_alive_and_reports_server_loss() {
    let mut service = start();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let connection = runtime
        .block_on(socket::connect(&service.directory))
        .unwrap();
    let (send, receiver) = socket::admission();
    let send = Arc::new(send);
    let bridge = send.clone();
    let doc = NativeDocument::new_connected(
        include_str!("../dist/shell.html"),
        include_str!("../dist/ui.js"),
        Some(Box::new(move |message| bridge(message))),
    )
    .unwrap();
    let (host, _mailbox) = HostMailbox::new(&doc, || {});
    let (ready, receive) = oneshot::channel();
    ready.send(host).ok().unwrap();
    let (stop, stopped) = oneshot::channel();
    let worker = runtime.spawn(socket::serve(connection, receiver, receive, stopped));
    // Native mount queued two live subscriptions; this command must remain
    // ordered behind their initial completions and be drained during UI close.
    send(
        json!({"type":"mutation","id":100,"name":"todo:add",
        "args":{"title":"accepted before native close"}})
        .to_string(),
    )
    .unwrap();
    drop(doc);
    stop.send(()).unwrap();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(8), worker)
            .await
            .unwrap()
            .unwrap();
    });
    assert!(service.child.try_wait().unwrap().is_none());
    let mut reopened = runtime
        .block_on(socket::connect(&service.directory))
        .unwrap();
    let reply = runtime.block_on(async {
        reopened
            .send(Message::Text(
                json!({"type":"query","id":200,"name":"todo:list","args":{}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(5), reopened.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::from_str::<Value>(frame.to_text().unwrap()).unwrap()
    });
    assert!(
        reply["result"]["Ok"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["title"] == "accepted before native close")
    );
    runtime.block_on(reopened.close(None)).unwrap();

    let connection = runtime
        .block_on(socket::connect(&service.directory))
        .unwrap();
    let (_send, receiver) = socket::admission();
    let mut doc = NativeDocument::new(
        "<html><body><div id='app'></div></body></html>",
        r#"
      globalThis.__tokamak = {
        drain(){return '[]';}, dispatch(){return '{"prevented":false,"stopped":false,"error":null}';},
        host(){throw new Error('observed terminal close');},
        dispose(){}
      };
    "#,
    )
    .unwrap();
    let (host, mut mailbox) = HostMailbox::new(&doc, || {});
    let (ready, receive) = oneshot::channel();
    ready.send(host).ok().unwrap();
    let (_stop, stopped) = oneshot::channel();
    let worker = runtime.spawn(socket::serve(connection, receiver, receive, stopped));
    service.child.kill().unwrap();
    service.child.wait().unwrap();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(8), worker)
            .await
            .unwrap()
            .unwrap();
    });
    assert!(
        mailbox.drain(&mut doc).is_err(),
        "live UI must receive terminal server loss"
    );
}
