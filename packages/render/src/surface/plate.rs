//! The widget of a self-painting plate (bind.rs, "Who draws a plate"): one
//! rounded box with its own fill and lit bevel, drawn by the element that
//! carries it.
//!
//! It decorates an ordinary element (a `<button>`, a `<div>`), so it differs
//! from `<tk-surface>` in three ways. It ignores every input event, so Blitz
//! runs the element's own default action (focus, `:active`, click, wheel
//! scrolling; this needs `EventResult` from our Blitz fork). It ignores the
//! element's attributes: its one shape and material come from the layout
//! pass through a handle. And it draws the element's border box, although
//! Blitz places a widget's scene at the content box, with its image on
//! whole device pixels wherever the element is (the shape carries the
//! sub-pixel part of its position), so plate edges stay sharp.
//!
//! Blitz calls `paint` on every frame for every widget in the document, so
//! an unchanged plate does no GPU work: `Gpu::update` returns at once and
//! the Scene only references the plate's slot in the shared atlas. A plate
//! without a bevel has no texture at all: it is a vector fill in the Scene.
use super::bind::Handle;
use super::gpu::Gpu;
use super::shape::{Key, Look, Shape};
use super::stats;
use anyrender::{PaintScene, RenderContext, Scene};
use blitz_dom::node::{ComputedStyles, EventResult, Widget};
use blitz_traits::events::UiEvent;
use peniko::{
    Color, Fill,
    kurbo::{Affine, RoundedRect, RoundedRectRadii},
};
use std::time::Instant;

pub(super) struct Plate {
    /// Identifies the plate to the atlas (see `gpu::Atlas::id`).
    id: u32,
    handle: Handle,
    seen: u64,
    /// The plate in its own border box, with its key; None draws nothing.
    shape: Option<(Key, Shape)>,
    /// The sub-pixel part of the plate's position on screen (device px,
    /// 0..1 each way) and the shape moved by it: what is rendered.
    sub: [f32; 2],
    placed: Option<Shape>,
    /// Each shape carries its own material (`Look::layered`).
    look: Look,
    gpu: Option<Gpu>,
}

impl Plate {
    pub fn new(handle: Handle) -> Self {
        Self {
            id: super::widget::next_id(),
            handle,
            seen: 0,
            shape: None,
            sub: [0.0; 2],
            placed: None,
            look: Look {
                layered: true,
                ..Look::default()
            },
            gpu: None,
        }
    }
}

impl Widget for Plate {
    /// The plate is decoration: the element keeps every default action.
    fn handle_event(&mut self, _event: &UiEvent) -> EventResult {
        EventResult::Ignored
    }

    fn destroy_surfaces(&mut self) {
        // The renderer drops every registered texture on suspend.
        self.gpu = None;
    }

    // `requires_redraw` stays false: a plate never animates on its own; a
    // change of its material arrives with a restyle, which redraws.

    fn paint(
        &mut self,
        render_ctx: &mut dyn RenderContext,
        _styles: &ComputedStyles,
        _width: u32,
        _height: u32,
        scale: f64,
    ) -> Scene {
        let started = Instant::now();
        let s = scale as f32;
        let shift = {
            let bound = self.handle.borrow();
            if bound.version != self.seen || (bound.sub != self.sub && self.shape.is_some()) {
                if bound.version != self.seen {
                    self.seen = bound.version;
                    self.shape = bound
                        .keys
                        .first()
                        .copied()
                        .zip(bound.shapes.first().cloned());
                }
                // The image is drawn on whole device pixels (below), so the
                // shape carries the sub-pixel part of the plate's position:
                // the same pixels as a shape drawn in place by the sheet,
                // instead of an image resampled half a pixel over.
                self.sub = bound.sub;
                self.placed = self
                    .shape
                    .as_ref()
                    .map(|(_, shape)| shape.translated(self.sub[0] / s, self.sub[1] / s));
            }
            bound.shift
        };
        let (Some((key, base)), Some(shape)) = (&self.shape, &self.placed) else {
            if let Some(gpu) = &mut self.gpu {
                gpu.release(render_ctx);
            }
            stats::record(started.elapsed(), 0, false);
            return Scene::new();
        };
        // A flat plate (no bevel) is a plain rounded box: a vector fill in
        // the Scene, as Blitz would have painted the background, with no
        // texture and no atlas slot. Large flat backgrounds (a panel, a
        // column) would otherwise each be a texture Vello copies per frame.
        if let Some(paint) = base.paint.filter(|p| p.bevel <= 0.0) {
            if let Some(gpu) = &mut self.gpu {
                gpu.release(render_ctx);
            }
            let (w, h) = (base.rect[2], base.rect[3]);
            // Radii as the shader clamps them (`rounded_box`).
            let [tl, tr, br, bl] = base.radii.map(|r| (r.min(w / 2.0).min(h / 2.0) * s) as f64);
            let outline = RoundedRect::new(
                0.0,
                0.0,
                (w * s) as f64,
                (h * s) as f64,
                RoundedRectRadii::new(tl, tr, br, bl),
            );
            let mut scene = Scene::new();
            scene.fill(
                Fill::NonZero,
                Affine::translate((shift[0] as f64 * scale, shift[1] as f64 * scale)),
                Color::new(paint.fill),
                None,
                &outline,
            );
            stats::record(started.elapsed(), 0, false);
            return scene;
        }
        if self.gpu.is_none() {
            // Same policy as `<tk-surface>`: plates render on the GPU only.
            self.gpu = Some(Gpu::new(render_ctx, self.id).unwrap_or_else(|| {
                panic!(
                    "a plate needs the wgpu (Vello) renderer; this render context \
                     has no wgpu device"
                )
            }));
        }
        let gpu = self.gpu.as_mut().unwrap();
        // The whole border box from the device pixel it starts in, rounded
        // up. (Blitz hands the box size rounded down, which would cut the
        // last device pixel of a fractional box.)
        let width = ((shape.rect[0] + shape.rect[2]) * s).ceil().max(1.0) as u32;
        let height = ((shape.rect[1] + shape.rect[3]) * s).ceil().max(1.0) as u32;
        let dirty = gpu.update(
            render_ctx,
            std::slice::from_ref(key),
            std::slice::from_ref(shape),
            &self.look,
            width,
            height,
            s,
        );
        // From the content box, where Blitz places the scene, to the device
        // pixel the border box starts in (see `Bound::shift`, `Bound::sub`).
        let scene = gpu.scene(
            width,
            height,
            [
                shift[0] as f64 * scale - self.sub[0] as f64,
                shift[1] as f64 * scale - self.sub[1] as f64,
            ],
        );
        stats::record(started.elapsed(), dirty, false);
        scene
    }
}
