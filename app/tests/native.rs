//! TKM-10 production bundle → native input → SDK → Tower → QuickJS → SurrealKV
//! → ordered mailbox → native UI. These tests do not prove physical macOS IME,
//! foreground-window presentation, or GPU output; the renderer is explicitly CPU.
#[path = "support/embedded.rs"]
mod connection;
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;

use blitz_dom::{Document, Namespace, QualName};
use blitz_traits::{NodeId, events::*, shell::Viewport};
use engine::{Bundle, PoolConfig};
use keyboard_types::Modifiers;
use render::{HostMailbox, HostSender, NativeDocument};
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
        Self::with_ui(path, include_str!("../dist/tests/record/dist/ui.js"))
    }
    fn with_ui(path: &Path, ui: &str) -> Self {
        Self::with_queued_ui(path, ui, Vec::new())
    }
    fn with_queued_ui(path: &Path, ui: &str, queued: Vec<String>) -> Self {
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
                        include_str!("../dist/tests/record/dist/bundle.js"),
                        Some(include_str!("../dist/tests/record/dist/bundle.js.map")),
                    )
                    .unwrap(),
                ),
                javascript: PoolConfig::default(),
            }))
            .unwrap();
        let session = rt.block_on(backend.connect()).unwrap();
        let (send, receive) = connection::admission();
        // Before spawning serve, establish actual accepted native backlog.
        for request in queued {
            send(request).expect("prequeued native admission");
        }
        let admit = Arc::new(send);
        let send = admit.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let mut doc = NativeDocument::new_connected(
            include_str!("../dist/tests/record/dist/shell.html"),
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
            .filter(|r| r["type"] == "subscribe" && r["name"] == "record:list")
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
            .any(|r| r["type"] == "mutation" && r["name"] == "record:add")
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
        r#"{"type":"mutation","id":"bad","name":"record:add","args":{}}"#,
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
    let reasons: Vec<String> =
        serde_json::from_str(&support::text(app.doc(), "failure-reasons")).unwrap();
    assert_eq!(reasons.len(), 2);
    assert!(
        reasons
            .iter()
            .all(|reason| !reason.is_empty() && reason.chars().count() <= 1024),
        "terminal reason exceeded the documented Unicode scalar budget"
    );
}

