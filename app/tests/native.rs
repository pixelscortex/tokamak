//! TKM-10 production bundle → native input → SDK → Tower → QuickJS → SurrealKV
//! → ordered mailbox → native UI. These tests do not prove physical macOS IME,
//! foreground-window presentation, or GPU output; the renderer is explicitly CPU.
#[path = "../_host/connection.rs"]
mod connection;
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;

use blitz_dom::{Document, Namespace, QualName};
use blitz_traits::{NodeId, events::*, shell::Viewport};
use keyboard_types::Modifiers;
use render::{HostMailbox, HostSender, NativeDocument};
use runtime::{Bundle, PoolConfig};
use serde_json::Value;
use server::{Backend, BackendConfig, data::Storage};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;

// Isolated under ignored worktree output, never ProjectDirs/HOME or real data.
struct Store(PathBuf);
impl Store {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("dist/tests/store-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct App {
    doc: Option<NativeDocument>,
    mailbox: Option<HostMailbox>,
    host: HostSender,
    admit: Arc<render::MessageSender>,
    requests: Arc<Mutex<Vec<Value>>>,
    stop: Option<oneshot::Sender<()>>,
    worker: Option<tokio::task::JoinHandle<Result<(), server::Error>>>,
    rt: tokio::runtime::Runtime,
}
impl App {
    fn open(path: &Path) -> Self {
        Self::with_ui(path, include_str!("../dist/ui.js"))
    }
    fn with_ui(path: &Path, ui: &str) -> Self {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let backend = rt
            .block_on(Backend::start(BackendConfig {
                storage: Storage::Disk(path.join("store")),
                bundle: Arc::new(
                    Bundle::new(
                        include_str!("../dist/bundle.js"),
                        Some(include_str!("../dist/bundle.js.map")),
                    )
                    .unwrap(),
                ),
                javascript: PoolConfig::default(),
            }))
            .unwrap();
        let session = rt.block_on(backend.connect()).unwrap();
        let (send, receive) = connection::admission();
        let admit = Arc::new(send);
        let send = admit.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let mut doc = NativeDocument::new_connected(
            include_str!("../dist/shell.html"),
            ui,
            Some(Box::new(move |message| {
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(&message).unwrap());
                send(message)
            })),
        )
        .unwrap();
        doc.inner_mut().set_viewport(Viewport {
            window_size: (1100, 1400),
            ..Default::default()
        });
        let (host, mailbox) = HostMailbox::new(&doc, || {});
        let (ready, receiver) = oneshot::channel();
        assert!(ready.send(host.clone()).is_ok());
        let (stop, stopped) = oneshot::channel();
        let worker = rt.spawn(connection::serve(
            backend, session, receive, receiver, stopped,
        ));
        Self {
            doc: Some(doc),
            mailbox: Some(mailbox),
            host,
            admit,
            requests,
            stop: Some(stop),
            worker: Some(worker),
            rt,
        }
    }
    fn doc(&self) -> &NativeDocument {
        self.doc.as_ref().unwrap()
    }
    fn doc_mut(&mut self) -> &mut NativeDocument {
        self.doc.as_mut().unwrap()
    }
    fn wait(&mut self, check: impl Fn(&NativeDocument) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            self.mailbox
                .as_mut()
                .unwrap()
                .drain(self.doc.as_mut().unwrap())
                .unwrap();
            assert!(
                self.doc_mut().take_error().is_none(),
                "native document failed"
            );
            if check(self.doc()) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "native workflow timeout: {}",
                support::text(self.doc(), "app")
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    fn ready(&mut self) {
        self.wait(|doc| !support::text(doc, "app").contains("Loading tasks"));
    }
    fn input(&mut self, panel: &str, title: &str) {
        support::focus(self.doc_mut(), &format!("{panel}-title"));
        self.doc_mut()
            .handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit(title.into())));
    }
    fn add(&mut self, panel: &str, title: &str) {
        self.input(panel, title);
        assert!(support::attr(self.doc(), &format!("{panel}-add"), "disabled").is_none());
        support::pointer(self.doc_mut(), &format!("{panel}-add"));
        // Synchronous pending state must disable *real* controls before replies.
        assert!(support::attr(self.doc(), &format!("{panel}-title"), "disabled").is_some());
        assert!(support::attr(self.doc(), &format!("{panel}-add"), "disabled").is_some());
        self.wait(|doc| {
            both(doc, title.trim())
                && support::editor(doc, &format!("{panel}-title")).is_empty()
                && support::attr(doc, &format!("{panel}-title"), "disabled").is_none()
        });
    }
    fn click(&mut self, panel: &str, label: &str) {
        let target = control(self.doc(), panel, label);
        click(self.doc_mut(), target);
    }
    fn retire(&mut self) {
        drop(self.doc.take());
        drop(self.mailbox.take());
    }
    fn join(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            self.rt
                .block_on(async { tokio::time::timeout(Duration::from_secs(20), worker).await })
                .expect("backend drain exceeded 20s")
                .unwrap()
                .unwrap();
        }
    }
}
impl Drop for App {
    fn drop(&mut self) {
        self.retire();
        self.join();
    }
}
fn both(doc: &NativeDocument, text: &str) -> bool {
    ["first", "second"]
        .iter()
        .all(|panel| support::text(doc, panel).contains(text))
}
fn control(doc: &NativeDocument, panel: &str, label: &str) -> NodeId {
    let inner = doc.inner();
    let mut pending = vec![inner.get_element_by_id(panel).unwrap()];
    while let Some(id) = pending.pop() {
        let node = inner.get_node(id).unwrap();
        if node.element_data().is_some_and(|e| {
            e.attr(QualName::new(None, Namespace::from(""), "aria-label".into()).local)
                == Some(label)
        }) {
            return id;
        }
        pending.extend(node.children.iter().copied());
    }
    panic!("missing control {panel}/{label}");
}
fn pressed(doc: &NativeDocument, panel: &str, label: &str) -> String {
    doc.inner()
        .get_node(control(doc, panel, label))
        .unwrap()
        .element_data()
        .unwrap()
        .attr(QualName::new(None, Namespace::from(""), "aria-pressed".into()).local)
        .unwrap()
        .to_owned()
}
fn click(doc: &mut NativeDocument, target: NodeId) {
    doc.inner_mut().resolve(0.0);
    let rect = doc.inner().get_client_bounding_rect(target).unwrap();
    assert!(rect.width > 0.0 && rect.height > 0.0);
    let (x, y) = (
        (rect.x + rect.width / 2.0) as f32,
        (rect.y + rect.height / 2.0) as f32,
    );
    let mut event = BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords: PointerCoords {
            page_x: x,
            page_y: y,
            screen_x: x,
            screen_y: y,
            client_x: x,
            client_y: y,
        },
        button: MouseEventButton::Main,
        buttons: MouseEventButtons::Primary,
        mods: Modifiers::empty(),
        details: Default::default(),
        element: Default::default(),
        active_pointers: Default::default(),
    };
    doc.handle_ui_event(UiEvent::PointerDown(event.clone()));
    event.buttons = MouseEventButtons::None;
    doc.handle_ui_event(UiEvent::PointerUp(event));
}

