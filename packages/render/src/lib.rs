//! Native Solid documents run QuickJS and Blitz on the window event-loop
//! thread. Host producers send owned JSON through a generation-scoped mailbox;
//! neither JS values nor native document references cross that boundary.
mod icon;
mod js;
mod mailbox;
mod shell;
mod surface;
mod wire;
use blitz_dom::{DocGuard, DocGuardMut, Document, EventDriver, EventHandler};
use blitz_html::HtmlDocument;
use blitz_traits::{NodeId, events::*};
pub use engine::MAX_WIRE_MESSAGE_BYTES;
use keyboard_types::{Key, Modifiers, NamedKey};
pub use mailbox::{HostMailbox, HostSender};
use serde::Deserialize;
use serde_json::{Value, json};
pub use shell::{
    TrafficLights, WindowOptions, launch, launch_connected, launch_window, launch_window_with,
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
#[cfg(feature = "surface-demo")]
pub use surface::MaterialShape;
/// Embedders that paint a document without `launch_window` (e.g. offscreen
/// rendering) must call this once per frame after `paint_scene`; see
/// `surface/frame.rs`.
pub use surface::end_frame as surface_end_frame;
/// Lab-only paint statistics (benchmark hooks), `surface-demo` feature.
#[cfg(feature = "surface-demo")]
#[doc(hidden)]
pub use surface::stats::{dirty_pixels as surface_dirty_pixels, paint_work as surface_paint_work};

#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// Thread-safe admission of owned messages only. Called synchronously on the UI
/// owner; implementations must be nonblocking and bound both bytes and count.
pub type MessageSender = Box<dyn Fn(String) -> Result<()> + Send + Sync>;

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

/// One independent document generation. Its JS heap and detached nodes are
/// retired together; old senders can never address a replacement document.
pub struct NativeDocument {
    html: HtmlDocument,
    bridge: Bridge,
    generation: u64,
    alive: Arc<AtomicBool>,
}

impl NativeDocument {
    pub fn new(shell: &str, bundle: &str) -> Result<Self> {
        Self::new_connected(shell, bundle, None)
    }

    pub fn new_connected(shell: &str, bundle: &str, send: Option<MessageSender>) -> Result<Self> {
        let mut html = HtmlDocument::from_html(shell, Default::default());
        // `<tk-surface>` element defaults (see surface/mod.rs).
        html.inner_mut()
            .add_user_agent_stylesheet(blitz_dom::UserAgentStylesheet::parse(surface::UA_CSS));
        let root = html
            .get_element_by_id("app")
            .ok_or_else(|| Error("Shell needs #app".into()))?;
        let alive = Arc::new(AtomicBool::new(true));
        let mut bridge = Bridge {
            js: js::Js::new(bundle, send)?,
            tree: wire::Tree::new(root),
            alive: alive.clone(),
            composition: Composition::Idle,
            space: None,
            error: None,
        };
        bridge.flush(&mut html)?;
        Ok(Self {
            html,
            bridge,
            generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
            alive,
        })
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Hand layout-bound shapes to `<tk-surface>` widgets (surface/bind.rs).
    /// Call after `resolve` and before painting; the window does this on
    /// every redraw. Does nothing when no member box or setting changed.
    pub fn layout_surfaces(&mut self) {
        self.bridge.tree.surfaces.bind(&self.html.inner());
    }

    /// Lab probe (surface-demo): the shapes the last layout pass handed to
    /// the `<tk-surface>` element `node`, with each shape's own material.
    #[cfg(feature = "surface-demo")]
    pub fn surface_shapes(&self, node: blitz_traits::NodeId) -> Vec<surface::MaterialShape> {
        self.bridge.tree.surfaces.shapes_of(node)
    }

    pub fn take_error(&mut self) -> Option<Error> {
        self.bridge.error.take()
    }

    /// Explicit generation check is also useful to embedders that own a mailbox.
    /// A closed window drops this document and invalidates all its senders.
    pub fn host_event(&mut self, generation: u64, topic: &str, payload: Value) -> Result<bool> {
        self.host_json(
            generation,
            &json!({"topic":topic,"payload":payload}).to_string(),
        )
    }

    // Mailbox envelopes are already serialized and size-checked on the producer.
    fn host_json(&mut self, generation: u64, json: &str) -> Result<bool> {
        if generation != self.generation {
            return Ok(false);
        }
        if !self.alive.load(Ordering::Acquire) {
            return Err(Error("Document generation is retired".into()));
        }
        let result = self.bridge.js.call("host", Some(json));
        self.bridge.flush(&mut self.html)?;
        result?;
        Ok(true)
    }
}

impl Drop for NativeDocument {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
    }
}

impl Document for NativeDocument {
    fn inner(&self) -> DocGuard<'_> {
        self.html.inner()
    }

    fn inner_mut(&mut self) -> DocGuardMut<'_> {
        self.html.inner_mut()
    }

    fn handle_ui_event(&mut self, event: UiEvent) {
        if !self.alive.load(Ordering::Acquire) {
            return;
        }
        let ends_composition = self.bridge.composition.before(&event);
        // beta.4's UI route bypasses EventHandler for Apple commands. Route
        // through its public DOM driver so readonly/disabled and synchronous
        // cancellation also apply to Backspace, cut/paste and native bindings.
        if let UiEvent::AppleStandardKeybinding(command) = event {
            if let Some(target) = self.html.get_focussed_node_id() {
                EventDriver::new(&mut self.html, Handler(&mut self.bridge)).handle_dom_event(
                    DomEvent::new(target, DomEventData::AppleStandardKeybinding(command)),
                );
            }
        } else {
            EventDriver::new(&mut self.html, Handler(&mut self.bridge)).handle_ui_event(event);
        }
        if ends_composition {
            self.bridge.composition = Composition::Idle;
        }
    }
}

