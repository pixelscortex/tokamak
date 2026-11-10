//! The Blitz custom widget behind `<tk-surface>`: holds the parsed shapes and
//! look, animates shape changes, and asks the GPU side to bring its target up
//! to date on each paint. Blitz calls `paint` for every custom widget on every
//! frame, so an unchanged surface must be (and is) close to free: `update`
//! returns at once and the Scene only references the cached texture.
use super::gpu::Gpu;
use super::shape::{Look, Shape, parse_shapes};
use super::stats;
use anyrender::{RenderContext, Scene};
use blitz_dom::node::{ComputedStyles, Widget};
use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

/// Shape changes with the same count and ops animate per index.
pub(super) const ANIMATION: Duration = Duration::from_millis(220);

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

struct Animation {
    from: Vec<Shape>,
    start: Instant,
}

pub(super) struct Surface {
    /// Identifies the surface to the atlas (see `gpu::Atlas::id`).
    id: u32,
    look: Look,
    /// The shapes as last set by the attribute, and as currently shown
    /// (different only while animating).
    target: Vec<Shape>,
    shown: Vec<Shape>,
    animation: Option<Animation>,
    gpu: Option<Gpu>,
    #[cfg(feature = "surface-demo")]
    demo: super::demo::Driver,
}

impl Surface {
    pub fn new() -> Self {
        Self {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            look: Look::default(),
            target: Vec::new(),
            shown: Vec::new(),
            animation: None,
            gpu: None,
            #[cfg(feature = "surface-demo")]
            demo: Default::default(),
        }
    }

    fn set_shapes(&mut self, shapes: Vec<Shape>) {
        let compatible = !self.shown.is_empty()
            && self.shown.len() == shapes.len()
            && self.shown.iter().zip(&shapes).all(|(a, b)| a.sub == b.sub);
        if compatible && self.shown != shapes {
            // Start from what is on screen now, so a change mid-flight
            // continues from the current position instead of jumping.
            self.animation = Some(Animation {
                from: self.shown.clone(),
                start: Instant::now(),
            });
        } else {
            self.animation = None;
            self.shown = shapes.clone();
        }
        self.target = shapes;
    }

    /// Advance the animation to now (ease-out cubic). True when it finished.
    fn step(&mut self) -> bool {
        let Some(animation) = &self.animation else {
            return false;
        };
        let t = (animation.start.elapsed().as_secs_f32() / ANIMATION.as_secs_f32()).min(1.0);
        let e = 1.0 - (1.0 - t).powi(3);
        self.shown = animation
            .from
            .iter()
            .zip(&self.target)
            .map(|(a, b)| Shape::lerp(a, b, e))
            .collect();
        t >= 1.0
    }

    fn moving(&self) -> bool {
        #[cfg(feature = "surface-demo")]
        if self.demo.moves() {
            return true;
        }
        self.animation.is_some()
    }
}

impl Widget for Surface {
    fn attribute_changed(&mut self, name: &str, _old: Option<&str>, new: Option<&str>) {
        #[cfg(feature = "surface-demo")]
        if self.demo.set(name, new) {
            return;
        }
        if name == "shapes" {
            match parse_shapes(new.unwrap_or("[]")) {
                Ok(shapes) => self.set_shapes(shapes),
                Err(error) => eprintln!("tk-surface shapes: {error}"),
            }
        } else {
            self.look.set(name, new);
        }
    }

    fn destroy_surfaces(&mut self) {
        // The renderer drops every registered texture on suspend.
        self.gpu = None;
    }

    /// True only while something moves: an unchanged surface requests no
    /// frames, so an idle window repaints nothing.
    fn requires_redraw(&self) -> bool {
        self.moving()
    }

    fn paint(
        &mut self,
        render_ctx: &mut dyn RenderContext,
        _styles: &ComputedStyles,
        width: u32,
        height: u32,
        scale: f64,
    ) -> Scene {
        let started = Instant::now();
        let active = self.moving();
        if self.step() {
            self.animation = None;
        }
        #[cfg(feature = "surface-demo")]
        if let Some(next) = self.demo.shapes(width, height, scale, &self.shown) {
            self.shown = next;
        }
        if self.gpu.is_none() {
            // Same policy as shell.rs for a software adapter: no silent
            // fallback, the product renders surfaces on the GPU only.
            self.gpu = Some(Gpu::new(render_ctx, self.id).unwrap_or_else(|| {
                panic!(
                    "tk-surface needs the wgpu (Vello) renderer; this render context \
                     has no wgpu device"
                )
            }));
        }
        let gpu = self.gpu.as_mut().unwrap();
        let dirty = gpu.update(
            render_ctx,
            &self.shown,
            &self.look,
            width,
            height,
            scale as f32,
        );
        let scene = gpu.scene(width, height);
        stats::record(started.elapsed(), dirty, active);
        scene
    }
}

#[cfg(test)]
impl Surface {
    pub fn shown(&self) -> &[Shape] {
        &self.shown
    }

    pub fn target(&self) -> &[Shape] {
        &self.target
    }

    pub fn step_for_test(&mut self, elapsed: Duration) -> bool {
        if let Some(a) = &mut self.animation {
            a.start -= elapsed;
        }
        self.step()
    }
}
