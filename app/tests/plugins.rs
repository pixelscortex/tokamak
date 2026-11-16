//! Public plugin builder -> independent server -> production socket bridge ->
//! one QuickJS/Blitz shell. Storage and build outputs belong to this test only.
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;

use blitz_dom::{Document, Namespace, QualName};
use blitz_traits::shell::Viewport;
use render::{HostMailbox, NativeDocument};
use runtime::client::connection as socket;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}
fn binary() -> PathBuf {
    root().join("target/debug/tokamak")
}
fn success(command: &mut Command) -> String {
    let output = command
        .env_remove("NODE_REPL_TOOL_OVERRIDES")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = root().join(format!(
            "app/dist/tests/plugins-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn build(&self, action: &str) {
        success(
            Command::new("proto")
                .current_dir(root())
                .args(["run", "bun", "--", "app/tests/plugin-fixtures.mjs"])
                .arg(self.0.join("installation"))
                .arg(action),
        );
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Service {
    child: Option<Child>,
    directory: PathBuf,
}
impl Service {
    fn start(scratch: &Scratch) -> Self {
        let directory = scratch.0.join("server");
        std::fs::create_dir_all(&directory).unwrap();
        let token = directory.join("server.token");
        std::fs::write(&token, "a".repeat(64)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(token, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let log = std::fs::File::create(directory.join("server.log")).unwrap();
        let mut command = Command::new(binary());
        command
            .arg("--local-dir")
            .arg(&directory)
            .arg("--plugins")
            .arg(scratch.0.join("installation"));
        let child = command
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap();
        let mut service = Self {
            child: Some(child),
            directory,
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while !service.directory.join("server.json").exists() {
            assert!(
                service
                    .child
                    .as_mut()
                    .unwrap()
                    .try_wait()
                    .unwrap()
                    .is_none(),
                "plugin server exited before readiness:\n{}",
                std::fs::read_to_string(service.directory.join("server.log")).unwrap()
            );
            assert!(
                Instant::now() < deadline,
                "plugin server readiness deadline"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        service
    }
    fn cli(&self, args: &[&str]) -> String {
        success(
            Command::new(binary())
                .env("TOKAMAK_SERVER_DIR", &self.directory)
                .args(args),
        )
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            if let Some(status) = child.try_wait().unwrap() {
                eprintln!(
                    "plugin server exited: {status}\n{}",
                    std::fs::read_to_string(self.directory.join("server.log")).unwrap()
                );
            }
            let _ = child.kill();
            let _ = child.wait();
        } else {
            // The launcher owns its detached child; request its normal shutdown.
            success(
                Command::new("proto")
                    .current_dir(root())
                    .env("TOKAMAK_SERVER_DIR", &self.directory)
                    .args([
                        "run",
                        "bun",
                        "--",
                        "packages/runtime/tools/run-app.ts",
                        "stop",
                        "debug",
                    ]),
            );
        }
    }
}
struct Window {
    doc: Option<NativeDocument>,
    mailbox: HostMailbox,
    requests: Arc<Mutex<Vec<Value>>>,
    stop: Option<oneshot::Sender<()>>,
    worker: Option<tokio::task::JoinHandle<()>>,
    runtime: tokio::runtime::Runtime,
}
impl Window {
    fn open(directory: &Path) -> Self {
        Self::with_ui(directory, &root().join("app/dist"))
    }
    fn with_ui(directory: &Path, bundle: &Path) -> Self {
        let runtime = Self::runtime();
        let connection = runtime.block_on(socket::connect(directory)).unwrap();
        Self::attach(runtime, connection, bundle)
    }
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    }
    fn attach(
        runtime: tokio::runtime::Runtime,
        connection: tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        bundle: &Path,
    ) -> Self {
        let (send, receiver) = socket::admission();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let mut doc = NativeDocument::new_connected_with_fonts(
            // The product hides the switcher and history (shell-frame.tsx);
            // these tests drive plugin views and routes through them.
            &std::fs::read_to_string(bundle.join("shell.html"))
                .unwrap()
                .replace("<body>", "<body data-dev-nav>"),
            &std::fs::read_to_string(bundle.join("ui.js")).unwrap(),
            Some(Box::new(move |message| {
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(&message).unwrap());
                send(message)
            })),
            &[
                include_bytes!("../assets/fonts/SpaceGrotesk-Variable.ttf"),
                include_bytes!("../assets/fonts/SpaceMono-Regular.ttf"),
            ],
        )
        .unwrap();
        doc.inner_mut().set_viewport(Viewport {
            window_size: (1500, 1800),
            ..Default::default()
        });
        let (host, mailbox) = HostMailbox::new(&doc, || {});
        let (ready, receive) = oneshot::channel();
        ready.send(host).ok().unwrap();
        let (stop, stopped) = oneshot::channel();
        let worker = runtime.spawn(socket::serve(connection, receiver, receive, stopped));
        Self {
            doc: Some(doc),
            mailbox,
            requests,
            stop: Some(stop),
            worker: Some(worker),
            runtime,
        }
    }
    fn doc(&self) -> &NativeDocument {
        self.doc.as_ref().unwrap()
    }
    fn wait(&mut self, check: impl Fn(&NativeDocument) -> bool) {
        self.wait_with(Duration::from_secs(10), Duration::from_millis(2), check);
    }
    /// Large transfers (hundreds of plugins, 100 MB of UI) take many ordered
    /// round trips, so they poll faster and allow a longer overall deadline.
    fn wait_with(
        &mut self,
        timeout: Duration,
        poll: Duration,
        check: impl Fn(&NativeDocument) -> bool,
    ) {
        let deadline = Instant::now() + timeout;
        loop {
            let doc = self.doc.as_mut().unwrap();
            self.mailbox.drain(doc).unwrap();
            let error = doc.take_error();
            assert!(error.is_none(), "uncaught native plugin error: {error:?}");
            if check(doc) {
                return;
            }
            if Instant::now() >= deadline {
                let requests = self.requests.lock().unwrap().len();
                panic!(
                    "plugin workflow timeout after {timeout:?}: {}\nrequests sent: {requests}; last: {:?}",
                    support::text(doc, "app")
                        .chars()
                        .take(2000)
                        .collect::<String>(),
                    self.requests
                        .lock()
                        .unwrap()
                        .iter()
                        .rev()
                        .take(5)
                        .collect::<Vec<_>>()
                );
            }
            std::thread::sleep(poll);
        }
    }
    fn click(&mut self, attribute: &str, value: &str) {
        let doc = self.doc.as_mut().unwrap();
        let mut pending = vec![support::id(doc, "app")];
        let mut target = None;
        while let Some(id) = pending.pop() {
            let inner = doc.inner();
            let node = inner.get_node(id).unwrap();
            if node.element_data().is_some_and(|element| {
                element.attr(QualName::new(None, Namespace::from(""), attribute.into()).local)
                    == Some(value)
            }) {
                target = Some(id);
                break;
            }
            pending.extend(node.children.iter().copied());
        }
        let target = target.unwrap_or_else(|| {
            panic!("missing {attribute}={value}: {}", support::text(doc, "app"))
        });
        support::pointer_node(doc, target);
    }
    fn view(&mut self, name: &str) {
        self.click("data-plugin-view", name);
    }
    fn click_text(&mut self, label: &str) {
        let doc = self.doc.as_mut().unwrap();
        let mut pending = vec![support::id(doc, "app")];
        while let Some(id) = pending.pop() {
            let inner = doc.inner();
            let node = inner.get_node(id).unwrap();
            if node
                .element_data()
                .is_some_and(|e| &*e.name.local == "button")
                && node.text_content() == label
            {
                drop(inner);
                doc.inner_mut().resolve(0.0);
                let rect = doc.inner().get_client_bounding_rect(id).unwrap();
                // H: Native pointer delivery starts with Blitz hit testing.
                // An inline formatting box here made Reload visually present
                // but impossible to click at the button's centre.
                let hit = doc.inner().hit(
                    (rect.x + rect.width / 2.0) as f32,
                    (rect.y + rect.height / 2.0) as f32,
                );
                assert_eq!(
                    hit.map(|hit| hit.node_id),
                    Some(id),
                    "{label} centre must hit its button: {rect:?}"
                );
                support::pointer_node(doc, id);
                return;
            }
            pending.extend(node.children.iter().copied());
        }
        panic!("missing button {label}");
    }
    fn assets(&self, plugin: &str) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["type"] == "pluginasset" && r["plugin"] == plugin)
            .count()
    }
    /// Wire `subscribe` requests for one backend function (matched by suffix).
    fn subscriptions_to(&self, function: &str) -> usize {
        self.subscriptions()
            .iter()
            .filter(|r| {
                r["name"]
                    .as_str()
                    .is_some_and(|name| name.ends_with(function))
            })
            .count()
    }
    fn subscriptions(&self) -> Vec<Value> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["type"] == "subscribe")
            .cloned()
            .collect()
    }
}
impl Drop for Window {
    fn drop(&mut self) {
        drop(self.doc.take());
        let _ = self.stop.take().unwrap().send(());
        self.runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(8), self.worker.take().unwrap())
                .await
                .unwrap()
                .unwrap();
        });
    }
}