// Winit/AppKit emits empty Preedit both from unmarkText (cancellation) and
// immediately before Commit. Preserve that ambiguous gap only until the next
// definitive event, not as a sticky composing flag. A confirming Enter/Space is
// suppressed once; Escape/cancelOperation or normal new input recovers immediately.
#[derive(Clone, Copy, PartialEq)]
enum Composition {
    Idle,
    Preedit,
    Cleared,
}

impl Composition {
    fn active(self) -> bool {
        self != Self::Idle
    }

    fn before(&mut self, event: &UiEvent) -> bool {
        match event {
            UiEvent::Ime(BlitzImeEvent::Preedit(text, _)) => {
                if !text.is_empty() {
                    *self = Self::Preedit;
                } else if self.active() {
                    *self = Self::Cleared;
                }
            }
            UiEvent::KeyDown(key) | UiEvent::KeyUp(key)
                if key.key == Key::Named(NamedKey::Escape) =>
            {
                *self = Self::Idle
            }
            UiEvent::AppleStandardKeybinding(command) if command.as_str() == "cancelOperation:" => {
                *self = Self::Idle
            }
            UiEvent::KeyDown(key) if *self == Self::Cleared && !activation_key(&key.key) => {
                *self = Self::Idle
            }
            UiEvent::AppleStandardKeybinding(command)
                if *self == Self::Cleared && !command.starts_with("insert") =>
            {
                *self = Self::Idle
            }
            _ => {}
        }
        matches!(
            event,
            UiEvent::Ime(BlitzImeEvent::Commit(_) | BlitzImeEvent::Disabled)
        ) || (*self == Self::Cleared && matches!(event, UiEvent::KeyDown(_) | UiEvent::KeyUp(_)))
    }
}

fn activation_key(key: &Key) -> bool {
    *key == Key::Named(NamedKey::Enter) || *key == Key::Character(" ".into())
}
struct Bridge {
    js: js::Js,
    tree: wire::Tree,
    alive: Arc<AtomicBool>,
    composition: Composition,
    space: Option<NodeId>,
    error: Option<Error>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    prevented: bool,
    stopped: bool,
    error: Option<String>,
}

impl Bridge {
    fn flush(&mut self, doc: &mut dyn Document) -> Result<()> {
        let settled = self.js.settle();
        let applied = (|| {
            let mutations = self
                .js
                .call("drain", None)?
                .ok_or_else(|| Error("Missing mutation batch".into()))?;
            self.tree.apply(doc, &mutations)
        })();
        // drain consumes the JS batch. A rejected batch cannot safely resume:
        // the JS topology is ahead of Blitz. Freeze this generation and reject
        // all future input/senders instead of reporting unrelated updates as OK.
        // Ordinary listener/job exceptions with a valid applied batch stay recoverable.
        if applied.is_err() {
            self.alive.store(false, Ordering::Release);
        }
        applied?;
        settled
    }

