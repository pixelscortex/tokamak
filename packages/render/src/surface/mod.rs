//! Fused groups drawn as vector outlines in the ordinary Blitz scene.
mod outline;
#[cfg(test)]
#[path = "../../tests/surface/mod.rs"]
mod tests;

use anyrender::{PaintScene, Scene};
use blitz_dom::CopyStyleGetters;
use blitz_dom::{BaseDocument, LocalName, Node};
use blitz_paint::{ElementPaint, ElementPainter, Piece};
use blitz_traits::NodeId;
use outline::{Poly, Shape, resolve_attached};
use peniko::{BlendMode, Color, Fill, kurbo::Affine};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::Rc,
    time::{Duration, Instant},
};

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
#[derive(Clone, Copy, Default, PartialEq)]
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
    paint: u64,
    look: Look,
    keys: Vec<Key>,
    target: Vec<Shape>,
    shown: Vec<Shape>,
    tweens: HashMap<Key, Tween>,
    size: Option<[f32; 2]>,
    boxes: HashMap<NodeId, [f32; 4]>,
    scale: f32,
    picture: Option<(Vec<Shape>, Look, Scene)>,
    #[cfg(test)]
    builds: usize,
}
#[derive(Default)]
struct Group {
    root: Option<NodeId>,
    members: HashSet<NodeId>,
}
#[derive(Default)]
struct Registry {
    groups: HashMap<String, Group>,
    states: HashMap<NodeId, Surface>,
    paint: u64,
}
#[derive(Clone, Default)]
pub(crate) struct Surfaces(Rc<RefCell<Registry>>);
#[derive(Clone)]
pub struct SurfacePainter(Rc<RefCell<Registry>>);

impl Surfaces {
    pub(crate) fn painter(&self) -> SurfacePainter {
        SurfacePainter(self.0.clone())
    }

    pub(crate) fn attribute(&self, node: NodeId, name: &str, value: Option<&str>) {
        let mut registry = self.0.borrow_mut();
        for group in registry.groups.values_mut() {
            if name == "tk-group" && group.root == Some(node) {
                group.root = None;
            } else if name == "surface-groups" {
                group.members.remove(&node);
            }
        }
        if name == "tk-group" {
            registry.states.remove(&node);
            if let Some(value) = value {
                registry.groups.entry(value.into()).or_default().root = Some(node);
            }
        } else if let Some(value) = value {
            for name in value.split_whitespace() {
                registry
                    .groups
                    .entry(name.into())
                    .or_default()
                    .members
                    .insert(node);
            }
        }
        registry
            .groups
            .retain(|_, g| g.root.is_some() || !g.members.is_empty());
    }

    pub(crate) fn retain(&self, doc: &BaseDocument) {
        self.0
            .borrow_mut()
            .states
            .retain(|id, _| doc.get_node(*id).is_some_and(|n| n.flags.is_in_document()));
    }
}

impl<S: PaintScene> ElementPainter<S> for SurfacePainter {
    fn paint_element(&self, el: &mut ElementPaint<'_, S>, scene: &mut S) {
        let document_root = el.node().id == el.document().root_element().id;
        if document_root {
            self.0.borrow_mut().paint += 1;
        }
        el.paint_with(scene, |el, scene, piece| {
            if piece == Piece::Background
                && el.paints_own_box()
                && let Some(group) = attr(el.node(), "tk-group")
            {
                let members = self
                    .0
                    .borrow()
                    .groups
                    .get(group)
                    .filter(|g| g.root == Some(el.node().id))
                    .map(|g| g.members.iter().copied().collect::<Vec<_>>());
                if let Some(members) = members {
                    let transform = el.transform() * Affine::scale(el.scale());
                    if transform.determinant() != 0.0 {
                        let picture = self.picture(el, &members, transform);
                        scene.append_scene(picture, transform);
                    }
                }
            }
            el.piece(scene, piece);
        });
        if document_root {
            let mut registry = self.0.borrow_mut();
            let paint = registry.paint;
            registry.states.retain(|_, state| state.paint == paint);
        }
    }
}

