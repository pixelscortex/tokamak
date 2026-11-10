//! The Blitz custom widget behind `<tk-surface>`: holds the shapes (from the
//! `shapes` attribute, then from layout-bound members, see `bind`) and the
//! look, animates shape changes, and asks the GPU side to bring its target up
//! to date on each paint. Blitz calls `paint` for every custom widget on every
//! frame, so an unchanged surface must be (and is) close to free: `update`
//! returns at once and the Scene only references the cached texture.
use super::bind::Handle;
use super::gpu::Gpu;
use super::shape::{Key, Look, Shape, index_keys, parse_colour, parse_shapes, var_name};
use super::stats;
use anyrender::{RenderContext, Scene};
use blitz_dom::node::{ComputedStyles, Widget};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

/// How long a shape takes to move from its old geometry to its new one.
pub(super) const ANIMATION: Duration = Duration::from_millis(220);

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// One shape on its way from `from` to its target, by identity (`Key`).
struct Tween {
    from: Shape,
    start: Instant,
}

pub(super) struct Surface {
    /// Identifies the surface to the atlas (see `gpu::Atlas::id`).
    id: u32,
    look: Look,
    /// Shapes from the `shapes` attribute, and from bound members (layout).
    explicit: Vec<Shape>,
    bound: Option<Handle>,
    bound_seen: u64,
    /// Both together as last set, and as currently shown (different only
    /// while animating), with each shape's identity (`keys`, same order).
    keys: Vec<Key>,
    target: Vec<Shape>,
    shown: Vec<Shape>,
    /// Shapes in flight, by identity. Each runs on its own clock, so a shape
    /// added or removed mid-flight leaves the others' animations alone.
    tweens: HashMap<Key, Tween>,
    /// Device px per CSS px at the last paint, for snapping tweens.
    scale: f32,
    gpu: Option<Gpu>,
    /// `fill` / `border-color` given as `var(--token)`: resolved from the
    /// element's computed custom properties at each paint, so a surface's
    /// colours come from the same theme tokens as the page's CSS.
    fill_var: Option<String>,
    border_var: Option<String>,
    /// Address of the computed style the colours were last resolved from.
    resolved_for: usize,
    #[cfg(feature = "surface-demo")]
    demo: super::demo::Driver,
}

impl Surface {
    pub fn new() -> Self {
        Self {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            look: Look::default(),
            explicit: Vec::new(),
            bound: None,
            bound_seen: 0,
            keys: Vec::new(),
            target: Vec::new(),
            shown: Vec::new(),
            tweens: HashMap::new(),
            scale: 1.0,
            gpu: None,
            fill_var: None,
            border_var: None,
            resolved_for: 0,
            #[cfg(feature = "surface-demo")]
            demo: Default::default(),
        }
    }

    /// A surface whose members come from layout through `handle`.
    pub fn bound(handle: Handle) -> Self {
        Self {
            bound: Some(handle),
            ..Self::new()
        }
    }

    /// Explicit shapes first, then bound members, with their keys and
    /// whether each should animate. `explicit_animate` applies to the
    /// explicit part; the bound part animates as the last layout pass said.
    fn combined(&self, explicit_animate: bool) -> (Vec<Key>, Vec<Shape>, Vec<bool>) {
        let mut keys = index_keys(self.explicit.len());
        let mut shapes = self.explicit.clone();
        let mut animate = vec![explicit_animate; shapes.len()];
        if let Some(bound) = &self.bound {
            let b = bound.borrow();
            keys.extend_from_slice(&b.keys);
            shapes.extend(b.shapes.iter().cloned());
            animate.extend_from_slice(&b.animate);
        }
        (keys, shapes, animate)
    }

    /// Pick up a layout-pass change, animated per member as the pass said.
    fn sync_bound(&mut self) {
        let Some(handle) = &self.bound else { return };
        let version = handle.borrow().version;
        if version != self.bound_seen {
            self.bound_seen = version;
            let (keys, shapes, animate) = self.combined(false);
            self.set_shapes(keys, shapes, &animate);
        }
    }

    /// Take a new shape list. Shapes are matched to the current ones by key:
    /// a kept shape whose `animate` is set tweens from where it is on screen
    /// now (so a change mid-flight continues instead of jumping); a kept
    /// shape whose target did not change keeps any tween it has; everything
    /// else, including shapes that appear, takes its target at once.
    fn set_shapes(&mut self, keys: Vec<Key>, shapes: Vec<Shape>, animate: &[bool]) {
        let old: HashMap<Key, usize> = self.keys.iter().enumerate().map(|(i, k)| (*k, i)).collect();
        let mut tweens = HashMap::new();
        let mut shown = Vec::with_capacity(shapes.len());
        let now = Instant::now();
        for (i, (key, shape)) in keys.iter().zip(&shapes).enumerate() {
            let Some(&j) = old.get(key) else {
                shown.push(shape.clone());
                continue;
            };
            let on_screen = &self.shown[j];
            if animate.get(i).copied().unwrap_or(false)
                && on_screen.sub == shape.sub
                && on_screen != shape
            {
                tweens.insert(
                    *key,
                    Tween {
                        from: on_screen.clone(),
                        start: now,
                    },
                );
                shown.push(on_screen.clone());
            } else if self.target[j] == *shape
                && let Some(tween) = self.tweens.remove(key)
            {
                tweens.insert(*key, tween);
                shown.push(on_screen.clone());
            } else {
                shown.push(shape.clone());
            }
        }
        self.keys = keys;
        self.target = shapes;
        self.shown = shown;
        self.tweens = tweens;
    }