    fn dispatch(
        &mut self,
        doc: &mut dyn Document,
        chain: &[NodeId],
        event: &DomEvent,
    ) -> Result<Response> {
        let handles: Vec<_> = chain
            .iter()
            .filter_map(|id| self.tree.handle(*id))
            .collect();
        let mut data = json!({ "type":event.name(), "target": self.tree.handle(event.target).unwrap_or(0),
            "chain": handles, "bubbles": event.bubbles, "cancelable": event.cancelable,
            "isComposing":self.composition.active() });
        match &event.data {
            DomEventData::Input(input) => data["value"] = json!(input.value),
            DomEventData::AppleStandardKeybinding(command) => {
                data["command"] = json!(command.as_str())
            }
            DomEventData::KeyDown(key) | DomEventData::KeyUp(key) | DomEventData::KeyPress(key) => {
                data["key"] = json!(key.key.to_string());
                data["code"] = json!(key.code.to_string());
                data["repeat"] = json!(key.is_auto_repeating);
                data["isComposing"] = json!(self.composition.active() || key.is_composing);
                for (name, modifier) in [
                    ("altKey", Modifiers::ALT),
                    ("ctrlKey", Modifiers::CONTROL),
                    ("metaKey", Modifiers::META),
                    ("shiftKey", Modifiers::SHIFT),
                ] {
                    data[name] = json!(key.modifiers.contains(modifier));
                }
            }
            _ => {}
        }
        let result = self.js.call("dispatch", Some(&data.to_string()));
        // Even a throwing listener may have changed Solid signals. Never let
        // those changes wait for another interaction or paint a stale frame.
        self.flush(doc)?;
        let response: Response = serde_json::from_str(&result?.unwrap_or_default())
            .map_err(|e| Error(format!("Invalid event response: {e}")))?;
        Ok(response)
    }

    fn activate(&mut self, doc: &mut dyn Document, target: NodeId) -> Result<()> {
        let chain = doc.inner().node_chain(target);
        // Keyboard activation is a JS click with the same bubbling and
        // cancellation contract as a native pointer click, not a second input.
        let handles: Vec<_> = chain
            .iter()
            .filter_map(|id| self.tree.handle(*id))
            .collect();
        let result = self.js.call(
            "dispatch",
            Some(
                &json!({"type":"click","target":self.tree.handle(target).unwrap_or(0),
            "chain":handles,"bubbles":true,"cancelable":true,"isComposing":false})
                .to_string(),
            ),
        );
        self.flush(doc)?;
        let response: Response =
            serde_json::from_str(&result?.unwrap_or_default()).map_err(|e| Error(e.to_string()))?;
        if let Some(error) = response.error {
            return Err(Error(error));
        }
        Ok(())
    }
}

struct Handler<'a>(&'a mut Bridge);