// Behaviours 1, 3, 4, 5. Prevents duplicate renderer IDs/Solid state (one shared
// runtime), eager UI fetches on connect (laziness), and treating backend
// dependencies as UI imports (logic-only plugins). The imported component from
// another plugin must really react.
#[test]
fn shared_runtime_lazy_components_and_logic_only_backend() {
    let scratch = Scratch::new();
    scratch.build("initial");
    let service = Service::start(&scratch);
    let mut window = Window::open(&service.directory);
    window.wait(|doc| support::text(doc, "app").contains("Consumer"));
    assert_eq!(
        window
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["type"] == "pluginasset" && r["plugin"] != "chat")
            .count(),
        0
    );
    window.view("consumer/Consumer");
    window.wait(|doc| {
        doc.inner()
            .get_element_by_id("live-data")
            .is_some_and(|_| support::text(doc, "live-data") == "[]")
    });
    window.click("id", "shared-increment");
    assert_eq!(
        support::text(window.doc(), "shared-increment"),
        "library-before: 1"
    );
    assert_eq!(
        support::text(window.doc(), "shared-observer"),
        "observed: 1"
    );
    assert_eq!(support::text(window.doc(), "local-increment"), "local: 10");
    window.click("id", "local-increment");
    assert_eq!(support::text(window.doc(), "local-increment"), "local: 11");
    assert_eq!(
        support::text(window.doc(), "shared-observer"),
        "observed: 1"
    );
    window.click("id", "add-row");
    window.wait(|doc| support::text(doc, "live-data").contains("live-row"));
    assert!(window.assets("consumer") > 0 && window.assets("library") > 0);
    assert_eq!(window.assets("logic"), 0);
    assert_eq!(window.assets("dormant"), 0);
}

// Behaviour 7 (live reload). Prevents reload notices being lost in the socket
// bridge, stale transitive importers, and UI remounts dropping or duplicating the
// live server subscription.
#[test]
fn cli_reload_updates_open_importers_and_preserves_live_subscription() {
    let scratch = Scratch::new();
    scratch.build("initial");
    let service = Service::start(&scratch);
    let mut window = Window::open(&service.directory);
    window.wait(|doc| support::text(doc, "app").contains("Consumer"));
    window.view("consumer/Consumer");
    window.wait(|doc| {
        doc.inner()
            .get_element_by_id("live-data")
            .is_some_and(|_| support::text(doc, "live-data") == "[]")
    });
    let subscriptions = window.subscriptions();
    assert_eq!(window.subscriptions_to("record:list"), 1);
    let consumer_assets = window.assets("consumer");
    scratch.build("reload");
    service.cli(&["plugin", "reload", "library"]);
    window.wait(|doc| support::text(doc, "app").contains("library-after: 0"));
    assert!(
        window.assets("consumer") > consumer_assets,
        "dependent UI was not fetched again"
    );
    assert_eq!(
        window.subscriptions(),
        subscriptions,
        "reload replaced the underlying subscription"
    );
    assert!(
        !window
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["type"] == "unsubscribe")
    );
    window.click("id", "add-row");
    window.wait(|doc| support::text(doc, "live-data").contains("live-row"));
    assert_eq!(window.assets("dormant"), 0);
}

// Behaviours 6 and 8 (failure isolation, Reload, router back/forward). Prevents
// one crashing contribution from taking down navigation or healthy plugins, and
// locks the shell's chat/thread/plugin history into one window.
#[test]
fn contribution_failure_keeps_navigation_and_route_history_working() {
    // The zen strip omits the pathname. Assert the mounted chat's route instead,
    // so history still distinguishes /chat from /chat/:thread.
    let at_chat = |doc: &NativeDocument, path: &str| {
        doc.inner()
            .query_selector(&format!("[data-chat-route='{path}']"))
            .unwrap()
            .is_some()
    };
    let scratch = Scratch::new();
    scratch.build("initial");
    scratch.build("parts-host");
    let service = Service::start(&scratch);
    {
        let mut parts = Window::with_ui(
            &service.directory,
            &scratch.0.join("installation/parts-host/dist"),
        );
        parts.wait(|doc| {
            support::text(doc, "app").contains("broken failed")
                && doc.inner().get_element_by_id("shared-increment").is_some()
        });
        parts.click("id", "shared-increment");
        assert_eq!(support::text(parts.doc(), "shared-observer"), "observed: 1");
        assert!(support::text(parts.doc(), "app").contains("broken failed"));
        // 6: Clearing the external failure condition and clicking Reload must
        // recover the failed slot while the already-mounted sibling survives.
        parts.click_text("Reload");
        parts.wait(|doc| doc.inner().get_element_by_id("recovered").is_some());
        assert_eq!(support::text(parts.doc(), "shared-observer"), "observed: 1");
        parts.click("id", "shared-increment");
        assert_eq!(support::text(parts.doc(), "shared-observer"), "observed: 2");
        parts.click("id", "thread-route");
        assert_eq!(support::text(parts.doc(), "route"), "/chat/thread-one");
    }
    let mut window = Window::open(&service.directory);
    window.wait(|doc| support::text(doc, "app").contains("Broken"));
    window.wait(|doc| at_chat(doc, "/chat"));
    window.view("broken/Broken");
    window.wait(|doc| support::text(doc, "app").contains("broken failed"));
    assert!(support::text(window.doc(), "app").contains("Reload"));
    let before = window.assets("broken");
    window.click_text("Reload");
    let requests = window.requests.clone();
    window.wait(|doc| {
        support::text(doc, "app").contains("broken failed")
            && requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r["type"] == "pluginasset" && r["plugin"] == "broken")
                .count()
                > before
    });
    window.view("consumer/Consumer");
    window.wait(|doc| doc.inner().get_element_by_id("thread-route").is_some());
    window.click("id", "thread-route");
    window.wait(|doc| at_chat(doc, "/chat/thread-one"));
    assert!(!support::text(window.doc(), "app").contains("View not found"));
    window.click("aria-label", "Go back");
    window.wait(|doc| doc.inner().get_element_by_id("nested-route").is_some());
    window.click("aria-label", "Go forward");
    window.wait(|doc| at_chat(doc, "/chat/thread-one"));
    window.click("aria-label", "Go back");
    window.wait(|doc| doc.inner().get_element_by_id("nested-route").is_some());
    window.click("id", "nested-route");
    window.wait(|doc| doc.inner().get_element_by_id("nested").is_some());
    window.click("aria-label", "Go back");
    window.wait(|doc| doc.inner().get_element_by_id("shared-increment").is_some());
    window.click("aria-label", "Go forward");
    window.wait(|doc| doc.inner().get_element_by_id("nested").is_some());
    window.click("aria-label", "Go back");
    window.click("aria-label", "Go back");
    window.wait(|doc| support::text(doc, "app").contains("broken failed"));
    window.click("aria-label", "Go back");
    window.wait(|doc| at_chat(doc, "/chat"));
    window.click("aria-label", "Go forward");
    window.wait(|doc| support::text(doc, "app").contains("broken failed"));
    window.click("aria-label", "Go back");
    window.wait(|doc| at_chat(doc, "/chat"));
}