// Acceptance: each panel is an independent SDK subscription, not a shared UI
// array. Add/toggle/remove from EITHER panel must update BOTH via production code.
#[test]
fn two_native_panels_sync_and_persist_on_quit_reopen() {
    let store = Store::new();
    let mut app = App::open(&store.0);
    assert!(both(app.doc(), "Loading tasks"));
    assert_eq!(
        app.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["type"] == "subscribe" && r["name"] == "todo:list")
            .count(),
        2
    );
    app.ready();
    for panel in ["first", "second"] {
        assert!(support::attr(app.doc(), &format!("{panel}-add"), "disabled").is_some());
    }
    app.add("first", "Milk");
    app.add("second", "Book");
    assert_eq!(pressed(app.doc(), "second", "Complete: Milk"), "false");
    app.click("second", "Complete: Milk");
    app.wait(|doc| both(doc, "Done · Milk"));
    assert_eq!(pressed(app.doc(), "first", "Mark incomplete: Milk"), "true");
    app.click("first", "Complete: Book");
    app.wait(|doc| both(doc, "Done · Book"));
    app.click("first", "Remove: Milk");
    app.wait(|doc| !support::text(doc, "app").contains("Milk") && both(doc, "Done · Book"));
    app.retire();
    // Cleanup must issue one unsubscribe per subscription, followed by close.
    let requests = app.requests.lock().unwrap();
    let subscriptions: Vec<_> = requests
        .iter()
        .filter(|r| r["type"] == "subscribe")
        .map(|r| r["id"].clone())
        .collect();
    for id in subscriptions {
        assert_eq!(
            requests
                .iter()
                .filter(|r| r["type"] == "unsubscribe" && r["id"] == id)
                .count(),
            1
        );
    }
    assert_eq!(requests.last(), Some(&Value::Null));
    drop(requests);
    assert!(
        app.host.send("connection:event", Value::Null).is_err(),
        "postdrop callback admitted"
    );
    app.join();
    drop(app);
    let mut reopened = App::open(&store.0);
    reopened.ready();
    assert!(both(reopened.doc(), "Done · Book"));
    assert!(!support::text(reopened.doc(), "app").contains("Milk"));
    reopened.click("second", "Remove: Book");
    reopened.wait(|doc| both(doc, "0 tasks"));
    drop(reopened);
    let mut empty = App::open(&store.0);
    empty.ready();
    assert!(both(empty.doc(), "0 tasks"), "deletion did not persist");
}

