//! `<tk-surface>`: one fused, lit surface painted by a Blitz custom widget.
//!
//! UI plates that merge into their neighbours with curved joins instead of
//! floating with borders or shadows: a short list of shapes combined into one
//! signed distance field, filled flat, with a bevel that lightens edges facing
//! a single light and darkens edges facing away. Rendered on the GPU into a
//! cached texture and drawn by Vello as an image. One element is one group:
//! only its own shapes interact. See `packages/render/SURFACES.md` for the
//! attribute reference, the cost model and the known limits.
//!
//! Modules, one job each:
//! - `shape`: parsed shapes (incl. exact rounded polygons) and the look.
//! - `tiles`: per-tile culling and dirty rects for partial re-render.
//! - `gpu`: pipeline, shared atlas, own textures, the Scene a widget returns.
//! - `frame`: the per-frame hook that renders the atlas and submits once.
//! - `bind`: layout binding (member elements' boxes become shapes; who
//!   draws each plate).
//! - `widget`: the Blitz widget (attributes, animation, paint).
//! - `plate`: the widget of a self-painting plate, on the element itself.
//! - `stats`: lab-only paint counters (`lab-probes` feature, not in
//!   product builds).
//! - `surface.wgsl`: the distance field and shading, on the GPU.
//! - `reference`, `tests`: the same maths on the CPU as a test oracle, and
//!   the tests (test builds only).
mod bind;
mod frame;
mod gpu;
mod plate;
mod shape;
mod tiles;
mod widget;

#[cfg(feature = "lab-probes")]
pub mod stats;

/// Without the lab feature, recording paint statistics compiles to nothing.
#[cfg(not(feature = "lab-probes"))]
mod stats {
    #[inline(always)]
    pub(super) fn record(_work: std::time::Duration, _dirty_px: u64) {}
}

#[cfg(test)]
mod reference;
#[cfg(test)]
mod tests;

use blitz_dom::node::Widget;

pub(crate) use frame::FrameRenderer;
pub use frame::end_frame;

/// User-agent defaults, installed by `NativeDocument`. `pointer-events: none`
/// is required, not cosmetic: blitz-dom hands every event that hits a
/// custom-widget node to `Widget::handle_event` and returns (blitz-dom
/// events/mod.rs, "Handle event forwarding for custom widget"), so wheel
/// scrolling stopped over a surface. Surfaces are background layers with no
/// children, so hit testing passes through to the element underneath. For
/// `tk-surface` it is `!important`, which in the user-agent origin no author
/// rule can override: a region's materials layer sits among the region's
/// children, where a utility such as `*:pointer-events-auto` reaches it.
pub(crate) const UA_CSS: &str = "tk-surface, tk-icon { display: block; flex-shrink: 0; \
     pointer-events: none; } tk-surface { pointer-events: none !important; }";

#[cfg(feature = "lab-probes")]
pub use bind::MaterialShape;
pub(crate) use bind::Registry;
pub(crate) use shape::parse_colour;

/// The widget for an element tag, if the tag is one of ours. Attached when
/// the element is created, before its attributes arrive, so every attribute
/// reaches `Widget::attribute_changed`. Surfaces register with `registry` so
/// the layout pass can hand them member shapes.
pub(crate) fn widget_for(
    tag: &str,
    node: blitz_traits::NodeId,
    registry: &mut Registry,
) -> Option<Box<dyn Widget>> {
    match tag {
        "tk-surface" => Some(registry.surface(node)),
        // Not a surface; dispatched here so wire.rs has one widget hook.
        "tk-icon" => Some(crate::icon::widget()),
        _ => None,
    }
}