// Behaviour 9 (launcher). Prevents the actual launcher regressing to --bundle or
// a compatibility fixture. Discovery and rendering must use plugins/chat in
// the real shell.
#[test]
fn launcher_starts_plugin_mode_and_chat_renders() {
    let scratch = Scratch::new();
    let service = Service {
        child: None,
        directory: scratch.0.join("launcher"),
    };
    success(
        Command::new("proto")
            .current_dir(root())
            .env("TOKAMAK_SERVER_DIR", &service.directory)
            .args([
                "run",
                "bun",
                "--",
                "packages/runtime/tools/run-app.ts",
                "start",
                "debug",
            ]),
    );
    let identity: Value =
        serde_json::from_slice(&std::fs::read(service.directory.join("server.json")).unwrap())
            .unwrap();
    assert_eq!(
        PathBuf::from(
            identity["pluginRoot"]
                .as_str()
                .expect("launcher must use --plugins")
        ),
        root().join("plugins").canonicalize().unwrap()
    );
    let listed: Value = serde_json::from_str(&service.cli(&["plugin", "list"])).unwrap();
    assert!(
        listed["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["plugin"]["id"] == "chat")
    );
    let mut window = Window::open(&service.directory);
    window.wait(|doc| doc.inner().get_element_by_id("chat-input").is_some());
}

// 10A / no product caps: 500 installed plugins must install, page through the
// bounded 8 KiB catalog transfer, and render as 500 switcher entries. The old 64
// plugin ceiling (and any later count quota) would fail installation or leave
// the window disconnected before its first contribution could open. Nothing
// in a lazy catalog may fetch UI: only the one opened plugin is downloaded.
#[test]
fn catalog_of_500_plugins_installs_pages_and_renders_lazily() {
    const COUNT: usize = 500;
    let scratch = Scratch::new();
    scratch.build(&format!("catalog-{COUNT}"));
    let service = Service::start(&scratch);
    let listed: Value = serde_json::from_str(&service.cli(&["plugin", "list"])).unwrap();
    assert_eq!(listed["plugins"].as_array().unwrap().len(), COUNT);
    let mut window = Window::open(&service.directory);
    window.wait_with(Duration::from_secs(60), Duration::from_millis(2), |doc| {
        support::text(doc, "app").matches("Catalog").count() == COUNT
    });
    let requests = window.requests.lock().unwrap().clone();
    assert!(
        !requests.iter().any(|r| r["type"] == "pluginasset"),
        "connecting fetched UI assets"
    );
    let pages = requests
        .iter()
        .filter(|r| r["type"] == "pluginspage")
        .count();
    assert!(
        pages >= 2,
        "500 manifests arrived in {pages} continuation pages"
    );
    window.view("catalog-499/Catalog");
    window.wait(|doc| doc.inner().get_element_by_id("catalog-view").is_some());
    let fetched: std::collections::BTreeSet<_> = window
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r["type"] == "pluginasset")
        .map(|r| r["plugin"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(fetched, ["catalog-499".to_owned()].into());
}

// Behaviour 10A (100 KB result, oversized result). Large successful results and
// isolated oversized failures share the same real socket/native connection; an
// oversized result must fail only its own operation, and ended subscriptions must
// release SDK slots.
#[test]
fn large_query_and_oversized_operations_do_not_poison_the_connection() {
    let scratch = Scratch::new();
    scratch.build("payload");
    scratch.build("parts-host");
    let service = Service::start(&scratch);
    let mut window = Window::with_ui(
        &service.directory,
        &scratch.0.join("installation/parts-host/dist"),
    );
    window.wait(|doc| doc.inner().get_element_by_id("payload-run").is_some());
    window.click("id", "payload-run");
    window.wait(|doc| support::text(doc, "payload-status") != "idle");
    let status = support::text(window.doc(), "payload-status");
    assert!(status.starts_with("100000:"), "{status}");
    assert!(status.contains("result too large"), "{status}");
    assert!(status.ends_with(":130:xxxxxxx"), "{status}");
    assert_eq!(window.subscriptions().len(), 130);
}

// Behaviour 11B (unrelated reload keeps view state). A catalog update for B must retain A's Solid owner and native input,
// and must not waste asset requests for a module that was already live.
#[test]
fn unrelated_reload_preserves_open_input_and_does_not_refetch_its_assets() {
    let scratch = Scratch::new();
    scratch.build("initial");
    let service = Service::start(&scratch);
    let mut window = Window::open(&service.directory);
    window.wait(|doc| support::text(doc, "app").contains("Consumer"));
    window.view("consumer/Consumer");
    window.wait(|doc| doc.inner().get_element_by_id("local-input").is_some());
    let doc = window.doc.as_mut().unwrap();
    support::pointer(doc, "local-input");
    for key in ["k", "e", "e", "p"] {
        support::key(doc, key, false, false);
    }
    assert_eq!(support::editor(doc, "local-input"), "keep");
    let assets = window.assets("consumer");
    // Broken and Consumer both import Library, but neither imports the other.
    scratch.build("unrelated-reload");
    service.cli(&["plugin", "reload", "broken"]);
    // The new rail descriptor proves the refreshed catalog was published.
    window.wait(|doc| support::text(doc, "app").contains("Updated"));
    window.click("id", "add-row");
    window.wait(|doc| support::text(doc, "live-data").contains("live-row"));
    assert_eq!(support::editor(window.doc(), "local-input"), "keep");
    assert_eq!(window.assets("consumer"), assets);
}

// Behaviour 12C (error routing). Failures belong to the registering contribution/module, even when a
// sibling is mounted and the throw happens outside its render computation.
#[test]
fn event_detached_async_reactive_and_factory_errors_stay_in_their_own_slots() {
    let scratch = Scratch::new();
    scratch.build("errors");
    scratch.build("parts-host");
    let service = Service::start(&scratch);
    let mut window = Window::with_ui(
        &service.directory,
        &scratch.0.join("installation/parts-host/dist"),
    );
    window.wait(|doc| {
        ["event", "async", "effect", "factory"].iter().all(|kind| {
            doc.inner()
                .get_element_by_id(&format!("throw-{kind}"))
                .is_some()
        }) && doc.inner().get_element_by_id("shared-increment").is_some()
    });
    for (index, kind) in ["event", "async", "effect", "factory"].iter().enumerate() {
        window.click("id", &format!("throw-{kind}"));
        window.wait(|doc| support::text(doc, "app").contains(&format!("error-{kind} failed")));
        window.click("id", "shared-increment");
        assert_eq!(
            support::text(window.doc(), "shared-increment"),
            format!("library-before: {}", index + 1)
        );
        assert!(!support::text(window.doc(), "app").contains("healthy failed"));
    }
}

// Behaviour 13D (scoped registration, retired handles after a REAL reload).
// Evaluated plugin code gets only its own generation capability. A reload
// must invalidate old handles and clear module-owned state, keeping hosts safe.
#[test]
fn scoped_registry_rejects_overrides_and_retired_handles_and_resets_state() {
    let scratch = Scratch::new();
    scratch.build("guards");
    let service = Service::start(&scratch);
    let mut window = Window::open(&service.directory);
    window.wait(|doc| support::text(doc, "app").contains("Guard"));
    window.view("guard/Guard");
    window.wait(|doc| doc.inner().get_element_by_id("guard-probe").is_some());
    window.click("id", "guard-probe");
    window.wait(|doc| support::text(doc, "guard-status") != "ready");
    assert_eq!(
        support::text(window.doc(), "guard-status"),
        "@plugins/vault/ui,solid-js,@tokamak/sdk:current"
    );
    window.click("id", "guard-count");
    assert_eq!(support::text(window.doc(), "guard-count"), "state: 1");
    let before = window.assets("guard");
    // An unchanged artifact reloads as a no-op and emits no change notice, so
    // the old handle would never be retired. Publish different code first.
    scratch.build("guards-reload");
    service.cli(&["plugin", "reload", "guard"]);
    let requests = window.requests.clone();
    window.wait(|doc| {
        doc.inner().get_element_by_id("guard-status").is_some()
            && support::text(doc, "guard-status") == "ready"
            && requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r["type"] == "pluginasset" && r["plugin"] == "guard")
                .count()
                > before
    });
    assert_eq!(support::text(window.doc(), "guard-count"), "state: 0");
    window.click("id", "guard-probe");
    window.wait(|doc| support::text(doc, "guard-status") != "ready");
    assert!(
        support::text(window.doc(), "guard-status")
            .contains("Retired plugin module: @plugins/guard/ui")
    );
}

// Behaviour 14E (literal dynamic import). A literal await import must execute through the native lazy loader. The
// optional module is fetched only on interaction and its shared signal reacts.
#[test]
fn literal_dynamic_import_runs_lazily_in_quickjs() {
    let scratch = Scratch::new();
    scratch.build("lazy");
    let service = Service::start(&scratch);
    let mut window = Window::open(&service.directory);
    window.wait(|doc| support::text(doc, "app").contains("Lazy"));
    window.view("lazy/Lazy");
    window.wait(|doc| doc.inner().get_element_by_id("lazy-load").is_some());
    assert_eq!(window.assets("library"), 0);
    window.click("id", "lazy-load");
    window.wait(|doc| doc.inner().get_element_by_id("shared-increment").is_some());
    window.click("id", "shared-increment");
    assert_eq!(
        support::text(window.doc(), "shared-increment"),
        "library-before: 1"
    );
    assert!(window.assets("library") > 0);
}

// Newer fix (af15087): inclusive wire limit. The serialized response event {"type":"response",
// "id":N,"result":{"Ok":"..."}} may be exactly 1 MiB and must be delivered through
// the server, socket and native mailbox. One more byte is a clean, correlated
// error, and the connection keeps working. Counting the native routing
// envelope against the limit (or reserving headroom for it) rejects the
// exactly-full event; no limit at all would deliver the +1 byte one.
#[test]
fn event_of_exactly_the_wire_limit_is_delivered_and_one_more_byte_is_rejected() {
    const LIMIT: usize = 1024 * 1024;
    let scratch = Scratch::new();
    scratch.build("payload");
    scratch.build("parts-host");
    let service = Service::start(&scratch);
    let mut window = Window::with_ui(
        &service.directory,
        &scratch.0.join("installation/parts-host/dist"),
    );
    window.wait(|doc| doc.inner().get_element_by_id("boundary-run").is_some());
    window.click("id", "boundary-run");
    window.wait_with(Duration::from_secs(30), Duration::from_millis(2), |doc| {
        support::text(doc, "boundary-status") != "idle"
    });
    let status = support::text(window.doc(), "boundary-status");
    assert!(
        !status.starts_with("FAILED"),
        "boundary page failed: {status}"
    );
    // The wire size depends on the digits of the correlation id, so derive the
    // exact event sizes from the requests the page really sent.
    let event_size = |id: u64, size: u64| {
        serde_json::to_string(&json!({
            "type": "response", "id": id, "result": { "Ok": "x".repeat(size as usize) }
        }))
        .unwrap()
        .len()
    };
    let queries: Vec<(u64, u64)> = window
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r["type"] == "query")
        .map(|r| {
            (
                r["id"].as_u64().unwrap(),
                r["args"]["size"].as_u64().unwrap(),
            )
        })
        .collect();
    let full = queries
        .iter()
        .find(|(_, size)| *size == (LIMIT - 47) as u64)
        .unwrap();
    let over = queries
        .iter()
        .find(|(_, size)| *size == (LIMIT - 46) as u64)
        .unwrap();
    assert_eq!(
        event_size(full.0, full.1),
        LIMIT,
        "fixture no longer builds a full event"
    );
    assert_eq!(
        event_size(over.0, over.1),
        LIMIT + 1,
        "fixture no longer builds a +1 event"
    );
    assert!(
        status.starts_with(&format!("{}|", LIMIT - 47)),
        "the full-size event was not delivered intact: {status}"
    );
    assert!(status.contains("result too large"), "{status}");
    assert!(
        status.ends_with("|xxxxxxx"),
        "connection unusable after rejection: {status}"
    );
}

