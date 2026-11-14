//! Fused groups drawn as vector outlines in the ordinary Blitz scene.
mod outline;
#[cfg(test)]
#[path = "../../tests/surface/mod.rs"]
mod tests;

use anyrender::{PaintScene, RenderContext, Scene};
use blitz_dom::{
    BaseDocument, LocalName, Node,
    node::{ComputedStyles, Widget},
};
use blitz_traits::NodeId;
use outline::{Poly, Shape, resolve_attached};
use peniko::{
    BlendMode, Color, Fill,
    kurbo::{Affine, Cap, Line, Stroke},
};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::Rc,
    time::{Duration, Instant},
};

// Blitz swallows events on widget elements; layers must never be hit targets.
pub(crate) const UA_CSS: &str = "tk-surface { display: block; flex-shrink: 0; pointer-events: none; } tk-surface { pointer-events: none !important; }";
const ANIMATION: Duration = Duration::from_millis(220);
type Style = style::properties::ComputedValues;
type Placed = ((bool, bool, Vec<usize>, Key), Shape, bool, Option<Attach>);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum Key {
    Root,
    Member(NodeId),
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Side {
    Left,
    Right,
    Top,
    Bottom,
}
#[derive(Clone, Copy)]
struct Attach {
    side: Side,
    rect: [f32; 4],
    radii: [f32; 4],
    join: f32,
}
#[derive(Clone, Copy, Default)]
struct Look {
    fill: [f32; 4],
    bevel: f32,
    strength: f32,
    base: f32,
    inset: bool,
}
struct Tween {
    from: Shape,
    start: Instant,
}
#[derive(Default)]
struct Surface {
    look: Look,
    keys: Vec<Key>,
    target: Vec<Shape>,
    shown: Vec<Shape>,
    tweens: HashMap<Key, Tween>,
    size: Option<[f32; 2]>,
    boxes: HashMap<NodeId, [f32; 4]>,
    scale: f32,
}
struct Layer(Rc<RefCell<Surface>>);
#[derive(Default)]
pub(crate) struct Surfaces {
    layers: HashMap<NodeId, Rc<RefCell<Surface>>>,
    members: HashSet<NodeId>,
}

impl Surfaces {
    pub(crate) fn widget(&mut self, layer: NodeId) -> Box<dyn Widget> {
        let state = Rc::new(RefCell::new(Surface {
            scale: 1.0,
            ..Default::default()
        }));
        self.layers.insert(layer, state.clone());
        Box::new(Layer(state))
    }

    pub(crate) fn member(&mut self, node: NodeId, present: bool) {
        if present {
            self.members.insert(node);
        } else {
            self.members.remove(&node);
        }
    }

    pub(crate) fn after_layout(&mut self, doc: &BaseDocument) {
        self.layers.retain(|id, _| doc.get_node(*id).is_some());
        self.members.retain(|id| doc.get_node(*id).is_some());
        for (&id, state) in &self.layers {
            let mut state = state.borrow_mut();
            state.step();
            let mut list = vec![];
            let mut boxes = HashMap::new();
            state.look = Look::default();
            let layer = doc.get_node(id).filter(|n| n.flags.is_in_document());
            if let Some(layer) = layer
                && let Some(group) = attr(layer, "group")
                && let Some(root) = layer.parent.and_then(|p| doc.get_node(p))
                && attr(root, "tk-group") == Some(group)
                && let Some(origin) = box_of(doc, layer)
            {
                let size = [origin[2], origin[3]];
                let resized = state.size.is_some_and(|old| old != size);
                state.size = Some(size);
                if resized {
                    state.tweens.clear();
                    state.shown = state.target.clone();
                }
                let join = number(root, "surface-join").unwrap_or(0.0).max(0.0);
                if let Some(style) = root.primary_styles() {
                    state.look = material_of(&style);
                }
                if attr(root, "surface-own") != Some("false")
                    && let Some(rect) = box_of(doc, root)
                {
                    let rect = local(rect, origin);
                    list.push((
                        (false, false, vec![], Key::Root),
                        Shape::rect(false, rect, radii_of(root, rect[2])),
                        false,
                        None,
                    ));
                }
                for &member in &self.members {
                    let Some(node) = doc.get_node(member).filter(|n| n.flags.is_in_document())
                    else {
                        continue;
                    };
                    if !attr(node, "surface-groups")
                        .unwrap_or("")
                        .split_whitespace()
                        .any(|g| g == group)
                    {
                        continue;
                    }
                    let Some(rect) = box_of(doc, node) else {
                        continue;
                    };
                    let rect = local(rect, origin);
                    let shape = member_shape(node, rect, join);
                    let attach = match attr(node, "surface-attach") {
                        Some("left") => Some(Side::Left),
                        Some("right") => Some(Side::Right),
                        Some("top") => Some(Side::Top),
                        Some("bottom") => Some(Side::Bottom),
                        _ => None,
                    }
                    .filter(|_| !shape.sub)
                    .map(|side| Attach {
                        side,
                        rect,
                        radii: radii_of(node, rect[2]),
                        join: number(node, "surface-join").unwrap_or(join).max(0.0),
                    });
                    let animate = !resized
                        && attr(node, "surface-animate").is_some()
                        && state.boxes.get(&member).is_some_and(|old| *old != rect);
                    boxes.insert(member, rect);
                    list.push((
                        (
                            shape.sub,
                            attach.is_some(),
                            document_order(doc, node),
                            Key::Member(member),
                        ),
                        shape,
                        animate,
                        attach,
                    ));
                }
            }
            list.sort_by(|a, b| a.0.cmp(&b.0));
            resolve_attached(&mut list);
            let keys = list.iter().map(|p| p.0.3).collect();
            let shapes = list.iter().map(|p| p.1.clone()).collect();
            let animate: Vec<_> = list.iter().map(|p| p.2).collect();
            state.set_shapes(keys, shapes, &animate);
            state.boxes = boxes;
        }
    }
}

fn attr<'a>(node: &'a Node, name: &str) -> Option<&'a str> {
    node.attr(LocalName::from(name))
}
fn number(node: &Node, name: &str) -> Option<f32> {
    attr(node, name)?
        .trim()
        .parse::<f32>()
        .ok()
        .filter(|v| v.is_finite())
}
fn numbers(node: &Node, name: &str) -> Vec<f32> {
    attr(node, name)
        .unwrap_or("")
        .split_whitespace()
        .filter_map(|v| v.parse::<f32>().ok().filter(|v| v.is_finite()))
        .collect()
}
fn box_of(doc: &BaseDocument, node: &Node) -> Option<[f32; 4]> {
    let rect = doc.get_client_bounding_rect(node.id)?;
    (rect.width > 0.0 && rect.height > 0.0).then_some([
        rect.x as f32,
        rect.y as f32,
        rect.width as f32,
        rect.height as f32,
    ])
}
fn local(rect: [f32; 4], origin: [f32; 4]) -> [f32; 4] {
    [rect[0] - origin[0], rect[1] - origin[1], rect[2], rect[3]]
}
fn document_order(doc: &BaseDocument, node: &Node) -> Vec<usize> {
    let mut key = vec![];
    let mut node = node;
    while let Some(parent) = node.parent.and_then(|p| doc.get_node(p)) {
        key.push(
            parent
                .children
                .iter()
                .position(|id| *id == node.id)
                .unwrap_or(0),
        );
        node = parent;
    }
    key.reverse();
    key
}
fn radii_of(node: &Node, width: f32) -> [f32; 4] {
    let Some(style) = node.primary_styles() else {
        return [0.0; 4];
    };
    let border = style.get_border();
    let r = |c: &style::values::computed::BorderCornerRadius| {
        c.0.width
            .0
            .resolve(style::values::computed::Length::new(width))
            .px()
            .max(0.0)
    };
    [
        r(&border.border_top_left_radius),
        r(&border.border_top_right_radius),
        r(&border.border_bottom_right_radius),
        r(&border.border_bottom_left_radius),
    ]
}
fn material_of(style: &Style) -> Look {
    use blitz_dom::Atom;
    let props = style.custom_properties();
    let text = |name: &str| -> Option<String> {
        let atom = Atom::from(name);
        let value = props
            .non_inherited
            .get(&atom)
            .or_else(|| props.inherited.get(&atom))?;
        Some(match value.as_universal() {
            Some(text) => text.css.trim().to_string(),
            None => value.to_variable_value().css,
        })
    };
    let number = |name: &str, default: f32| {
        text(name)
            .and_then(|v| v.trim().parse::<f32>().ok())
            .filter(|v| v.is_finite())
            .unwrap_or(default)
    };
    let fill = text("tk-fill")
        .and_then(|v| css_colour(&v))
        .unwrap_or([0.0; 4]);
    Look {
        fill,
        bevel: number("tk-bevel", 0.0).max(0.0),
        base: number("tk-bevel-base", 0.0).clamp(0.0, 1.0),
        strength: number("tk-bevel-strength", 1.0).clamp(0.0, 1.0),
        inset: number("tk-bevel-inset", 0.0) == 1.0,
    }
}
fn css_colour(text: &str) -> Option<[f32; 4]> {
    use peniko::color::{Srgb, parse_color};
    Some(
        parse_color(text.trim())
            .ok()?
            .to_alpha_color::<Srgb>()
            .components
            .map(|v| {
                if v.is_finite() {
                    v.clamp(0.0, 1.0)
                } else {
                    0.0
                }
            }),
    )
}
fn member_shape(node: &Node, rect: [f32; 4], default_join: f32) -> Shape {
    let sub = attr(node, "surface-op") == Some("cut");
    let radii = radii_of(node, rect[2]);
    let join = number(node, "surface-join")
        .unwrap_or(default_join)
        .max(0.0);
    let slant = match numbers(node, "surface-slant").as_slice() {
        [a] => [*a; 2],
        [a, b] => [*a, *b],
        _ => [0.0; 2],
    }
    .map(|a| a.clamp(-75.0, 75.0));
    if slant != [0.0; 2]
        && let Some(shape) = outline::slanted(sub, rect, radii, join, slant)
    {
        return shape;
    }
    Shape {
        join,
        ..Shape::rect(sub, rect, radii)
    }
}

