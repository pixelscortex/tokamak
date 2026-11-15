//! Supply the input default actions missing from Blitz.
use crate::{Error, Result, bridge::Bridge};
use blitz_dom::{BaseDocument, Document, EventHandler, ScrollBehavior};
use blitz_traits::{NodeId, events::*};
use keyboard_types::{Key, Modifiers, NamedKey};
use std::sync::atomic::Ordering;
use style::values::computed::Overflow;

// Winit/AppKit emits empty Preedit both from unmarkText (cancellation) and
// immediately before Commit. Preserve that ambiguous gap only until the next
// definitive event, not as a sticky composing flag. A confirming Enter/Space is
// suppressed once; Escape/cancelOperation or normal new input recovers immediately.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Composition {
    Idle,
    Preedit,
    Cleared,
}

impl Composition {
    pub(super) fn active(self) -> bool {
        self != Self::Idle
    }

    pub(super) fn before(&mut self, event: &UiEvent) -> bool {
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
pub(super) struct Handler<'a>(pub(super) &'a mut Bridge);

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
            contain_wheel(doc, chain, event, state);
            protect_input(doc, event, state);
            reset_on_blur(bridge, event);
            activate_button(bridge, doc, event, state)?;
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

fn contain_wheel(
    doc: &mut dyn Document,
    chain: &[NodeId],
    event: &DomEvent,
    state: &mut EventState,
) {
    if let DomEventData::Wheel(wheel) = &event.data
        && !state.is_cancelled()
        && overscroll_wheel(&mut doc.inner_mut(), chain, wheel)
    {
        state.prevent_default();
    }
}

fn text_field(doc: &dyn Document, target: NodeId) -> bool {
    tag(doc, target, "input") || tag(doc, target, "textarea")
}

fn disabled(doc: &dyn Document, target: NodeId) -> bool {
    if attribute(doc, target, "disabled") {
        return true;
    }
    let inner = doc.inner();
    let mut child = target;
    while let Some(parent) = inner.get_node(child).and_then(|n| n.parent) {
        if tag(doc, parent, "fieldset") && attribute(doc, parent, "disabled") {
            let legend = inner
                .get_node(parent)
                .unwrap()
                .children
                .iter()
                .find(|id| tag(doc, **id, "legend"));
            if legend != Some(&child) {
                return true;
            }
        }
        child = parent;
    }
    false
}

fn protect_input(doc: &dyn Document, event: &DomEvent, state: &mut EventState) {
    let target = event.target;
    // Disabled fields reject keyboard defaults except Tab. Readonly
    // fields still permit caret movement, selection and copying; only
    // operations which can change text are canceled before Blitz edits.
    if text_field(doc, target) {
        let tab = matches!(&event.data, DomEventData::KeyDown(key) if key.key == Key::Named(NamedKey::Tab));
        let disabled_edit = disabled(doc, target)
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
}

fn reset_on_blur(bridge: &mut Bridge, event: &DomEvent) {
    if matches!(event.data, DomEventData::Blur(_)) {
        bridge.space = None;
        bridge.composition = Composition::Idle;
    }
}

fn activate_button(
    bridge: &mut Bridge,
    doc: &mut dyn Document,
    event: &DomEvent,
    state: &mut EventState,
) -> Result<()> {
    let target = event.target;
    // beta.4 does not supply button Enter/Space activation. Own it once,
    // suppressing repeats, IME confirmation and canceled/disabled keys.
    if tag(doc, target, "button") {
        let disabled = attribute(doc, target, "disabled");
        match &event.data {
            DomEventData::KeyDown(key) if !bridge.composition.active() && !key.is_composing => {
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
    Ok(())
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

// Blitz always hands the scroll a box could not use to the next scroller
// up (it has no `overscroll-behavior`), so a list at its end scrolls the
// page behind it. The `overscroll-contain` utility (ui/materials.css)
// writes `--tk-overscroll: contain` on the element; a wheel event that
// passes through such an element is handled here instead of by Blitz:
// the nearest box at or inside it that can still move in the wheel's
// direction scrolls, and what is left over is dropped.
fn overscroll_wheel(doc: &mut BaseDocument, chain: &[NodeId], wheel: &BlitzWheelEvent) -> bool {
    let Some(container) = chain.iter().position(|id| contains(doc, *id)) else {
        return false;
    };
    let (dx, dy) = match wheel.delta {
        BlitzWheelDelta::Lines(x, y) => (x * 20.0, y * 20.0),
        BlitzWheelDelta::Pixels(x, y) => (x, y),
    };
    // A wheel delta moves the content, the opposite of the scroll offset.
    let (dx, dy) = (-dx, -dy);
    for id in &chain[..=container] {
        let (room_x, room_y) = room(doc, *id, dx, dy);
        if room_x || room_y {
            let x = if room_x {
                dx
            } else {
                0.0
            };
            let y = if room_y {
                dy
            } else {
                0.0
            };
            doc.scroll_by(*id, x, y, ScrollBehavior::Instant);
            break;
        }
    }
    true
}

fn contains(doc: &BaseDocument, id: NodeId) -> bool {
    let Some(style) = doc.get_node(id).and_then(|n| n.primary_styles()) else {
        return false;
    };
    // A registered property (materials.css), so it does not inherit.
    let props = style.custom_properties();
    props
        .non_inherited
        .get(&blitz_dom::Atom::from("tk-overscroll"))
        .is_some_and(|value| match value.as_universal() {
            Some(text) => text.css.trim() == "contain",
            None => value.to_variable_value().css.trim() == "contain",
        })
}

/// Whether the box can still scroll towards `dx` / `dy` (offset deltas), per
/// axis. Only `overflow: auto | scroll` axes count, as for any user scroll.
fn room(doc: &BaseDocument, id: NodeId, dx: f64, dy: f64) -> (bool, bool) {
    let Some(node) = doc.get_node(id) else {
        return (false, false);
    };
    let Some(style) = node.primary_styles() else {
        return (false, false);
    };
    let scrolls = |overflow| matches!(overflow, Overflow::Scroll | Overflow::Auto);
    let offset = node.scroll_offset();
    let layout = node.final_layout();
    let axis = |can: bool, at: f64, max: f64, by: f64| {
        can && ((by > 0.0 && at < max - 0.5) || (by < 0.0 && at > 0.5))
    };
    (
        axis(
            scrolls(style.clone_overflow_x()),
            offset.x,
            layout.scroll_width() as f64,
            dx,
        ),
        axis(
            scrolls(style.clone_overflow_y()),
            offset.y,
            layout.scroll_height() as f64,
            dy,
        ),
    )
}
