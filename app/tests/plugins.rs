//! Public plugin builder -> independent server -> production socket bridge ->
//! one QuickJS/Blitz shell. Storage and build outputs belong to this test only.
#[path = "../../packages/runtime/src/client/connection.rs"]
mod socket;
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;

use blitz_dom::{Document, Namespace, QualName};
use blitz_traits::shell::Viewport;
use render::{HostMailbox, NativeDocument};
use serde_json::Value;
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
        let child = Command::new(binary())
            .arg("--local-dir")
            .arg(&directory)
            .arg("--plugins")
            .arg(scratch.0.join("installation"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
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
                "plugin server exited before readiness"
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
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let connection = runtime.block_on(socket::connect(directory)).unwrap();
        let (send, receiver) = socket::admission();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let mut doc = NativeDocument::new_connected(
            &std::fs::read_to_string(bundle.join("shell.html")).unwrap(),
            &std::fs::read_to_string(bundle.join("ui.js")).unwrap(),
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
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let doc = self.doc.as_mut().unwrap();
            self.mailbox.drain(doc).unwrap();
            assert!(doc.take_error().is_none(), "uncaught native plugin error");
            if check(doc) {
                return;
            }
            if Instant::now() >= deadline {
                let requests = self.requests.lock().unwrap().clone();
                panic!("plugin workflow timeout: {}\nrequests: {requests:?}", support::text(doc, "app"));
            }
            std::thread::sleep(Duration::from_millis(2));
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
                eprintln!("button {label} node {id} rect {rect:?} hit {:?}", doc.inner().hit((rect.x + rect.width / 2.0) as f32, (rect.y + rect.height / 2.0) as f32));
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

// Prevents duplicate renderer IDs/Solid state, eager UI fetches, and treating
// backend dependencies as UI imports. The imported component must really react.
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
            .filter(|r| r["type"] == "pluginasset")
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

// Prevents reload notices being lost in the socket bridge, stale transitive
// importers, and UI remounts dropping or duplicating the live server subscription.
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
    assert_eq!(subscriptions.len(), 1);
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

// Prevents one crashing contribution from taking down navigation or healthy
// plugins, and locks the shell's chat/thread/plugin history into one window.
#[test]
fn contribution_failure_keeps_navigation_and_route_history_working() {
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
        parts.click("id", "thread-route");
        assert_eq!(support::text(parts.doc(), "route"), "/chat/thread-one");
    }
    let mut window = Window::open(&service.directory);
    window.wait(|doc| support::text(doc, "app").contains("Broken"));
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
    window.wait(|doc| support::text(doc, "app").contains("/chat/thread-one"));
    assert!(!support::text(window.doc(), "app").contains("View not found"));
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
    window.wait(|doc| {
        !support::text(doc, "app").contains("/p/")
            && !support::text(doc, "app").contains("View not found")
    });
}

// Prevents the actual launcher regressing to --bundle or a compatibility Todo
// fixture. Discovery and rendering must use plugins/todo in the real shell.
#[test]
fn launcher_starts_plugin_mode_and_real_todo_renders() {
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
            .any(|p| p["plugin"]["id"] == "todo")
    );
    let mut window = Window::open(&service.directory);
    window.wait(|doc| support::text(doc, "app").contains("Todo"));
    window.view("todo/Todo");
    window.wait(|doc| doc.inner().get_element_by_id("first-add").is_some());
    window.wait(|doc| !support::text(doc, "app").contains("Loading tasks"));
    assert!(support::text(window.doc(), "app").contains("Tokamak · Todo"));
}
