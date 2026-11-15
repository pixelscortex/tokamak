//! Own a document generation, host delivery and layout coordination.
use crate::{
    Error, Result,
    bridge::Bridge,
    caret, icon,
    input::{Composition, Handler},
    js, layout, wire,
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
        Self::new_connected_with_fonts(shell, bundle, send, &[])
    }

    /// As `new_connected`, with the product's own font files (TTF, OTF, WOFF
    /// or WOFF2 bytes) added to the system's. CSS then names their families
    /// as usual. The released renderer loads `@font-face` only through a
    /// network provider, which this host does not have, so bundled fonts are
    /// registered here instead.
    pub fn new_connected_with_fonts(
        shell: &str,
        bundle: &str,
        send: Option<MessageSender>,
        fonts: &[&[u8]],
    ) -> Result<Self> {
        let mut config = blitz_dom::DocumentConfig::default();
        if !fonts.is_empty() {
            let mut context = blitz_dom::FontContext::default();
            for font in fonts {
                let bytes = blitz_dom::decode_font_bytes(font).into_owned();
                context
                    .collection
                    .register_fonts(peniko::Blob::new(Arc::new(bytes) as _), None);
            }
            config.font_ctx = Some(context);
        }
        let mut html = HtmlDocument::from_html(shell, config);
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
            // Keep an opted-in text editor ready on launch and after a click
            // on non-focusable content. Never steal focus from another control.
            let autofocus = {
                let inner = self.html.inner();
                inner
                    .get_focussed_node_id()
                    .is_none_or(|target| {
                        inner
                            .get_node(target)
                            .and_then(|node| node.element_data())
                            .is_some_and(|element| matches!(&*element.name.local, "html" | "body"))
                    })
                    .then(|| {
                        inner
                            .query_selector("[autofocus]:not([disabled])")
                            .ok()
                            .flatten()
                            .filter(|target| {
                                inner.get_node(*target).is_some_and(|node| {
                                    node.element_data()
                                        .is_some_and(|element| element.text_input_data().is_some())
                                        && node.final_layout().size.width > 0.0
                                        && node.final_layout().size.height > 0.0
                                })
                            })
                    })
                    .flatten()
            };
            if let Some(target) = autofocus {
                self.html.inner_mut().set_focus_to(target);
            }
            // Both reports may update page overlays. Resolve their mutations
            // before painting, including after a native selection-only edit.
            let reports = (|| {
                let layout = layout::report_layout(&mut self.bridge, &mut self.html)?;
                let caret = caret::report_caret(&mut self.bridge, &mut self.html)?;
                Ok::<_, Error>(layout || caret)
            })();
            match reports {
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

    pub fn take_error(&mut self) -> Option<Error> {
        self.bridge.error.take()
    }

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
