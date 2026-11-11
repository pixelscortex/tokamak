//! `overscroll-contain`: a scroller that keeps the wheel to itself.
//!
//! Blitz always hands the scroll a box could not use to the next scroller
//! up (it has no `overscroll-behavior`), so a list at its end scrolls the
//! page behind it. The `overscroll-contain` utility (ui/materials.css)
//! writes `--tk-overscroll: contain` on the element; a wheel event that
//! passes through such an element is handled here instead of by Blitz:
//! the nearest box at or inside it that can still move in the wheel's
//! direction scrolls, and what is left over is dropped.

use blitz_dom::{BaseDocument, ScrollBehavior};
use blitz_traits::{NodeId, events::*};
use style::values::computed::Overflow;

/// Handles `wheel` if an element of `chain` (target first) contains
/// overscroll. Returns whether it did; the caller then cancels Blitz's own
/// (chaining) scroll.
pub(crate) fn wheel(doc: &mut BaseDocument, chain: &[NodeId], wheel: &BlitzWheelEvent) -> bool {
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
            let x = if room_x { dx } else { 0.0 };
            let y = if room_y { dy } else { 0.0 };
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