impl Surface {
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
                        if let Some(poly) = Poly::new(points) {
                            shape.rect = poly.bounds();
                            shape.poly = Some(std::sync::Arc::new(poly));
                        }
                    }
                }
                self.shown[i] = shape;
            }
        }
    }
}

impl Widget for Layer {
    fn requires_redraw(&self) -> bool {
        !self.0.borrow().tweens.is_empty()
    }
    fn paint(
        &mut self,
        _ctx: &mut dyn RenderContext,
        _styles: &ComputedStyles,
        _width: u32,
        _height: u32,
        scale: f64,
    ) -> Scene {
        let mut surface = self.0.borrow_mut();
        surface.scale = scale as f32;
        surface.step();
        draw(&surface.shown, surface.look, scale)
    }
}

fn edge_colour(fill: [f32; 4], amount: f32) -> Color {
    let mut c = fill;
    for v in &mut c[..3] {
        *v = if amount > 0.0 {
            *v + (1.0 - *v) * 0.18 * amount
        } else {
            *v * (1.0 + 0.45 * amount)
        };
    }
    c[3] = 1.0;
    Color::new(c)
}
fn draw(shapes: &[Shape], look: Look, scale: f64) -> Scene {
    let mut scene = Scene::new();
    if look.fill[3] <= 0.0 {
        return scene;
    }
    let region = outline::region(shapes);
    let path = outline::path(&region);
    let transform = Affine::scale(scale);
    // One opacity layer prevents translucent fills accumulating under the edge.
    scene.push_layer(
        Fill::EvenOdd,
        BlendMode::default(),
        look.fill[3],
        transform,
        &path,
        None,
        None,
    );
    scene.fill(
        Fill::EvenOdd,
        transform,
        edge_colour(look.fill, 0.0),
        None,
        &path,
    );
    if look.bevel > 0.0 {
        let stroke = Stroke::new(2.0 * look.bevel as f64).with_caps(Cap::Round);
        let mut edge_fill = look.fill;
        for v in &mut edge_fill[..3] {
            *v += (1.0 - *v) * look.base;
        }
        for poly in &region.0 {
            for (ring, hole) in std::iter::once((poly.exterior(), false))
                .chain(poly.interiors().iter().map(|r| (r, true)))
            {
                let sign = ring
                    .0
                    .windows(2)
                    .map(|p| p[0].x * p[1].y - p[1].x * p[0].y)
                    .sum::<f64>()
                    .signum()
                    * if hole { -1.0 } else { 1.0 };
                for pair in ring.0.windows(2) {
                    let (a, b) = (pair[0], pair[1]);
                    let (dx, dy) = (b.x - a.x, b.y - a.y);
                    let len = dx.hypot(dy);
                    if len == 0.0 {
                        continue;
                    }
                    let amount = (dx / len * sign) as f32
                        * look.strength
                        * if look.inset { -1.0 } else { 1.0 };
                    scene.stroke(
                        &stroke,
                        transform,
                        edge_colour(edge_fill, amount),
                        None,
                        &Line::new((a.x, a.y), (b.x, b.y)),
                    );
                }
            }
        }
    }
    scene.pop_layer();
    scene
}