impl EventHandler for Handler<'_> {
    fn handle_event(
        &mut self,
        chain: &[NodeId],
        event: &mut DomEvent,
        doc: &mut dyn Document,
        state: &mut EventState,
    ) {
        let bridge = &mut *self.0;
        if !bridge.alive.load(Ordering::Acquire) {
            state.prevent_default();
            return;
        }
        let outcome = (|| -> Result<()> {
            let disabled_button = chain
                .iter()
                .any(|id| tag(doc, *id, "button") && attribute(doc, *id, "disabled"));
            if event.name() == "click" && disabled_button {
                state.prevent_default();
                return Ok(());
            }
            let response = bridge.dispatch(doc, chain, event)?;
            if response.prevented {
                state.prevent_default();
            }
            if response.stopped {
                state.stop_propagation();
            }
            if let Some(error) = response.error {
                eprintln!("UI listener: {error}");
                bridge.error = Some(Error(error));
            }
            let target = event.target;
            // Disabled fields reject keyboard defaults except Tab. Readonly
            // fields still permit caret movement, selection and copying; only
            // operations which can change text are canceled before Blitz edits.
            if tag(doc, target, "input") {
                let tab = matches!(&event.data, DomEventData::KeyDown(key) if key.key == Key::Named(NamedKey::Tab));
                let disabled_edit = attribute(doc, target, "disabled")
                    && !tab
                    && matches!(
                        event.data,
                        DomEventData::KeyDown(_)
                            | DomEventData::KeyPress(_)
                            | DomEventData::Ime(_)
                            | DomEventData::AppleStandardKeybinding(_)
                    );
                let readonly_edit = attribute(doc, target, "readonly") && mutates_text(&event.data);
                if disabled_edit || readonly_edit {
                    state.prevent_default();
                }
            }
            if matches!(event.data, DomEventData::Blur(_)) {
                bridge.space = None;
                bridge.composition = Composition::Idle;
            }
            // beta.4 does not supply button Enter/Space activation. Own it once,
            // suppressing repeats, IME confirmation and canceled/disabled keys.
            if tag(doc, target, "button") {
                let disabled = attribute(doc, target, "disabled");
                match &event.data {
                    DomEventData::KeyDown(key)
                        if !bridge.composition.active() && !key.is_composing =>
                    {
                        if key.key == Key::Character(" ".into()) {
                            if !key.is_auto_repeating {
                                bridge.space = if !state.is_cancelled() && !disabled {
                                    Some(target)
                                } else {
                                    None
                                };
                            }
                            state.prevent_default();
                        } else if key.key == Key::Named(NamedKey::Enter)
                            && !key.is_auto_repeating
                            && !state.is_cancelled()
                            && !disabled
                        {
                            state.prevent_default();
                            bridge.activate(doc, target)?;
                        }
                    }
                    DomEventData::KeyUp(key) if key.key == Key::Character(" ".into()) => {
                        let armed = bridge.space.take() == Some(target);
                        if armed
                            && !state.is_cancelled()
                            && !disabled
                            && !bridge.composition.active()
                            && !key.is_composing
                            && doc.inner().get_focussed_node_id() == Some(target)
                        {
                            bridge.activate(doc, target)?;
                        }
                        state.prevent_default();
                    }
                    _ => {}
                }
            }
            state.request_redraw();
            Ok(())
        })();
        if let Err(error) = outcome {
            eprintln!("UI event: {error}");
            bridge.error = Some(error);
            state.prevent_default();
        }
    }
}

// Mirror the public editor's mutation categories, not every platform shortcut.
// Apple navigation/selection/copy commands are safe; unknown Apple edit commands
// fail closed for readonly rather than silently gaining write access on upgrade.
fn mutates_text(data: &DomEventData) -> bool {
    match data {
        DomEventData::Ime(BlitzImeEvent::Enabled | BlitzImeEvent::Disabled) => false,
        DomEventData::Ime(_) => true,
        DomEventData::AppleStandardKeybinding(command) => {
            let command = command.as_str();
            !(command.starts_with("move")
                || command.starts_with("select")
                || command.starts_with("scroll")
                || command.starts_with("page")
                || matches!(
                    command,
                    "copy:"
                        | "cancelOperation:"
                        | "insertTab:"
                        | "insertBacktab:"
                        | "setMark:"
                        | "swapWithMark:"
                ))
        }
        DomEventData::KeyDown(key) | DomEventData::KeyPress(key) => match &key.key {
            Key::Named(NamedKey::Backspace | NamedKey::Delete | NamedKey::Enter) => true,
            Key::Character(text) => {
                let action = if cfg!(target_os = "macos") {
                    Modifiers::META
                } else {
                    Modifiers::CONTROL
                };
                if key.modifiers.contains(action) {
                    matches!(text.to_lowercase().as_str(), "x" | "v")
                } else {
                    !key.modifiers
                        .intersects(Modifiers::CONTROL | Modifiers::META)
                }
            }
            _ => false,
        },
        _ => false,
    }
}

fn tag(doc: &dyn Document, id: NodeId, name: &str) -> bool {
    doc.inner()
        .get_node(id)
        .and_then(|n| n.element_data())
        .is_some_and(|e| &*e.name.local == name)
}

fn attribute(doc: &dyn Document, id: NodeId, name: &str) -> bool {
    doc.inner()
        .get_node(id)
        .and_then(|n| n.element_data())
        .is_some_and(|e| {
            e.attr(
                blitz_dom::QualName::new(None, blitz_dom::Namespace::from(""), name.into()).local,
            )
            .is_some()
        })
}