impl SurfacePainter {
    fn picture<S: PaintScene>(
        &self,
        el: &ElementPaint<'_, S>,
        members: &[NodeId],
        root_transform: Affine,
    ) -> Scene {
        let root = el.node();
        let scale = el.scale();
        let size = css_rect(el.css_box(), scale);
        let join = number(root, "surface-join").unwrap_or(0.0).max(0.0);
        let look = root
            .primary_styles()
            .map(|s| material_of(&s))
            .unwrap_or_default();
        let mut list = vec![];
        let mut boxes = HashMap::new();
        if attr(root, "surface-own") != Some("false") {
            list.push((
                (false, false, vec![], Key::Root),
                Shape::rect(false, size, radii_of(root, size[2])),
                false,
                None,
            ));
        }
        for &member in members {
            let Some(node) = el
                .document()
                .get_node(member)
                .filter(|n| n.flags.is_in_document())
            else {
                continue;
            };
            let Some((transform, css_box)) = el.locate(member) else {
                continue;
            };
            let relative = root_transform.inverse() * transform * Affine::scale(scale);
            let [a, b, c, d, x, y] = relative.as_coeffs();
            let translation = (a - 1.0).abs() < 1e-9
                && b.abs() < 1e-9
                && c.abs() < 1e-9
                && (d - 1.0).abs() < 1e-9;
            let mut rect = css_rect(css_box, scale);
            if rect[2] <= 0.0 || rect[3] <= 0.0 {
                continue;
            }
            let shape = if translation {
                rect[0] += x as f32;
                rect[1] += y as f32;
                member_shape(node, rect, join)
            } else {
                let mut shape = Shape::rect(
                    attr(node, "surface-op") == Some("cut"),
                    rect,
                    radii_of(node, rect[2]),
                );
                shape.transform = relative;
                shape.join = number(node, "surface-join").unwrap_or(join).max(0.0);
                let bounds = relative.transform_rect_bbox(peniko::kurbo::Rect::new(
                    rect[0] as f64,
                    rect[1] as f64,
                    (rect[0] + rect[2]) as f64,
                    (rect[1] + rect[3]) as f64,
                ));
                rect = [
                    bounds.x0 as f32,
                    bounds.y0 as f32,
                    bounds.width() as f32,
                    bounds.height() as f32,
                ];
                shape
            };
            let attach = match attr(node, "surface-attach") {
                Some("left") => Some(Side::Left),
                Some("right") => Some(Side::Right),
                Some("top") => Some(Side::Top),
                Some("bottom") => Some(Side::Bottom),
                _ => None,
            }
            .filter(|_| translation && !shape.sub)
            .map(|side| Attach {
                side,
                rect,
                radii: radii_of(node, rect[2]),
                join: number(node, "surface-join").unwrap_or(join).max(0.0),
            });
            boxes.insert(member, rect);
            list.push((
                (
                    shape.sub,
                    attach.is_some(),
                    document_order(el.document(), node),
                    Key::Member(member),
                ),
                shape,
                attr(node, "surface-animate").is_some(),
                attach,
            ));
        }
        list.sort_by(|a, b| a.0.cmp(&b.0));
        resolve_attached(&mut list);
        let mut registry = self.0.borrow_mut();
        let paint = registry.paint;
        let state = registry.states.entry(root.id).or_default();
        state.paint = paint;
        state.scale = scale as f32;
        state.step();
        let size = [size[2], size[3]];
        let resized = state.size.is_some_and(|old| old != size);
        if resized {
            state.tweens.clear();
            state.shown = state.target.clone();
        }
        state.size = Some(size);
        for ((_, _, _, key), _, animate, _) in &mut list {
            *animate &= !resized
                && match key {
                    Key::Member(id) => state
                        .boxes
                        .get(id)
                        .is_some_and(|old| boxes.get(id) != Some(old)),
                    Key::Root => false,
                };
        }
        state.look = look;
        state.set_shapes(
            list.iter().map(|p| p.0.3).collect(),
            list.iter().map(|p| p.1.clone()).collect(),
            &list.iter().map(|p| p.2).collect::<Vec<_>>(),
        );
        state.boxes = boxes;
        if !state.tweens.is_empty() {
            el.document().shell_provider.request_redraw();
        }
        state.picture()
    }
}

fn css_rect(css_box: &blitz_paint::CssBox, scale: f64) -> [f32; 4] {
    let b = css_box.border_box;
    [b.x0, b.y0, b.width(), b.height()].map(|v| (v / scale) as f32)
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
        .and_then(|v| {
            if v.trim().eq_ignore_ascii_case("currentcolor") {
                Some(
                    *style
                        .clone_color()
                        .to_color_space(style::color::ColorSpace::Srgb)
                        .raw_components(),
                )
            } else {
                css_colour(&v)
            }
        })
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
    fn picture(&mut self) -> Scene {
        if !self
            .picture
            .as_ref()
            .is_some_and(|(shapes, look, _)| *shapes == self.shown && *look == self.look)
        {
            self.picture = Some((
                self.shown.clone(),
                self.look,
                draw(&self.shown, self.look, 1.0),
            ));
            #[cfg(test)]
            {
                self.builds += 1;
            }
        }
        self.picture.as_ref().unwrap().2.clone()
    }

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
        let mut edge_fill = look.fill;
        for v in &mut edge_fill[..3] {
            *v += (1.0 - *v) * look.base;
        }
        for (band, normal) in outline::bands(&region, look.bevel as f64) {
            let amount = normal * look.strength * if look.inset { -1.0 } else { 1.0 };
            scene.fill(
                Fill::EvenOdd,
                transform,
                edge_colour(edge_fill, amount),
                None,
                &outline::path(&band),
            );
        }
    }
    scene.pop_layer();
    scene
}