// Failure mode: quitting with a mutation already admitted must drain that write,
// not cancel it when dropping the document/session before its reply is delivered.
#[test]
fn accepted_native_mutation_survives_immediate_document_shutdown() {
    let store = Store::new();
    let mut app = App::open(&store.0);
    app.ready();
    app.input("second", "Accepted before quit");
    support::pointer(app.doc_mut(), "second-add");
    assert!(
        app.requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["type"] == "mutation" && r["name"] == "todo:add")
    );
    drop(app); // deliberately do not deliver the mutation response
    let mut reopened = App::open(&store.0);
    reopened.ready();
    assert!(both(reopened.doc(), "Accepted before quit"));
}

// Failure mode: native terminal delivery must release pending controls and show
// the query error. Subsequent input must fail visibly rather than hang/retry.
#[test]
fn terminal_native_close_reaches_both_query_owners() {
    let store = Store::new();
    let mut app = App::open(&store.0);
    app.ready();
    app.host
        .finish("connection:close", "backend unavailable")
        .unwrap();
    app.wait(|doc| both(doc, "backend unavailable"));
    app.input("first", "Cannot save");
    support::pointer(app.doc_mut(), "first-add");
    app.wait(|doc| {
        support::text(doc, "first").contains("backend unavailable")
            && support::attr(doc, "first-title", "disabled").is_none()
    });
    assert!(
        !app.requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["type"] == "mutation")
    );
}

// Failure mode: a blocked UI owner cannot grow an unbounded native request
// backlog. The production constructor rejects oversized UTF-8 bytes and a full
// queue synchronously; it never enqueues a rejected item or retries admission.
#[test]
fn production_admission_bounds_owned_bytes_count_and_closed_receiver() {
    let (send, mut receiver) = connection::admission();
    assert!(
        send("é".repeat(32 * 1024 + 1))
            .unwrap_err()
            .to_string()
            .contains("64 KiB")
    );
    assert!(receiver.try_recv().is_err());
    let boundary = "x".repeat(64 * 1024);
    send(boundary.clone()).unwrap();
    assert_eq!(receiver.try_recv().unwrap(), boundary);
    for index in 0..64 {
        send(index.to_string()).unwrap();
    }
    assert!(send("overflow".into()).is_err());
    for index in 0..64 {
        assert_eq!(receiver.try_recv().unwrap(), index.to_string());
    }
    assert!(receiver.try_recv().is_err());
    send("after drain".into()).unwrap();
    assert_eq!(receiver.try_recv().unwrap(), "after drain");
    drop(receiver);
    assert!(send("after receiver drop".into()).is_err());
}

fn trace(doc: &NativeDocument) -> Vec<String> {
    serde_json::from_str(&support::text(doc, "trace")).unwrap()
}