// Newer fix (eaa2802): terminal subscription errors. A subscription whose result grows past the wire limit ends with a terminal
// "result too large" error. The window's query cache must then forget it, so the
// error card's Reload opens a genuinely new wire subscription. If the cache
// kept the dead entry, Reload would replay the stale error forever without ever
// asking the server again, even after the data shrank.
#[test]
fn oversized_subscription_error_then_reload_resubscribes_for_real() {
    let scratch = Scratch::new();
    scratch.build("growth");
    scratch.build("parts-host");
    let service = Service::start(&scratch);
    let mut window = Window::with_ui(
        &service.directory,
        &scratch.0.join("installation/parts-host/dist"),
    );
    window.wait(|doc| {
        doc.inner().get_element_by_id("growth-grow").is_some()
            && doc
                .inner()
                .get_element_by_id("growth-rows")
                .is_some_and(|_| support::text(doc, "growth-rows") == "rows:0")
    });
    assert_eq!(window.subscriptions_to("ops:all"), 1);
    // One 600 KB row fits; the second pushes the live result past 1 MiB.
    window.click("id", "growth-grow");
    window.wait(|doc| support::text(doc, "growth-log") == "grown");
    assert!(support::text(window.doc(), "growth-rows") == "rows:1");
    window.click("id", "growth-grow");
    window.wait(|doc| support::text(doc, "app").contains("growth-view failed"));
    assert_eq!(
        window.subscriptions_to("ops:all"),
        1,
        "failure must not resubscribe by itself"
    );
    // Make the data small again and wait for the commit before reloading, so a
    // successful resubscription is distinguishable from a replayed error.
    window.click("id", "growth-clear");
    window.wait(|doc| support::text(doc, "growth-log") == "cleared");
    window.click_text("Reload");
    window.wait(|doc| {
        doc.inner()
            .get_element_by_id("growth-rows")
            .is_some_and(|_| support::text(doc, "growth-rows") == "rows:0")
    });
    assert_eq!(
        window.subscriptions_to("ops:all"),
        2,
        "Reload replayed the cached terminal error instead of subscribing again"
    );
    assert!(!support::text(window.doc(), "app").contains("failed"));
}

// Restores TOKAMAK_UI_HEAP_BYTES even if the test panics.
struct HeapCeiling;
impl HeapCeiling {
    fn set(bytes: usize) -> Self {
        // SAFETY: the plugin tests run with --test-threads=1, and the variable
        // is set before this test creates the window that reads it.
        unsafe { std::env::set_var("TOKAMAK_UI_HEAP_BYTES", bytes.to_string()) };
        Self
    }
}
impl Drop for HeapCeiling {
    fn drop(&mut self) {
        // SAFETY: as in `set`; no other test thread is running.
        unsafe { std::env::remove_var("TOKAMAK_UI_HEAP_BYTES") };
    }
}

// Newer fix (5b73c29): the UI heap ceiling. With no product quota, one runaway
// plugin sharing the window heap could exhaust the machine. With a low ceiling
// (here 32 MiB) the runaway must get a clean QuickJS out-of-memory error inside
// its OWN error card, while the window, its other plugins and the runaway's
// sibling contribution keep working, and Reload recovers the heap. Without a
// ceiling nothing but the 250 ms turn deadline stops the loop (the test fails
// with that deadline error); the fixture's ~1.5 GB valve protects the machine.
#[test]
fn runaway_plugin_hits_the_ui_heap_ceiling_and_the_window_survives() {
    let scratch = Scratch::new();
    scratch.build("heap");
    scratch.build("parts-host");
    let service = Service::start(&scratch);
    let _ceiling = HeapCeiling::set(32 * 1024 * 1024);
    let mut window = Window::with_ui(
        &service.directory,
        &scratch.0.join("installation/parts-host/dist"),
    );
    window.wait(|doc| {
        doc.inner().get_element_by_id("hog-run").is_some()
            && doc.inner().get_element_by_id("shared-increment").is_some()
    });
    window.click("id", "shared-increment");
    assert_eq!(
        support::text(window.doc(), "shared-increment"),
        "library-before: 1"
    );
    for round in 1..=2 {
        window.click("id", "hog-run");
        window.wait_with(Duration::from_secs(60), Duration::from_millis(5), |doc| {
            support::text(doc, "app").contains("hog failed")
        });
        let report = support::text(window.doc(), "hog-report");
        assert!(report.contains("out of memory"), "round {round}: {report}");
        // Neighbours are untouched and the window still handles input.
        assert!(!support::text(window.doc(), "app").contains("healthy failed"));
        window.click("id", "shared-increment");
        assert_eq!(
            support::text(window.doc(), "shared-increment"),
            format!("library-before: {}", round + 1)
        );
        // Reload recovers the plugin; the freed heap lets it run (and fail) again.
        window.click_text("Reload");
        window.wait(|doc| doc.inner().get_element_by_id("hog-run").is_some());
    }
}

// Newer fix (db0e526, no product caps). SLOW (tens of seconds): a 100 MB declared UI asset is 12,000+ ordered 8 KiB
// pages. No per-asset ceiling and no 64 MiB window heap may refuse it, and every
// UTF-8 character split across a page boundary must reassemble. The view
// compares the downloaded text with an independently built copy, so any lost,
// duplicated or reordered chunk fails.
#[test]
fn hundred_megabyte_ui_asset_streams_in_pages_with_matching_contents() {
    let scratch = Scratch::new();
    scratch.build("bulk");
    scratch.build("parts-host");
    let service = Service::start(&scratch);
    let mut window = Window::with_ui(
        &service.directory,
        &scratch.0.join("installation/parts-host/dist"),
    );
    window.wait(|doc| doc.inner().get_element_by_id("bulk-run").is_some());
    window.click("id", "bulk-run");
    window.wait_with(
        Duration::from_secs(300),
        Duration::from_micros(100),
        |doc| support::text(doc, "bulk-status") != "idle",
    );
    // 9,090,910 repetitions of a 6-UTF-16-unit, 11-UTF-8-byte pattern.
    assert_eq!(
        support::text(window.doc(), "bulk-status"),
        "intact:54545460"
    );
    let pages = window
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r["type"] == "pluginasset" && r["plugin"] == "bulk" && r["name"] == "ui.js.map")
        .count();
    assert!(
        pages >= 100_000_000 / 8192,
        "asset arrived in only {pages} pages"
    );
}

#[path = "support/capture.rs"]
mod capture;