    /// Advance every tween to now (ease-out cubic); finished ones end on
    /// their target and are dropped.
    fn step(&mut self) {
        if self.tweens.is_empty() {
            return;
        }
        for (i, key) in self.keys.iter().enumerate() {
            let Some(tween) = self.tweens.get(key) else {
                continue;
            };
            let t = (tween.start.elapsed().as_secs_f32() / ANIMATION.as_secs_f32()).min(1.0);
            if t >= 1.0 {
                self.shown[i] = self.target[i].clone();
                self.tweens.remove(key);
            } else {
                let e = 1.0 - (1.0 - t).powi(3);
                let mut shape = Shape::lerp(&tween.from, &self.target[i], e);
                // Whole device pixels in flight: a 1 px lit border on a box
                // at fractional positions changes its anti-aliasing every
                // frame and visibly crawls. Layout boxes (the targets) are
                // already on the pixel grid.
                let s = self.scale;
                let snap = |v: f32| (v * s).round() / s;
                match &shape.poly {
                    None => shape.rect = shape.rect.map(snap),
                    Some(poly) => {
                        let points = poly
                            .points
                            .iter()
                            .map(|p| [snap(p[0]), snap(p[1]), p[2]])
                            .collect();
                        if let Some(poly) = super::shape::Poly::new(points) {
                            shape.rect = poly.bounds();
                            shape.poly = Some(std::sync::Arc::new(poly));
                        }
                    }
                }
                self.shown[i] = shape;
            }
        }
    }

    fn moving(&self) -> bool {
        #[cfg(feature = "surface-demo")]
        if self.demo.moves() {
            return true;
        }
        // A layout change waiting to start an animation counts: the shell asks
        // `requires_redraw` before painting, and paint is where it starts.
        let pending = self.bound.as_ref().is_some_and(|b| {
            let b = b.borrow();
            b.version != self.bound_seen && b.animate.iter().any(|a| *a)
        });
        let settling = self.gpu.as_ref().is_some_and(|g| g.settling());
        !self.tweens.is_empty() || pending || settling
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
                Ok(shapes) => {
                    // Explicit entries are keyed by index: they animate when
                    // the list keeps its length and ops (one entry per
                    // logical shape, as authors write them).
                    let animate = shapes.len() == self.explicit.len()
                        && shapes
                            .iter()
                            .zip(&self.explicit)
                            .all(|(a, b)| a.sub == b.sub);
                    self.explicit = shapes;
                    let (keys, shapes, mut flags) = self.combined(animate);
                    // The bound part did not change here: no new tweens.
                    flags[self.explicit.len()..].fill(false);
                    self.set_shapes(keys, shapes, &flags);
                }
                Err(error) => eprintln!("tk-surface shapes: {error}"),
            }
        } else if matches!(name, "fill" | "border-color") && new.is_some_and(|v| v.contains("var("))
        {
            let var = new.and_then(var_name);
            self.resolved_for = 0;
            if name == "fill" {
                self.fill_var = var;
            } else {
                self.border_var = var;
            }
        } else {
            match name {
                "fill" => self.fill_var = None,
                "border-color" => self.border_var = None,
                _ => {}
            }
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
        styles: &ComputedStyles,
        width: u32,
        height: u32,
        scale: f64,
    ) -> Scene {
        let started = Instant::now();
        let active = self.moving();
        self.sync_bound();
        // `var(--token)` colours follow the theme (computed custom properties).
        // Blitz hands the same computed style object while the element's
        // style is unchanged, so resolve only when that object changes.
        let style_key = std::ptr::from_ref(styles) as usize;
        if (self.fill_var.is_some() || self.border_var.is_some()) && self.resolved_for != style_key
        {
            self.resolved_for = style_key;
            for (name, colour) in [
                (&self.fill_var, &mut self.look.fill),
                (&self.border_var, &mut self.look.border_colour),
            ] {
                if let Some(value) = name
                    .as_deref()
                    .and_then(|n| custom_property(styles, n))
                    .and_then(|css| parse_colour(&css))
                {
                    *colour = value;
                }
            }
        }
        self.scale = scale as f32;
        self.step();
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
        // The demo driver replaces `shown` wholesale: key it by index then.
        let index;
        let keys = if self.keys.len() == self.shown.len() {
            &self.keys
        } else {
            index = index_keys(self.shown.len());
            &index
        };
        let dirty = gpu.update(
            render_ctx,
            keys,
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

/// The CSS text of custom property `--name` in the computed style (theme
/// tokens are inherited from `:root`).
fn custom_property(styles: &ComputedStyles, name: &str) -> Option<String> {
    let props = styles.custom_properties();
    let mut index = 0;
    while let Some((key, value)) = props.property_at(index) {
        if &**key == name {
            return Some(value.as_ref()?.as_universal()?.css.clone());
        }
        index += 1;
    }
    None
}

#[cfg(test)]
impl Surface {
    pub fn shown(&self) -> &[Shape] {
        &self.shown
    }

    pub fn target(&self) -> &[Shape] {
        &self.target
    }

    pub fn keys(&self) -> &[Key] {
        &self.keys
    }

    /// Move every tween's clock back by `elapsed`, step, and report whether
    /// nothing is in flight any more.
    pub fn step_for_test(&mut self, elapsed: Duration) -> bool {
        for tween in self.tweens.values_mut() {
            tween.start -= elapsed;
        }
        self.step();
        self.tweens.is_empty()
    }

    /// Pick up the layout pass's result now (what `paint` does first).
    pub fn sync_for_test(&mut self) {
        self.sync_bound();
    }
}