// Acceptance: committed subscription snapshots must precede a writer's reply
// all the way through the actual native connection, not merely in a server
// unit test. The fixture observes normal SDK operations on the real app feature.
#[test]
fn native_bridge_preserves_both_subscription_updates_before_mutation_reply() {
    let store = Store::new();
    let ui = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/dist/tests/bridge.js"))
        .unwrap();
    let mut app = App::with_ui(&store.0, &ui);
    app.wait(|doc| trace(doc).len() == 2);
    let generation = app.host.generation();
    app.doc_mut()
        .host_event(generation, "write", Value::Null)
        .unwrap();
    app.wait(|doc| trace(doc).contains(&"reply".to_owned()));
    let events = trace(app.doc());
    assert_eq!(events.len(), 5);
    assert_eq!(events.last().unwrap(), "reply");
    let mut initial = events[..2].to_vec();
    let mut updates = events[2..4].to_vec();
    initial.sort();
    updates.sort();
    assert_eq!(initial, ["first", "second"]);
    assert_eq!(updates, initial);
}

// Failure mode: JSON/protocol corruption must terminate the native stream and
// notify every observer; it must not hang, execute a mutation, or be treated as
// the intentional null close sentinel. Use production parser/serve, not a mock.
#[test]
fn malformed_native_requests_close_both_live_queries() {
    for malformed in [
        "{",
        "[]",
        "{}",
        r#"{"type":"mutation","id":"bad","name":"todo:add","args":{}}"#,
    ] {
        let store = Store::new();
        let ui =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/dist/tests/bridge.js"))
                .unwrap();
        let mut app = App::with_ui(&store.0, &ui);
        app.wait(|doc| trace(doc).len() == 2);
        (app.admit)(malformed.into()).unwrap();
        app.wait(|doc| {
            trace(doc)
                .iter()
                .filter(|event| event.starts_with("error:"))
                .count()
                == 2
        });
        let events = trace(app.doc());
        assert_eq!(events.len(), 4);
        assert!(events.contains(&"error:first".to_owned()));
        assert!(events.contains(&"error:second".to_owned()));
        app.join();
    }
}

// Failure mode: a saturated host mailbox must still carry one terminal event,
// but only AFTER admitted updates. A failure signal that displaces earlier
// events or is itself dropped would strand SDK promises or reorder commits.
#[test]
fn terminal_mailbox_reserve_is_bounded_and_ordered_after_normal_events() {
    let store = Store::new();
    let mut app = App::open(&store.0);
    app.ready();
    for _ in 0..256 {
        app.host.send("unused", Value::Null).unwrap();
    }
    assert!(app.host.send("unused", Value::Null).is_err());
    app.host
        .finish("connection:close", "terminal after full queue")
        .unwrap();
    assert_eq!(app.mailbox.as_ref().unwrap().pending(), 257);
    assert!(
        app.host
            .finish("connection:close", "duplicate terminal")
            .is_err()
    );
    assert!(app.host.send("unused", Value::Null).is_err());
    for _ in 0..7 {
        let delivered = app
            .mailbox
            .as_mut()
            .unwrap()
            .drain(app.doc.as_mut().unwrap())
            .unwrap();
        assert!((1..=32).contains(&delivered));
        assert!(!support::text(app.doc(), "app").contains("terminal after full queue"));
    }
    app.wait(|doc| both(doc, "terminal after full queue"));
    assert_eq!(app.mailbox.as_ref().unwrap().pending(), 0);
}

// Regression: even a legal near-limit malformed request can produce a parser
// diagnostic larger than a terminal envelope. Both live SDK observers must
// still receive failure, rather than keeping an apparently live connection.
#[test]
fn near_limit_malformed_native_request_notifies_both_query_owners() {
    let store = Store::new();
    let ui = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/dist/tests/bridge.js"))
        .unwrap();
    let mut app = App::with_ui(&store.0, &ui);
    app.wait(|doc| trace(doc).len() == 2);
    let malformed = serde_json::json!({ "type": "a".repeat(65_470) }).to_string();
    assert_eq!(malformed.len(), 65_481);
    (app.admit)(malformed).expect("below-limit native payload must be admitted");
    app.wait(|doc| {
        trace(doc)
            .iter()
            .filter(|event| event.starts_with("error:"))
            .count()
            == 2
    });
    assert_eq!(
        trace(app.doc()).len(),
        4,
        "both owners receive one bounded failure"
    );
}