// Default: an offline backend error. Opt in to the real provider/captures
// with TOKAMAK_CHAT_LIVE=1 and TK_CAPTURE_DIR; adapters reuse CLI logins.
// The agent runs in a disposable working folder.
#[test]
fn chat_screen_socket_workflow() {
    use blitz_traits::events::*;
    use keyboard_types::{Code, Key, Location, Modifiers, NamedKey};

    fn key(window: &mut Window, key: Key, meta: bool) {
        modified_key(
            window,
            key,
            if meta {
                Modifiers::META
            } else {
                Modifiers::empty()
            },
        );
    }
    fn modified_key(window: &mut Window, key: Key, modifiers: Modifiers) {
        window.doc.as_mut().unwrap().resolve_layout(0.0);
        window
            .doc
            .as_mut()
            .unwrap()
            .handle_ui_event(UiEvent::KeyDown(BlitzKeyEvent {
                key,
                code: Code::Unidentified,
                text: None,
                modifiers,
                location: Location::Standard,
                is_auto_repeating: false,
                is_composing: false,
                state: KeyState::Pressed,
            }));
        window.doc.as_mut().unwrap().resolve_layout(0.0);
    }
    fn type_text(window: &mut Window, text: &str) {
        window
            .doc
            .as_mut()
            .unwrap()
            .handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit(text.into())));
    }
    fn call(service: &Service, kind: &str, name: &str, args: Value) -> Value {
        use futures_util::{SinkExt, StreamExt};
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let mut socket = socket::connect(&service.directory).await.unwrap();
                socket
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        json!({"type": kind, "id": 1, "name": name, "args": args})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                loop {
                    let message = socket.next().await.unwrap().unwrap();
                    let event: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                    if event["type"] == "response" && event["id"] == 1 {
                        assert!(event["result"].get("Err").is_none(), "{event}");
                        return event["result"]["Ok"].clone();
                    }
                }
            })
    }
    fn selected(window: &Window) -> String {
        support::attr(window.doc(), "chat-screen", "data-thread-id").unwrap()
    }

    fn scroll(window: &mut Window, delta: f64) {
        support::pointer(window.doc.as_mut().unwrap(), "chat-messages");
        window
            .doc
            .as_mut()
            .unwrap()
            .handle_ui_event(UiEvent::Wheel(BlitzWheelEvent {
                delta: BlitzWheelDelta::Pixels(0.0, delta),
                coords: PointerCoords {
                    page_x: 300.0,
                    page_y: 300.0,
                    screen_x: 300.0,
                    screen_y: 300.0,
                    client_x: 300.0,
                    client_y: 300.0,
                },
                buttons: MouseEventButtons::None,
                mods: Modifiers::empty(),
                element: Default::default(),
            }));
        window.doc.as_mut().unwrap().resolve_layout(0.0);
    }
    fn position(doc: &NativeDocument) -> (f64, f64) {
        let inner = doc.inner();
        let node = inner
            .get_node(inner.get_element_by_id("chat-messages").unwrap())
            .unwrap();
        (
            node.scroll_offset().y,
            node.final_layout().scroll_height() as f64,
        )
    }
    fn at_bottom(doc: &NativeDocument) -> bool {
        let (top, bottom) = position(doc);
        (top - bottom).abs() <= 2.0
    }

    let live = std::env::var("TOKAMAK_CHAT_LIVE").as_deref() == Ok("1");
    let scratch = Scratch::new();
    let plugin = scratch.0.join("installation/chat/dist");
    std::fs::create_dir_all(&plugin).unwrap();
    for id in ["chat", "acp"] {
        let destination = scratch.0.join(format!("installation/{id}/dist"));
        std::fs::create_dir_all(&destination).unwrap();
        for file in [
            "manifest.json",
            "bundle.js",
            "bundle.js.map",
            "worker.js",
            "worker.js.map",
            "worker-entry.js",
            "api.ts",
            "ui.js",
            "ui.js.map",
            "shell.html",
            "styles.css",
        ] {
            if !root()
                .join(format!("plugins/{id}/dist"))
                .join(file)
                .exists()
            {
                continue;
            }
            std::fs::copy(
                root().join(format!("plugins/{id}/dist")).join(file),
                destination.join(file),
            )
            .unwrap();
        }
    }
    let quickstart = live && std::env::var("TOKAMAK_CHAT_QUICKSTART").as_deref() == Ok("1");
    if quickstart {
        let record = scratch.0.join("installation/record/dist");
        std::fs::create_dir_all(&record).unwrap();
        for file in [
            "manifest.json",
            "bundle.js",
            "bundle.js.map",
            "api.ts",
            "ui.js",
            "ui.js.map",
            "shell.html",
            "styles.css",
        ] {
            std::fs::copy(
                root().join("app/tests/fixtures/record/dist").join(file),
                record.join(file),
            )
            .unwrap();
        }
    }
    std::fs::create_dir_all(scratch.0.join("server")).unwrap();
    if live {
        std::fs::create_dir_all(scratch.0.join("workspace")).unwrap();
    } else {
        // Keep the native offline fixture independent of installed adapters.
        // It exercises the same backend contract through ordinary SDK actions.
        success(
            Command::new("bun")
                .arg("-e")
                .arg(
                    r#"
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root = process.argv[1];
const manifest = JSON.parse(readFileSync(root + '/manifest.json', 'utf8'));
let source = readFileSync(root + '/worker.js', 'utf8');
for (const command of ['claude-agent-acp', 'codex-acp']) {
  const pattern = `command: "${command}"`;
  if (!source.includes(pattern)) throw new Error('Offline adapter command missing: ' + command);
  source = source.replaceAll(pattern, 'command: "/usr/bin/false"');
}
source = source.replaceAll('command: "gemini"', 'command: "/missing-tokamak-agent"');
writeFileSync(root + '/worker.js', source);
manifest.hashes['worker.js'] = createHash('sha256').update(source).digest('hex');
writeFileSync(root + '/manifest.json', JSON.stringify(manifest));
"#,
                )
                .arg(scratch.0.join("installation/acp/dist")),
        );
    }
    fn configure_live_thread(service: &Service, thread: &str, cwd: &Path) {
        let options = call(service, "action", "chat/backends:list", json!({}));
        let backend = options
            .as_array()
            .and_then(|options| options.first())
            .expect("Install claude-agent-acp or codex-acp for live chat tests");
        let settings = call(
            service,
            "action",
            "chat/backends:configure",
            json!({
                "plugin": backend["plugin"], "backendId": backend["id"], "settings": {"cwd": cwd}
            }),
        );
        call(
            service,
            "mutation",
            "chat/threads:setBackend",
            json!({
                "threadId": thread, "backend": {"kind": "plugin", "plugin": backend["plugin"],
                    "backendId": backend["id"], "settings": settings}
            }),
        );
    }
    let service = Service::start(&scratch);
    if quickstart {
        let catalog: Value = serde_json::from_str(&service.cli(&["plugin", "list"])).unwrap();
        for id in ["chat", "record"] {
            assert!(
                catalog["plugins"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|plugin| plugin["plugin"]["id"] == id)
            );
        }
    }
    let mut window = Window::open(&service.directory);
    window
        .doc
        .as_mut()
        .unwrap()
        .inner_mut()
        .set_viewport(Viewport {
            window_size: (680, 820),
            ..Default::default()
        });
    window.wait(|doc| doc.inner().get_element_by_id("chat-screen").is_some());
    window.wait(|doc| support::attr(doc, "chat-screen", "data-thread-id").is_some());
    if live {
        configure_live_thread(&service, &selected(&window), &scratch.0.join("workspace"));
    }
    let body = window
        .doc()
        .inner()
        .query_selector("body")
        .unwrap()
        .unwrap();
    window
        .doc
        .as_mut()
        .unwrap()
        .inner_mut()
        .mutate()
        .clear_attribute(
            body,
            QualName::new(None, Namespace::from(""), "data-dev-nav".into()),
        );
    window.doc.as_mut().unwrap().resolve_layout(0.0);
    key(&mut window, Key::Named(NamedKey::Tab), false);
    assert!(window.doc().inner().get_element_by_id("chat-map").is_some());
    key(&mut window, Key::Named(NamedKey::Escape), false);
    if quickstart {
        support::pointer(window.doc.as_mut().unwrap(), "chat-input");
        type_text(&mut window, "Say hello in one short sentence.");
        key(&mut window, Key::Named(NamedKey::Enter), false);
        window.wait_with(Duration::from_secs(90), Duration::from_millis(10), |doc| {
            doc.inner()
                .query_selector("[data-role=assistant][data-status=complete]")
                .unwrap()
                .is_some()
        });
        let messages = call(
            &service,
            "query",
            "chat/messages:list",
            json!({"threadId": selected(&window)}),
        );
        let reply = messages.as_array().unwrap().last().unwrap();
        assert_eq!(reply["role"], "assistant");
        assert!(reply["parts"].as_array().unwrap().iter().any(|part| {
            part["type"] == "text"
                && part["text"]
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty())
        }));
        if let Ok(directory) = std::env::var("TK_CAPTURE_DIR") {
            capture::save(
                window.doc.as_mut().unwrap(),
                &Path::new(&directory).join("quickstart.png"),
            );
        }
        println!(
            "Quick start: Chat and Record loaded; native composer sent a message and rendered a live reply."
        );
        return;
    }
    if live {
        support::pointer(window.doc.as_mut().unwrap(), "chat-input");
        type_text(
            &mut window,
            "Give me a short markdown list and a 3-line Python code block",
        );
        key(&mut window, Key::Named(NamedKey::Enter), false);
        window.wait_with(Duration::from_secs(90), Duration::from_millis(10), |doc| {
            doc.inner()
                .query_selector("[data-role=assistant][data-status=complete] pre code")
                .unwrap()
                .is_some()
        });
        assert!(
            window
                .doc()
                .inner()
                .query_selector("[data-role=assistant] li")
                .unwrap()
                .is_some()
        );
        if let Ok(directory) = std::env::var("TK_CAPTURE_DIR") {
            capture::save(
                window.doc.as_mut().unwrap(),
                &Path::new(&directory).join("markdown.png"),
            );
        }

        let thread = selected(&window);
        call(
            &service,
            "mutation",
            "chat/send:start",
            json!({"threadId": thread, "text": "Simulated interrupted reply", "token": "fixture-turn-token"}),
        );
        drop(window);
        // No action owns this persisted run. A fresh launch starts observing it.
        window = Window::open(&service.directory);
        window
            .doc
            .as_mut()
            .unwrap()
            .inner_mut()
            .set_viewport(Viewport {
                window_size: (680, 820),
                ..Default::default()
            });
        window.wait_with(Duration::from_secs(90), Duration::from_millis(10), |doc| {
            doc.inner().get_element_by_id("chat-messages").is_some()
                && support::text(doc, "chat-messages").contains("Interrupted")
        });
        assert!(
            call(&service, "query", "chat/runs:running", json!({}))
                .as_array()
                .unwrap()
                .is_empty()
        );
        support::pointer(window.doc.as_mut().unwrap(), "chat-input");
        type_text(&mut window, "Reply with one word: Recovered");
        key(&mut window, Key::Named(NamedKey::Enter), false);
        window.wait_with(Duration::from_secs(90), Duration::from_millis(10), |_| {
            let messages = call(
                &service,
                "query",
                "chat/messages:list",
                json!({"threadId": thread}),
            );
            messages.as_array().unwrap().last().is_some_and(|message| {
                message["role"] == "assistant" && message["status"] == "complete"
            })
        });
        window.wait(|doc| {
            doc.inner()
                .query_selector("[data-status=streaming]")
                .unwrap()
                .is_none()
        });
        if let Ok(directory) = std::env::var("TK_CAPTURE_DIR") {
            capture::save(
                window.doc.as_mut().unwrap(),
                &Path::new(&directory).join("recovery.png"),
            );
        }
        println!("Interrupted run cleared after reopening; same thread completed another reply.");
        key(&mut window, Key::Character("n".into()), true);
        window.wait(|doc| {
            support::attr(doc, "chat-screen", "data-thread-id").is_some_and(|id| id != thread)
        });
    }
    if live {
        configure_live_thread(&service, &selected(&window), &scratch.0.join("workspace"));
    }
    let first = selected(&window);
    support::pointer(window.doc.as_mut().unwrap(), "chat-input");
    let prompt = if live {
        "Print exactly 60 numbered lines, each saying: A quiet line of text. No introduction."
    } else {
        "Say hello in five words"
    };
    type_text(&mut window, "   ");
    key(&mut window, Key::Named(NamedKey::Enter), false);
    assert_eq!(support::editor(window.doc(), "chat-input"), "   ");
    key(&mut window, Key::Character("a".into()), true);
    type_text(&mut window, prompt);
    modified_key(&mut window, Key::Named(NamedKey::Enter), Modifiers::SHIFT);
    type_text(&mut window, "Please.");
    assert!(support::editor(window.doc(), "chat-input").contains("\nPlease."));
    key(&mut window, Key::Named(NamedKey::Enter), false);
    window.wait(|doc| support::text(doc, "chat-messages").contains(prompt));

    if live {
        let mut previous = String::new();
        let mut grew = false;
        let mut paused: Option<(f64, f64)> = None;
        let mut resumed = false;
        let deadline = Instant::now() + Duration::from_secs(90);
        while Instant::now() < deadline {
            window.mailbox.drain(window.doc.as_mut().unwrap()).unwrap();
            window.doc.as_mut().unwrap().resolve_layout(0.0);
            let doc = window.doc();
            assert!(
                doc.inner()
                    .query_selector("[data-status=error]")
                    .unwrap()
                    .is_none(),
                "{}",
                support::text(doc, "chat-messages")
            );
            let streaming = doc
                .inner()
                .query_selector("[data-status=streaming]")
                .unwrap();
            if let Some(id) = streaming {
                let text = doc.inner().get_node(id).unwrap().text_content();
                if text != previous && !text.trim_start().starts_with('·') {
                    grew = true;
                    let (top, bottom) = position(window.doc());
                    if let Some((held_top, held_bottom)) = paused {
                        assert!(
                            (top - held_top).abs() <= 2.0,
                            "streaming moved a paused conversation"
                        );
                        if bottom > held_bottom + 40.0 {
                            scroll(&mut window, -10000.0);
                            assert!(
                                at_bottom(window.doc()),
                                "scrolling to the bottom must resume following"
                            );
                            paused = None;
                            resumed = true;
                        }
                    } else {
                        assert!(
                            at_bottom(window.doc()),
                            "streaming must follow the newest content"
                        );
                        if bottom > 180.0 && !resumed {
                            for _ in 0..240 {
                                scroll(&mut window, 0.5);
                            }
                            let (held_top, held_bottom) = position(window.doc());
                            assert!(
                                held_top < top - 40.0,
                                "wheel must scroll up: {top} -> {held_top}, bottom {held_bottom}"
                            );
                            paused = Some((held_top, held_bottom));
                        }
                    }
                    previous = text;
                }
            } else if grew {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(grew, "no assistant text arrived while streaming");
        assert!(resumed, "reply must grow after scrolling up and resuming");
        window.wait(|doc| {
            doc.inner()
                .query_selector("[data-status=streaming]")
                .unwrap()
                .is_none()
        });
        window.doc.as_mut().unwrap().resolve_layout(0.0);
        let scroller = window
            .doc()
            .inner()
            .get_element_by_id("chat-messages")
            .unwrap();
        let inner = window.doc().inner();
        let node = inner.get_node(scroller).unwrap();
        assert!(
            node.final_layout().scroll_height() > 500.0,
            "long reply must overflow"
        );
        drop(inner);
        assert!(
            at_bottom(window.doc()),
            "completed long reply must end at the bottom: {:?}",
            position(window.doc())
        );
        if let Ok(directory) = std::env::var("TK_CAPTURE_DIR") {
            capture::save(
                window.doc.as_mut().unwrap(),
                &Path::new(&directory).join("ux-autoscroll.png"),
            );
        }
        let messages = call(
            &service,
            "query",
            "chat/messages:list",
            json!({"threadId": first}),
        );
        let reply = messages.as_array().unwrap().last().unwrap()["parts"][0]["text"]
            .as_str()
            .unwrap()
            .to_owned();
        modified_key(
            &mut window,
            Key::Character("c".into()),
            Modifiers::META | Modifiers::SHIFT,
        );
        window.wait(|doc| support::text(doc, "chat-strip").contains("COPIED"));
        #[cfg(target_os = "macos")]
        {
            let output = std::process::Command::new("/usr/bin/pbpaste")
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(String::from_utf8(output.stdout).unwrap(), reply);
        }
        window.wait(|doc| !support::text(doc, "chat-strip").contains("COPIED"));
        support::pointer(window.doc.as_mut().unwrap(), "chat-input");
        type_text(
            &mut window,
            "Count from one to one hundred, one number per line.",
        );
        key(&mut window, Key::Named(NamedKey::Enter), false);
        window.wait(|doc| {
            doc.inner()
                .query_selector("[data-status=streaming]")
                .unwrap()
                .is_some()
        });
        let sends = || {
            window
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.to_string().contains("chat:send"))
                .count()
        };
        let before = sends();
        type_text(&mut window, "draft during run");
        key(&mut window, Key::Named(NamedKey::Enter), false);
        assert_eq!(
            support::editor(window.doc(), "chat-input"),
            "draft during run"
        );
        assert_eq!(
            window
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.to_string().contains("chat:send"))
                .count(),
            before
        );
        key(&mut window, Key::Character("a".into()), true);
        window
            .doc
            .as_mut()
            .unwrap()
            .handle_ui_event(UiEvent::AppleStandardKeybinding("deleteBackward:".into()));
        assert_eq!(support::editor(window.doc(), "chat-input"), "");
        key(&mut window, Key::Named(NamedKey::Tab), false);
        window.wait(|doc| support::text(doc, "chat-map").contains("RUNNING"));
        key(&mut window, Key::Named(NamedKey::Escape), false);
        key(&mut window, Key::Named(NamedKey::Escape), false);
        window.wait(|doc| {
            doc.inner()
                .query_selector("[data-status=cancelled]")
                .unwrap()
                .is_some()
        });
        assert!(support::text(window.doc(), "chat-messages").contains("Stopped"));
    } else {
        window.wait(|doc| {
            doc.inner()
                .query_selector("[data-status=error]")
                .unwrap()
                .is_some()
        });
    }

    if !live {
        let history = support::text(window.doc(), "chat-messages");
        key(&mut window, Key::Character("m".into()), true);
        window.wait(|doc| support::text(doc, "backend-picker").contains("codex"));
        let picker = support::text(window.doc(), "backend-picker");
        assert!(picker.contains("claude"));
        assert_eq!(
            picker
                .matches("An agent can do anything its CLI can in this folder.")
                .count(),
            1
        );
        if let Ok(directory) = std::env::var("TK_CAPTURE_DIR") {
            capture::save(
                window.doc.as_mut().unwrap(),
                &Path::new(&directory).join("backend-picker.png"),
            );
        }
        key(&mut window, Key::Named(NamedKey::Enter), false);
        window.wait(|doc| doc.inner().get_element_by_id("backend-folder").is_some());
        type_text(&mut window, "relative");
        key(&mut window, Key::Named(NamedKey::Enter), false);
        window.wait(|doc| support::text(doc, "backend-picker").contains("absolute path"));
        for path in ["/tmp/tokamak-missing-folder/child", "/dev/null"] {
            key(&mut window, Key::Character("a".into()), true);
            type_text(&mut window, path);
            key(&mut window, Key::Named(NamedKey::Enter), false);
            window.wait(|doc| support::text(doc, "backend-picker").contains("does not exist"));
            assert!(
                !window
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|request| request["name"] == "chat/threads:setBackend")
            );
            assert_eq!(support::text(window.doc(), "chat-messages"), history);
        }
        key(&mut window, Key::Character("a".into()), true);
        let cwd = root().canonicalize().unwrap().to_str().unwrap().to_owned();
        type_text(&mut window, &cwd);
        key(&mut window, Key::Named(NamedKey::Enter), false);
        window.wait(|doc| doc.inner().get_element_by_id("backend-picker").is_none());
        window.wait(|doc| support::text(doc, "chat-strip").contains("claude"));
        assert!(
            window
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|request| request["name"] == "chat/threads:setBackend"
                    && request["args"]["backend"]
                        == json!({"kind":"plugin", "plugin":"acp", "backendId":"claude", "settings":{"cwd":cwd}}))
        );
        assert_eq!(support::text(window.doc(), "chat-messages"), history);
        key(&mut window, Key::Character("m".into()), true);
        window.wait(|doc| doc.inner().get_element_by_id("backend-choice-0").is_some());
        window.click("id", "backend-choice-0");
        window.wait(|doc| doc.inner().get_element_by_id("backend-folder").is_some());
        window.doc.as_mut().unwrap().resolve_layout(0.0);
        assert_eq!(support::editor(window.doc(), "backend-folder"), cwd);
        key(&mut window, Key::Named(NamedKey::Escape), false);
        assert_eq!(support::text(window.doc(), "chat-messages"), history);
    }

    type_text(&mut window, "draft to keep");
    key(&mut window, Key::Named(NamedKey::Tab), false);
    assert!(window.doc().inner().get_element_by_id("chat-map").is_some());
    type_text(&mut window, "Plan ");
    key(&mut window, Key::Character("2".into()), false);
    assert!(window.doc().inner().get_element_by_id("chat-map").is_some());
    assert_eq!(support::editor(window.doc(), "chat-input"), "Plan 2");
    type_text(&mut window, "026");
    assert!(support::text(window.doc(), "chat-map").contains("No threads found"));
    key(&mut window, Key::Named(NamedKey::Escape), false);
    assert_eq!(support::editor(window.doc(), "chat-input"), "draft to keep");
    key(&mut window, Key::Named(NamedKey::Tab), false);
    key(&mut window, Key::Character("r".into()), false);
    assert!(
        window
            .doc()
            .inner()
            .get_element_by_id("chat-rename")
            .is_some()
    );
    key(&mut window, Key::Named(NamedKey::Enter), true);
    window.wait(|doc| {
        support::attr(doc, "chat-screen", "data-thread-id").is_some_and(|id| id != first)
    });
    let second = selected(&window);
    window.wait(|doc| doc.inner().get_element_by_id("chat-map").is_none());
    assert!(
        window
            .doc()
            .inner()
            .get_element_by_id("chat-rename")
            .is_none()
    );
    assert!(
        window
            .doc()
            .inner()
            .get_element_by_id("chat-input")
            .is_some()
    );
    key(&mut window, Key::Named(NamedKey::Tab), false);
    window.wait(|doc| support::text(doc, "chat-map").contains("New thread"));
    if let Ok(directory) = std::env::var("TK_CAPTURE_DIR") {
        capture::save(
            window.doc.as_mut().unwrap(),
            &Path::new(&directory).join("map-open.png"),
        );
    }
    key(&mut window, Key::Named(NamedKey::ArrowDown), false);
    key(&mut window, Key::Named(NamedKey::Enter), false);
    assert_eq!(selected(&window), first);
    window.doc.as_mut().unwrap().resolve_layout(0.0);
    if live {
        window.wait(|doc| support::text(doc, "chat-messages").contains("Stopped"));
        window.doc.as_mut().unwrap().resolve_layout(0.0);
        assert!(position(window.doc()).1 > 500.0);
        assert!(
            at_bottom(window.doc()),
            "reopening an older thread must show its end"
        );
    }
    assert_eq!(support::editor(window.doc(), "chat-input"), "draft to keep");
    key(&mut window, Key::Named(NamedKey::Tab), false);
    key(&mut window, Key::Character("1".into()), false);
    assert_eq!(selected(&window), second);
    assert_eq!(support::editor(window.doc(), "chat-input"), "");
    key(&mut window, Key::Named(NamedKey::Tab), false);
    window.click("data-thread", &first);
    window.doc.as_mut().unwrap().resolve_layout(0.0);
    type_text(&mut window, " + click");
    let edited = support::editor(window.doc(), "chat-input");
    assert!(edited.contains("draft to keep") && edited.contains(" + click"));
    if !live {
        key(&mut window, Key::Character("m".into()), true);
        window.wait(|doc| doc.inner().get_element_by_id("backend-choice-0").is_some());
        window.click("id", "backend-choice-0");
        window.wait(|doc| doc.inner().get_element_by_id("backend-folder").is_some());
    }
    key(&mut window, Key::Character("n".into()), true);
    window.wait(|doc| {
        support::attr(doc, "chat-screen", "data-thread-id")
            .is_some_and(|id| id != first && id != second)
    });
    assert!(
        window
            .doc()
            .inner()
            .get_element_by_id("backend-picker")
            .is_none()
            && window
                .doc()
                .inner()
                .get_element_by_id("chat-input")
                .is_some(),
        "changing threads must close the picker and restore the composer"
    );
    // Rename persists, and Escape cancels editing without leaving Map.
    key(&mut window, Key::Named(NamedKey::Tab), false);
    let row = format!("[data-thread='{}']", selected(&window));
    window.wait(|doc| doc.inner().query_selector(&row).unwrap().is_some());
    key(&mut window, Key::Character("r".into()), false);
    window.doc.as_mut().unwrap().resolve_layout(0.0);
    key(&mut window, Key::Character("a".into()), true);
    type_text(
        &mut window,
        "Daily notes with a deliberately long title that must leave room for the agent and turn count in the composer strip",
    );
    if let Ok(directory) = std::env::var("TK_CAPTURE_DIR") {
        capture::save(
            window.doc.as_mut().unwrap(),
            &Path::new(&directory).join("ux-map-rename.png"),
        );
    }
    key(&mut window, Key::Named(NamedKey::Enter), false);
    window.wait(|doc| {
        doc.inner().get_element_by_id("chat-rename").is_none()
            && support::text(doc, "chat-map").contains("Daily notes")
    });
    key(&mut window, Key::Character("r".into()), false);
    key(&mut window, Key::Named(NamedKey::Escape), false);
    assert!(support::text(window.doc(), "chat-map").contains("Daily notes"));
    key(&mut window, Key::Named(NamedKey::Escape), false);
    window.doc.as_mut().unwrap().resolve_layout(0.0);
    assert!(
        support::text(window.doc(), "chat-strip").contains('…'),
        "long title needs a visible ellipsis"
    );
    {
        let inner = window.doc().inner();
        let title = inner.get_element_by_id("chat-strip-title").unwrap();
        let agent = inner.get_element_by_id("chat-strip-agent").unwrap();
        let title = inner.get_client_bounding_rect(title).unwrap();
        let agent = inner.get_client_bounding_rect(agent).unwrap();
        assert!(
            title.x + title.width <= agent.x,
            "title must leave room for agent and turns"
        );
    }

    key(&mut window, Key::Character("m".into()), true);
    if live {
        window.wait(|doc| doc.inner().get_element_by_id("backend-choice-0").is_some());
    } else {
        window.wait(|doc| support::text(doc, "chat-screen").contains("codex"));
        key(&mut window, Key::Named(NamedKey::ArrowDown), false);
    }
    key(&mut window, Key::Named(NamedKey::Enter), false);
    window.wait(|doc| doc.inner().get_element_by_id("backend-folder").is_some());
    key(&mut window, Key::Character("a".into()), true);
    let cwd = if live {
        scratch.0.join("workspace")
    } else {
        root().canonicalize().unwrap()
    };
    type_text(&mut window, cwd.to_str().unwrap());
    key(&mut window, Key::Named(NamedKey::Enter), false);
    window.wait(|doc| doc.inner().get_element_by_id("backend-picker").is_none());
    support::pointer(window.doc.as_mut().unwrap(), "chat-input");
    type_text(&mut window, "Say hello in five words");
    key(&mut window, Key::Named(NamedKey::Enter), false);
    window.wait_with(Duration::from_secs(90), Duration::from_millis(10), |doc| {
        let status = if live {
            "[data-status=complete][data-role=assistant]"
        } else {
            "[data-status=error]"
        };
        doc.inner().query_selector(status).unwrap().is_some()
    });

    key(&mut window, Key::Named(NamedKey::Tab), false);
    type_text(&mut window, "Daily");
    window
        .doc
        .as_mut()
        .unwrap()
        .handle_ui_event(UiEvent::AppleStandardKeybinding(
            "deleteToBeginningOfLine:".into(),
        ));
    assert_eq!(support::editor(window.doc(), "chat-input"), "Daily");
    key(&mut window, Key::Named(NamedKey::Backspace), true);
    assert!(support::text(window.doc(), "chat-map").contains("Delete? Enter / Esc"));
    key(&mut window, Key::Named(NamedKey::Escape), false);
    assert!(support::text(window.doc(), "chat-map").contains("Daily notes"));
    key(&mut window, Key::Named(NamedKey::Backspace), true);
    key(&mut window, Key::Named(NamedKey::Enter), false);
    window.wait(|doc| !support::text(doc, "chat-map").contains("Daily notes"));

    assert_eq!(window.subscriptions_to("threads:list"), 1);
    assert_eq!(window.subscriptions_to("runs:running"), 1);
    assert_eq!(window.subscriptions_to("runs:active"), 0);
}