// Regression: terminal normalization must respect Unicode scalar boundaries,
// not slice UTF-8 midway through a non-ASCII parser diagnostic and panic or
// produce an invalid envelope. The bound applies to each SDK observer's reason.
#[test]
fn unicode_near_limit_malformed_request_delivers_bounded_terminal_reasons() {
    let store = Store::new();
    let mut app = bridge(&store);
    let malformed = serde_json::json!({ "type": "🧪".repeat(16_360) }).to_string();
    assert!(malformed.len() < 64 * 1024);
    (app.admit)(malformed).unwrap();
    app.wait(|doc| {
        trace(doc)
            .iter()
            .filter(|event| event.starts_with("error:"))
            .count()
            == 2
    });
    let reasons: Vec<String> =
        serde_json::from_str(&support::text(app.doc(), "failure-reasons")).unwrap();
    assert_eq!(reasons.len(), 2);
    assert!(
        reasons
            .iter()
            .all(|reason| !reason.is_empty() && reason.chars().count() <= 1024)
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
                    include_str!("../dist/tests/record/dist/bundle.js"),
                    Some(include_str!("../dist/tests/record/dist/bundle.js.map")),
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
            .request(Request::Mutation {
                id,
                name: "record:add".into(),
                args: serde_json::json!({ "title": format!("Tower queued write {id:02}") }),
            })
            .unwrap();
    }
    assert_eq!(
        pressure_sender.request(Request::Mutation {
            id: 65,
            name: "record:add".into(),
            args: serde_json::json!({ "title": "Not admitted" }),
        }),
        Err(server::Error::Overloaded),
        "Tower queue was not actually saturated"
    );
    let (admit, receive) = connection::admission();
    for index in 0..64 {
        admit(
            serde_json::json!({
                "type": "mutation", "id": index + 1, "name": "record:add",
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
        both(reopened.doc(), "128 tasks"),
        "lost admitted writes after saturated shutdown: {}",
        support::text(reopened.doc(), "first")
    );
    for index in 0..64 {
        assert!(both(
            reopened.doc(),
            &format!("Accepted queued write {index:02}")
        ));
        assert!(both(
            reopened.doc(),
            &format!("Tower queued write {:02}", index + 1)
        ));
    }
}

fn bridge(store: &Store) -> App {
    let ui = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/dist/tests/bridge.js"))
        .unwrap();
    let mut app = App::with_ui(&store.0, &ui);
    app.wait(|doc| trace(doc).len() == 2);
    app
}

#[test]
fn prequeued_cheap_native_requests_keep_stream_healthy_for_subsequent_feature_calls() {
    let ui = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/dist/tests/fairness.js"
    ))
    .unwrap();
    for _ in 0..8 {
        let store = Store::new();
        let queued = (1001..=1064)
            .map(|id| {
                serde_json::json!({
                    "type": "unsubscribe", "id": id,
                })
                .to_string()
            })
            .collect();
        let mut app = App::with_queued_ui(&store.0, &ui, queued);
        app.wait(|doc| {
            let events = trace(doc);
            events
                .iter()
                .filter(|event| event.starts_with("ack:"))
                .count()
                == 64
                || events.iter().any(|event| event.starts_with("closed:"))
        });
        let events = trace(app.doc());
        assert!(
            !events.iter().any(|event| event.starts_with("closed:")),
            "legal prequeued cheap requests prematurely closed healthy native stream: {events:?}"
        );
        assert_eq!(
            events,
            (1001..=1064)
                .map(|id| format!("ack:{id}"))
                .collect::<Vec<_>>(),
            "missing or reordered native unsubscribe acknowledgments"
        );
        let generation = app.host.generation();
        app.doc_mut()
            .host_event(generation, "begin", Value::Null)
            .unwrap();
        app.wait(|doc| {
            let events = trace(doc);
            events.contains(&"query:reply".to_owned())
                || events
                    .iter()
                    .any(|event| event.starts_with("failed:") || event.starts_with("closed:"))
        });
        let events = trace(app.doc());
        assert!(
            events.contains(&"mutation:accepted".to_owned())
                && events.contains(&"query:reply".to_owned()),
            "connection failed subsequent normal SDK mutation/read: {events:?}"
        );
        let titles: Vec<String> =
            serde_json::from_str(&support::text(app.doc(), "fairness-data")).unwrap();
        assert_eq!(titles, ["Healthy after cheap native requests"]);
        drop(app);
        let mut reopened = App::open(&store.0);
        reopened.ready();
        assert!(
            both(reopened.doc(), "Healthy after cheap native requests"),
            "accepted post-burst write did not persist"
        );
    }
}

fn wait_for_connection_exit(app: &App) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !app.worker.as_ref().unwrap().is_finished() {
        assert!(
            Instant::now() < deadline,
            "native connection did not finish without another UI event"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn accepted_close_write(app: &mut App) {
    app.input("first", "Accepted at diagnostic close");
    support::pointer(app.doc_mut(), "first-add");
    assert!(
        app.requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request["type"] == "mutation" && request["name"] == "record:add"),
        "close scenario did not admit a real UI mutation"
    );
}

fn assert_live_failure_reasons(app: &mut App) -> Vec<String> {
    app.wait(|doc| {
        trace(doc)
            .iter()
            .filter(|event| event.starts_with("error:"))
            .count()
            == 2
    });
    let reasons: Vec<String> =
        serde_json::from_str(&support::text(app.doc(), "failure-reasons")).unwrap();
    assert_eq!(
        reasons.len(),
        2,
        "live owners must each receive terminal failure once"
    );
    assert!(
        reasons
            .iter()
            .all(|reason| !reason.is_empty() && reason.chars().count() <= 1024)
    );
    assert!(
        !app.host.is_document_retired(),
        "notification test retired its owner"
    );
    reasons
}

const PRIVATE_REQUEST_SENTINEL: &str = "PRIVATE_TOKEN_DO_NOT_LOG_π_🧪";

// Each child actually executes this contract; no extra no-op child test or
// production logging hook is needed. Subprocess isolation captures real Rust
// stderr without a process-global redirect racing other native tests.
fn close_diagnostic_child(case: &str, path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    if matches!(case, "stop-live" | "null-live" | "drop-before-stop") {
        let mut app = App::open(path);
        app.ready();
        accepted_close_write(&mut app);
        match case {
            "stop-live" => {
                app.join();
                assert!(!app.host.is_document_retired());
            }
            "null-live" => {
                (app.admit)("null".into()).unwrap();
                // Do not send stop until the actual null sentinel has finished
                // the connection: otherwise stop could mask a broken null path.
                wait_for_connection_exit(&app);
                assert!(!app.host.is_document_retired());
                app.join();
            }
            "drop-before-stop" => {
                app.retire();
                assert!(app.host.is_document_retired());
                // Document cleanup's queued null must finish without a manual
                // stop masking the retired-generation delivery race.
                wait_for_connection_exit(&app);
                app.join();
            }
            _ => unreachable!(),
        }
        drop(app);
        let mut reopened = App::open(path);
        reopened.ready();
        assert!(
            both(reopened.doc(), "Accepted at diagnostic close"),
            "diagnostic suppression lost an admitted write"
        );
        drop(reopened);
    } else {
        let ui =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/dist/tests/bridge.js"))
                .unwrap();
        let mut app = App::with_ui(path, &ui);
        app.wait(|doc| trace(doc).len() == 2);
        assert!(!app.host.is_document_retired());
        match case {
            "live-malformed" => {
                // Parser errors can echo arbitrary values, including escaped
                // controls and non-ASCII tokens. Detail belongs only to this UI.
                let private_type = format!("{PRIVATE_REQUEST_SENTINEL}\n\t\u{0001}");
                (app.admit)(serde_json::json!({ "type": private_type }).to_string()).unwrap();
                let reasons = assert_live_failure_reasons(&mut app);
                assert!(
                    reasons
                        .iter()
                        .all(|reason| reason.contains(PRIVATE_REQUEST_SENTINEL)),
                    "redaction incorrectly stripped the owning UI's bounded failure detail"
                );
            }
            "live-overload" | "live-mailbox-closed" => {
                if case == "live-overload" {
                    for _ in 0..256 {
                        app.host.send("unused", Value::Null).unwrap();
                    }
                    assert!(app.host.send("unused", Value::Null).is_err());
                } else {
                    drop(app.mailbox.take());
                    assert!(
                        !app.host.is_document_retired(),
                        "mailbox closure is not document retirement"
                    );
                }
                let generation = app.host.generation();
                app.doc_mut()
                    .host_event(generation, "write", Value::Null)
                    .unwrap();
                // No drain until the failure is produced: overload is staged,
                // not inferred from scheduler timing or an arbitrary sleep.
                wait_for_connection_exit(&app);
                assert!(!app.host.is_document_retired());
                if case == "live-overload" {
                    let reasons = assert_live_failure_reasons(&mut app);
                    assert!(
                        reasons
                            .iter()
                            .all(|reason| reason.contains("Host event queue overloaded")),
                        "owning UI lost the actual overload cause"
                    );
                }
            }
            _ => panic!("unknown diagnostic child case: {case}"),
        }
        app.join();
    }
    println!("PASS executed close diagnostic case: {case}");
}

// Regression: ordinary stop/null/document retirement must not print a terminal
// delivery warning, yet suppressing all diagnostics is also wrong. Real LIVE
// malformed/overloaded streams must still notify both SDK owners with bounded
// reasons, and an unavailable mailbox on a live document remains reportable.
// Persistent stderr must identify failure categories without recording payloads.
#[test]
fn native_close_diagnostics_distinguish_retirement_from_live_failure() {
    use std::process::{Command, Stdio};

    const CHILD_CASE: &str = "TOKAMAK_TEST_CLOSE_DIAGNOSTIC_CASE";
    const CHILD_STORE: &str = "TOKAMAK_TEST_CLOSE_DIAGNOSTIC_STORE";
    if let Some(case) = std::env::var_os(CHILD_CASE) {
        let path = PathBuf::from(std::env::var_os(CHILD_STORE).expect("child store path"));
        close_diagnostic_child(case.to_str().unwrap(), &path);
        return;
    }

    // Kill/reap on timeout or assertion failure before deleting isolated files.
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for case in [
        "stop-live",
        "null-live",
        "drop-before-stop",
        "live-malformed",
        "live-overload",
        "live-mailbox-closed",
    ] {
        let scratch = Store::new();
        let stdout_path = scratch.0.join("stdout");
        let stderr_path = scratch.0.join("stderr");
        let mut child = Child(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "native_close_diagnostics_distinguish_retirement_from_live_failure",
                    "--nocapture",
                    "--test-threads=1",
                ])
                // Set only this child's environment; never mutate HOME or the test
                // runner's global environment or touch application data.
                .env(CHILD_CASE, case)
                .env(CHILD_STORE, scratch.0.join("data"))
                .stdin(Stdio::null())
                .stdout(std::fs::File::create(&stdout_path).unwrap())
                .stderr(std::fs::File::create(&stderr_path).unwrap())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(45);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "close diagnostic child timed out: {case}"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        for path in [&stdout_path, &stderr_path] {
            assert!(
                std::fs::metadata(path).unwrap().len() <= 128 * 1024,
                "unexpected unbounded diagnostic output for {case}"
            );
        }
        let stdout = std::fs::read_to_string(stdout_path).unwrap();
        let stderr = std::fs::read_to_string(stderr_path).unwrap();
        assert!(
            status.success(),
            "close child {case} failed\n{stdout}\n{stderr}"
        );
        assert!(
            stdout.contains(&format!("PASS executed close diagnostic case: {case}")),
            "child test filter skipped its scenario: {stdout}"
        );
        if matches!(case, "stop-live" | "null-live" | "drop-before-stop") {
            assert!(
                !stderr.contains("Native terminal delivery failed")
                    && !stderr.contains("Native connection failed"),
                "expected close reported as a backend/terminal failure ({case}): {stderr}"
            );
        } else {
            assert!(
                stderr.contains("Native connection failed:"),
                "live protocol/backend failure was silenced ({case}): {stderr}"
            );
            if case == "live-malformed" {
                assert!(
                    !stderr.contains("PRIVATE_TOKEN_DO_NOT_LOG")
                        && !stderr.contains('π')
                        && !stderr.contains('🧪'),
                    "persistent diagnostic leaked a private request value: {stderr}"
                );
                let diagnostic = stderr
                    .lines()
                    .find(|line| line.starts_with("Native connection failed:"))
                    .expect("protocol failure category");
                let column = diagnostic
                    .strip_prefix("Native connection failed: protocol (Data, line 1, column ")
                    .and_then(|value| value.strip_suffix(')'))
                    .and_then(|value| value.parse::<usize>().ok());
                assert!(
                    column.is_some_and(|column| column > 0),
                    "malformed request lost safe parser category/position: {stderr}"
                );
            } else {
                assert!(
                    stderr.contains("Native connection failed: event delivery"),
                    "live delivery failure lost its payload-free category ({case}): {stderr}"
                );
            }
            assert_eq!(
                stderr.contains("Native terminal delivery failed"),
                case == "live-mailbox-closed",
                "delivery diagnostic did not distinguish a live unavailable mailbox from retirement: {stderr}"
            );
        }
    }
}

#[test]
fn markdown_renders_native_elements_and_unfinished_fences() {
    let store = Store::new();
    let mut app = App::with_ui(
        &store.0,
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("dist/tests/bridge.js"),
        )
        .unwrap(),
    );
    let markdown = "# Small heading\n\nA **bold** and *italic* paragraph with `code` and [link](https://example.com).\n\n- First\n- Second\n\n3. Third\n4. Fourth\n\n> Quote\n\n---\n\n<script>literal</script>\n\n```python\nprint(1)";
    app.host.send("markdown:text", markdown).unwrap();
    app.wait(|doc| support::text(doc, "markdown").contains("print(1)"));
    for selector in [
        "h3",
        "strong",
        "em",
        "p code",
        "ul li",
        "ol li",
        "blockquote",
        "hr",
        "pre code",
        ".underline",
    ] {
        assert!(
            app.doc()
                .inner()
                .query_selector(selector)
                .unwrap()
                .is_some(),
            "{selector}"
        );
    }
    assert!(
        app.doc()
            .inner()
            .query_selector("script")
            .unwrap()
            .is_none()
    );
    let code = |doc: &NativeDocument| {
        let inner = doc.inner();
        let id = inner.query_selector("pre code").unwrap().unwrap();
        inner.get_node(id).unwrap().text_content()
    };
    assert_eq!(code(app.doc()), "print(1)");
    let paragraph = app
        .doc()
        .inner()
        .query_selector("#markdown p")
        .unwrap()
        .unwrap();
    for suffix in ["\nprint(2)\n`", "\nprint(2)\n``", "\nprint(2)\n```"] {
        app.host
            .send("markdown:text", format!("{markdown}{suffix}"))
            .unwrap();
        let expected = if suffix.ends_with("```") {
            "print(1)\nprint(2)".to_owned()
        } else {
            format!("print(1){suffix}")
        };
        app.wait(|doc| code(doc) == expected);
        // The growing block is rebuilt (Blitz would keep its old layout);
        // finished blocks before it keep their nodes.
        assert_eq!(
            app.doc().inner().query_selector("#markdown p").unwrap(),
            Some(paragraph)
        );
        assert!(app.doc_mut().take_error().is_none());
    }
    app.host
        .send(
            "markdown:text",
            format!("{markdown}\nprint(2)\n```\n\nAfter"),
        )
        .unwrap();
    app.wait(|doc| support::text(doc, "markdown").contains("After"));
    assert_eq!(code(app.doc()), "print(1)\nprint(2)");
    app.host
        .send(
            "markdown:text",
            "Entities: &amp; &lt; &copy; &#65; &#x1F600; `&amp;`",
        )
        .unwrap();
    app.wait(|doc| support::text(doc, "markdown").contains("Entities:"));
    assert!(support::text(app.doc(), "markdown").contains("Entities: & < © A 😀 &amp;"));
    let nested = format!("{}x", "> ".repeat(1000));
    app.host.send("markdown:text", nested).unwrap();
    app.wait(|doc| support::text(doc, "markdown").contains('x'));
    assert!(app.doc_mut().take_error().is_none());
}

