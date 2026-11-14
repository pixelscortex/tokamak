use crate::{
    Error, Result,
    bridge::Bridge,
    icon,
    input::{Composition, Handler},
    js, layout, surface, wire,
};
use blitz_dom::{DocGuard, DocGuardMut, Document, EventDriver};
use blitz_html::HtmlDocument;
use blitz_traits::events::*;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

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
    pub(super) alive: Arc<AtomicBool>,
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
        html.inner_mut()
            .add_user_agent_stylesheet(blitz_dom::UserAgentStylesheet::parse(icon::UA_CSS));
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

    /// Lay out (Blitz `resolve`), then report observed layouts to JS
    /// (layout.rs); while a report changes the document (a menu re-placed),
    /// lay out and report again, a few rounds at most. Call this instead of
    /// `resolve` before painting; the window does on every redraw. A
    /// document whose observed boxes did not move calls no JS.
    pub fn resolve_layout(&mut self, time: f64) {
        for _ in 0..4 {
            self.html.inner_mut().resolve(time);
            match layout::report_layout(&mut self.bridge, &mut self.html) {
                Ok(true) => {}
                Ok(false) => return,
                Err(error) => {
                    eprintln!("UI layout report: {error}");
                    self.bridge.error = Some(error);
                    return;
                }
            }
        }
        // Still changing after the last round: lay out what it left.
        self.html.inner_mut().resolve(time);
    }

    /// Hand layout-bound shapes to `<tk-surface>` widgets and attach the
    /// widgets of self-painting plates (surface/bind.rs). Call after
    /// `resolve` and before painting; the window does this on every redraw.
    /// Changes nothing when no member box, plate or setting changed.
    pub fn layout_surfaces(&mut self) {
        self.bridge.tree.surfaces.bind(&mut self.html.inner_mut());
    }

    /// Lab probe (lab-probes): the shape the self-painting plate `node`
    /// last drew, in its own border box; None if it does not paint itself.
    #[cfg(feature = "lab-probes")]
    pub fn own_plate_shape(&self, node: blitz_traits::NodeId) -> Option<surface::MaterialShape> {
        self.bridge.tree.surfaces.own_shape(node)
    }

    /// Lab probe (lab-probes): for a plate that cannot carry a widget and
    /// sits in a self-painting plate: that plate's node, and the shape it
    /// draws for `node`, in its own border box.
    #[cfg(feature = "lab-probes")]
    pub fn hosted_plate_shape(
        &self,
        node: blitz_traits::NodeId,
    ) -> Option<(blitz_traits::NodeId, surface::MaterialShape)> {
        self.bridge.tree.surfaces.hosted_shape(node)
    }

    /// Lab probe (lab-probes): how many plates paint themselves.
    #[cfg(feature = "lab-probes")]
    pub fn own_plate_count(&self) -> usize {
        self.bridge.tree.surfaces.own_count()
    }

    /// Lab probe (lab-probes): the shapes the last layout pass handed to
    /// the `<tk-surface>` element `node`, with each shape's own material.
    #[cfg(feature = "lab-probes")]
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
    pub(super) fn host_json(&mut self, generation: u64, json: &str) -> Result<bool> {
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