// Plugin-owned chat state outlives its view, and its shortcut works from a sibling view.
#[test]
fn chat_session_and_global_shortcut_survive_navigation() {
    use blitz_traits::events::{BlitzKeyEvent, KeyState, UiEvent};
    use keyboard_types::{Code, Key, Location, Modifiers};
    let new_thread = |window: &mut Window| {
        window
            .doc
            .as_mut()
            .unwrap()
            .handle_ui_event(UiEvent::KeyDown(BlitzKeyEvent {
                key: Key::Character("n".into()),
                code: Code::KeyN,
                text: None,
                modifiers: Modifiers::META,
                location: Location::Standard,
                is_auto_repeating: false,
                is_composing: false,
                state: KeyState::Pressed,
            }));
    };
    let scratch = Scratch::new();
    scratch.build("initial");
    let service = Service::start(&scratch);
    let mut window = Window::open(&service.directory);
    window.wait(|doc| {
        doc.inner().get_element_by_id("chat-input").is_some()
            && support::attr(doc, "chat-screen", "data-thread-id").is_some()
    });
    // Select a newly created thread so resetting to the first thread cannot pass.
    support::pointer(window.doc.as_mut().unwrap(), "chat-input");
    new_thread(&mut window);
    let selected = support::attr(window.doc(), "chat-screen", "data-thread-id").unwrap();
    window.wait(|doc| {
        doc.inner().get_element_by_id("chat-screen").is_some()
            && support::attr(doc, "chat-screen", "data-thread-id").is_some_and(|id| id != selected)
    });
    let selected = support::attr(window.doc(), "chat-screen", "data-thread-id").unwrap();
    support::pointer(window.doc.as_mut().unwrap(), "chat-input");
    support::key(window.doc.as_mut().unwrap(), "k", false, false);
    window.view("consumer/Consumer");
    window.wait(|doc| doc.inner().get_element_by_id("local-input").is_some());
    window.view("chat/Chat");
    window.wait(|doc| doc.inner().get_element_by_id("chat-input").is_some());
    assert_eq!(
        support::attr(window.doc(), "chat-screen", "data-thread-id").unwrap(),
        selected
    );
    window.doc.as_mut().unwrap().resolve_layout(0.0);
    assert_eq!(support::editor(window.doc(), "chat-input"), "k");
    window.view("consumer/Consumer");
    window.wait(|doc| doc.inner().get_element_by_id("local-input").is_some());
    support::pointer(window.doc.as_mut().unwrap(), "local-input");
    new_thread(&mut window);
    window.wait(|doc| {
        doc.inner().get_element_by_id("chat-screen").is_some()
            && support::attr(doc, "chat-screen", "data-thread-id").is_some_and(|id| id != selected)
    });
    window.doc.as_mut().unwrap().resolve_layout(0.0);
    assert_eq!(support::editor(window.doc(), "chat-input"), "");
    assert_eq!(window.subscriptions_to("threads:list"), 1);
    assert_eq!(window.subscriptions_to("runs:running"), 1);
}