#[test]
fn tool_renderer_missing_shows_line_and_expands() {
    let store = Store::new();
    let mut app = App::with_ui(
        &store.0,
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("dist/tests/bridge.js"),
        )
        .unwrap(),
    );
    // A different plugin cannot claim Record's renderer type.
    app.host.send("tool:renderer", "other").unwrap();
    app.wait(|doc| support::text(doc, "tool-message").contains("Created a task in Record"));
    assert!(
        support::text(app.doc(), "tool-message").contains("Before toolCreated a task in Record")
    );
    let button = app
        .doc()
        .inner()
        .query_selector("#tool-message button")
        .unwrap()
        .unwrap();
    click(app.doc_mut(), button);
    app.wait(|doc| support::text(doc, "tool-message").contains("Buy milk"));
    let text = support::text(app.doc(), "tool-message");
    assert!(text.contains("\n  \"args\": {"));
    assert!(text.contains("record-one"));
    assert!(text.ends_with("After tool"));
}

#[test]
fn tool_renderer_mounts_with_part_and_thread_id() {
    let store = Store::new();
    let mut app = App::with_ui(
        &store.0,
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("dist/tests/bridge.js"),
        )
        .unwrap(),
    );
    app.host.send("tool:renderer", "record").unwrap();
    app.wait(|doc| doc.inner().get_element_by_id("tool-card-props").is_some());
    let props: Value = serde_json::from_str(&support::text(app.doc(), "tool-card-props")).unwrap();
    assert_eq!(props["threadId"], "thread-one");
    assert_eq!(props["part"]["callId"], "call-one");
    assert_eq!(props["part"]["result"]["id"], "record-one");
    assert!(!support::text(app.doc(), "tool-message").contains("Created a task in Record›"));
}

