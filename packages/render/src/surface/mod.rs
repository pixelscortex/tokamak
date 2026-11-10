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
//! - `widget`: the Blitz widget (attributes, animation, paint).
//! - `demo`, `stats`, `fps`: lab-only stress demo and readout
//!   (`surface-demo` feature, not in product builds).
//! - `surface.wgsl`: the distance field and shading, on the GPU.
//! - `reference`, `tests`: the same maths on the CPU as a test oracle, and
//!   the tests (test builds only).
mod frame;
mod gpu;
mod shape;
mod tiles;
mod widget;

#[cfg(feature = "surface-demo")]
mod demo;
#[cfg(feature = "surface-demo")]
mod fps;
#[cfg(feature = "surface-demo")]
pub mod stats;

/// Without the lab feature, recording paint statistics compiles to nothing.
#[cfg(not(feature = "surface-demo"))]
mod stats {
    #[inline(always)]
    pub(super) fn record(_work: std::time::Duration, _dirty_px: u64, _active: bool) {}
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
/// children, so hit testing passes through to the element underneath.
pub(crate) const UA_CSS: &str = "tk-surface { display: block; pointer-events: none; }";

/// The widget for an element tag, if the tag is one of ours. Attached when
/// the element is created, before its attributes arrive, so every attribute
/// reaches `Widget::attribute_changed`.
pub(crate) fn widget_for(tag: &str) -> Option<Box<dyn Widget>> {
    match tag {
        "tk-surface" => Some(Box::new(widget::Surface::new())),
        #[cfg(feature = "surface-demo")]
        fps::TAG => Some(fps::widget()),
        _ => None,
    }
}