// The production shell discovers chat's view and all mods from manifests. A
// failed fill cannot retire its siblings, editor, or chat's data subscriptions.
#[test]
fn composer_extensions_load_reload_and_unload_without_forking_chat() {
    use blitz_traits::events::{BlitzKeyEvent, KeyState, UiEvent};
    use keyboard_types::{Code, Key, Location, Modifiers, NamedKey};
    let scratch = Scratch::new();
    scratch.build("composer-mod");
    let service = Service::start(&scratch);
    let mut window = Window::open(&service.directory);
    window.wait(|doc| {
        doc.inner().get_element_by_id("mod-frame").is_some()
            && doc.inner().get_element_by_id("mod-label").is_some()
            && doc.inner().get_element_by_id("mod-insert").is_some()
    });
    assert!(
        window.assets("chat") > 0,
        "chat UI must load from its plugin artifact"
    );
    assert!(!support::text(window.doc(), "app").contains("chat failed"));
    window.click("id", "mod-insert");
    window.doc.as_mut().unwrap().resolve_layout(0.0);
    assert_eq!(support::editor(window.doc(), "chat-input"), "mod text");
    assert!(
        window
            .doc()
            .inner()
            .get_element_by_id("mod-replacement")
            .is_some()
    );
    assert!(
        window
            .doc()
            .inner()
            .get_element_by_id("mod-ignored")
            .is_none()
    );
    // Insert at the beginning of distinct native text, rather than appending.
    support::pointer(window.doc.as_mut().unwrap(), "chat-input");
    window
        .doc
        .as_mut()
        .unwrap()
        .handle_ui_event(UiEvent::KeyDown(BlitzKeyEvent {
            key: Key::Named(NamedKey::End),
            code: Code::Unidentified,
            text: None,
            modifiers: Modifiers::empty(),
            location: Location::Standard,
            is_auto_repeating: false,
            is_composing: false,
            state: KeyState::Pressed,
        }));
    window.doc.as_mut().unwrap().handle_ui_event(UiEvent::Ime(
        blitz_traits::events::BlitzImeEvent::Commit(" tail".into()),
    ));
    window
        .doc
        .as_mut()
        .unwrap()
        .handle_ui_event(UiEvent::KeyDown(BlitzKeyEvent {
            key: Key::Named(NamedKey::Home),
            code: Code::Unidentified,
            text: None,
            modifiers: Modifiers::empty(),
            location: Location::Standard,
            is_auto_repeating: false,
            is_composing: false,
            state: KeyState::Pressed,
        }));
    window.doc.as_mut().unwrap().resolve_layout(0.0);
    window.click("id", "mod-insert");
    window.doc.as_mut().unwrap().resolve_layout(0.0);
    assert_eq!(
        support::editor(window.doc(), "chat-input"),
        "mod textmod text tail"
    );
    // Remove only the mod artifact; catalog reload retires its fills/wrapper live.
    std::fs::rename(
        scratch.0.join("installation/composer-mod"),
        scratch.0.join("disabled-composer-mod"),
    )
    .unwrap();
    service.cli(&["plugin", "reload", "composer-mod"]);
    window.wait(|doc| {
        doc.inner().get_element_by_id("mod-frame").is_none()
            && doc.inner().get_element_by_id("mod-label").is_none()
            && doc.inner().get_element_by_id("mod-insert").is_none()
    });
    assert!(
        window
            .doc()
            .inner()
            .get_element_by_id("chat-input")
            .is_some()
    );
    window.doc.as_mut().unwrap().resolve_layout(0.0);
    assert_eq!(
        support::editor(window.doc(), "chat-input"),
        "mod textmod text tail"
    );
    std::fs::rename(
        scratch.0.join("disabled-composer-mod"),
        scratch.0.join("installation/composer-mod"),
    )
    .unwrap();
    service.cli(&["plugin", "reload", "composer-mod"]);
    window.wait(|doc| doc.inner().get_element_by_id("mod-frame").is_some());
    assert_eq!(window.subscriptions_to("threads:list"), 1);
}