#[test]
fn tool_plugin_uninstalled_falls_back_to_line() {
    let store = Store::new();
    let mut app = App::with_ui(
        &store.0,
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("dist/tests/bridge.js"),
        )
        .unwrap(),
    );
    app.host.send("tool:renderer", "record").unwrap();
    app.wait(|doc| doc.inner().get_element_by_id("tool-card-props").is_some());
    app.host.send("tool:renderer", "").unwrap();
    app.wait(|doc| doc.inner().get_element_by_id("tool-card-props").is_none());
    assert!(support::text(app.doc(), "tool-message").contains("Created a task in Record"));
}

#[test]
fn permission_row_and_needs_you_group() {
    let store = Store::new();
    let mut app = App::with_ui(
        &store.0,
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("dist/tests/bridge.js"),
        )
        .unwrap(),
    );
    app.wait(|doc| support::text(doc, "permission-fixture").contains("NEEDS YOU"));
    let text = support::text(app.doc(), "permission-fixture");
    assert!(text.contains("Run commandAllow onceReject"));
    let map = support::text(app.doc(), "chat-map");
    assert!(map.find("NEEDS YOU").unwrap() < map.find("RUNNING").unwrap());
    assert!(map.find("Waiting thread").unwrap() < map.find("Running thread").unwrap());
    app.click("permission-fixture", "Details for pending.create");
    let text = support::text(app.doc(), "permission-fixture");
    assert!(
        text.contains("NEEDS YOU")
            && text.contains(&format!(
                "{{\n  \"args\": {{\n    \"title\": \"{}\",\n    \"target\": \"consequential\\u001b target\"\n  }}\n}}",
                "x".repeat(250)
            ))
    );
    let allow = app
        .doc()
        .inner()
        .query_selector("#permission-fixture [data-permission] button")
        .unwrap()
        .unwrap();
    click(app.doc_mut(), allow);
    app.wait(|doc| !support::text(doc, "permission-fixture").contains("NEEDS YOU"));
    assert!(support::text(app.doc(), "permission-fixture").contains("Run commandAllow once"));
    assert!(
        app.doc()
            .inner()
            .query_selector("#permission-fixture [data-permission] button")
            .unwrap()
            .is_none()
    );
}