// Regression: native admission has already accepted these writes before quit.
// A full Tower lane must delay draining, not silently discard the native queue.
// Current-thread Tokio makes staging deterministic: after block_on returns no
// coordinator poll can occur until serve is explicitly driven.
#[test]
fn all_native_admitted_mutations_persist_when_tower_lane_is_saturated_at_shutdown() {
    use server::protocol::Request;
    let store = Store::new();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let backend = rt
        .block_on(Backend::start(BackendConfig {
            storage: Storage::Disk(store.0.join("store")),
            bundle: Arc::new(
                Bundle::new(
                    include_str!("../dist/bundle.js"),
                    Some(include_str!("../dist/bundle.js.map")),
                )
                .unwrap(),
            ),
            javascript: PoolConfig::default(),
        }))
        .unwrap();
    let session = rt.block_on(backend.connect()).unwrap();
    let pressure = rt.block_on(backend.connect()).unwrap();
    let pressure_sender = pressure.sender();
    for id in 1..=64 {
        pressure_sender
            .request(Request::Query {
                id,
                name: "todo:list".into(),
                args: serde_json::json!({}),
            })
            .unwrap();
    }
    assert_eq!(
        pressure_sender.request(Request::Query {
            id: 65,
            name: "todo:list".into(),
            args: serde_json::json!({}),
        }),
        Err(server::Error::Overloaded),
        "Tower queue was not actually saturated"
    );
    let (admit, receive) = connection::admission();
    for index in 0..64 {
        admit(
            serde_json::json!({
                "type": "mutation", "id": index + 1, "name": "todo:add",
                "args": { "title": format!("Accepted queued write {index:02}") }
            })
            .to_string(),
        )
        .expect("native constructor accepted this write");
    }
    // Pressure-session teardown avoids a deliberately unconsumed output stream;
    // queued commands still occupy all slots until the coordinator next polls.
    drop(pressure_sender);
    drop(pressure);
    let (host, ready) = oneshot::channel();
    drop(host);
    let (stop, stopped) = oneshot::channel();
    stop.send(()).unwrap();
    rt.block_on(async {
        tokio::time::timeout(
            Duration::from_secs(30),
            connection::serve(backend, session, receive, ready, stopped),
        )
        .await
    })
    .expect("saturated graceful drain hung")
    .unwrap();
    drop(admit);
    drop(rt);
    let mut reopened = App::open(&store.0);
    reopened.ready();
    assert!(
        both(reopened.doc(), "64 tasks"),
        "lost admitted writes after saturated shutdown: {}",
        support::text(reopened.doc(), "first")
    );
    for index in 0..64 {
        assert!(both(
            reopened.doc(),
            &format!("Accepted queued write {index:02}")
        ));
    }
}

// Regression: valid SDK requests must not commit an aggregate list too large
// for native delivery. Either reject explicitly before commit or keep every
// accepted state readable in both live subscriptions and after disk reopen.
#[test]
fn accepted_large_sdk_titles_never_break_live_or_reopened_app() {
    let store = Store::new();
    let ui = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/dist/tests/bridge.js"))
        .unwrap();
    let mut app = App::with_ui(&store.0, &ui);
    app.wait(|doc| trace(doc).len() == 2);
    for (index, title) in ["a".repeat(40_000), "b".repeat(40_000)]
        .into_iter()
        .enumerate()
    {
        let generation = app.host.generation();
        app.doc_mut()
            .host_event(generation, "write:title", Value::String(title))
            .unwrap();
        app.wait(|doc| {
            trace(doc)
                .iter()
                .filter(|event| event.starts_with("title:"))
                .count()
                == index + 1
        });
        assert!(
            !trace(app.doc())
                .iter()
                .any(|event| event.starts_with("error:")),
            "valid SDK title disconnected live query owners: {:?}",
            trace(app.doc())
        );
    }
    drop(app);
    let mut reopened = App::open(&store.0);
    reopened.ready();
    assert!(
        !support::text(reopened.doc(), "app").contains("64 KiB"),
        "persisted accepted state cannot be read after reopen"
    );
    assert!(
        reopened
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["type"] == "subscribe")
            .count()
            == 2
    );
    reopened.add("first", "Still usable");
}
