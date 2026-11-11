//! Layout binding: surfaces whose shapes come from the boxes of ordinary
//! elements, read after Blitz layout and before paint. The shapes never pass
//! through an attribute or JS; they are handed to the widget through a shared
//! handle created with it.
//!
//! Marking (set by `@tokamak/ui`'s `Surface` components, usable by hand):
//! - A surface element (`<tk-surface>`) names its group: `group="name"`.
//! - A member element joins one or more groups: `surface-groups="a b"`, with
//!   optional `surface-op` (`union` default | `subtract`), `surface-radius`
//!   (`r` or `tl tr br bl`), `surface-join`, `surface-gap`, `surface-slant`
//!   (`a` or `left right` degrees, see `slanted`) and `surface-animate`.
//!
//! A member's shape is its border box relative to the surface element's box.
//!
//! When the pass runs: once per window redraw (`NativeDocument::
//! layout_surfaces`, called by the shell after `resolve`), never on its own,
//! so an idle window does nothing. A surface's shapes change only if one of
//! its members' boxes or settings changed; the widget then re-renders only
//! the dirty area (see `tiles`).
//!
//! Identity: every shape carries its member's node id (`Key::Member`), and
//! the widget matches old and new shapes by it, never by list position. A
//! view switch that removes and adds members in the same pass as the rail
//! tab moves (switching to or from the Chat view takes the title notch and
//! the composer out of the shell layers) leaves the tab's identity intact.
//!
//! Animate or follow, per member: a member animates (220 ms, like an
//! explicit `shapes` change) from its old box to its new one only if it
//! carries `surface-animate`, it was there before, its box changed, AND the
//! surface's own size did not change in the same pass. A window resize moves
//! members and resizes surfaces together, so it never animates; layout simply
//! follows. Members that appear or disappear do so at once, and never drag
//! other shapes along.
//!
//! Order: unions before subtractions, each in document (node id) order, so a
//! cut always cuts every plate of its group.
//!
//! Plates (materials from CSS): an element marked `tk-plate` (added by the
//! build to elements whose static `class` compiles to a solid background
//! colour or a `material-*` utility, see `packages/build/src/materials.ts`),
//! or, as the fallback for classes built at run time, an unmarked one whose
//! `class` has a `material-*` or `bg-*` token (`has_plate_class`; the host
//! then sets the marker natively). Its material is whatever its computed
//! style says: `--tk-fill` (a registered `<color>`, the twin the build gives
//! every solid `background-color`), `--tk-bevel` and `--tk-elevation`
//! (registered, non-inherited custom properties, see
//! `packages/ui/src/materials.css`, so `hover:`, `active:` and
//! `aria-pressed:` variants work through CSS alone), and its shape is its
//! border box with its computed `border-radius`. A plate whose fill is
//! transparent (a conditional class that is off) is not drawn.
//!
//! A plate is drawn by the materials layer of its region: the nearest
//! element, the plate itself or an ancestor, that directly holds a
//! `<tk-surface materials>` (the shell regions and `Sheet` hold one). In a
//! layer, shapes do not fuse: each is shaded with its own material and
//! painted over the ones before it, outer elements first (a tray, then the
//! caps in it), then in document order. Plates whose box does not reach the
//! layer's box (scrolled out of view) are skipped.
//!
//! Change detection: a plate's material is re-read only when Stylo gives it
//! a new computed style object or its box changes size (`Seen` keeps the
//! style alive, so the pointer compare cannot be fooled by a reused address).
use super::shape::{Key, Paint, Poly, Shape};
use blitz_dom::{BaseDocument, LocalName, Node};
use blitz_traits::NodeId;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashMap},
    rc::Rc,
};

/// What the layout pass hands to a surface widget.
#[derive(Default)]
pub(super) struct Bound {
    pub shapes: Vec<Shape>,
    /// Per shape: its identity (`Key::Member`).
    pub keys: Vec<Key>,
    /// Per shape: animate from its previous box (see the module header).
    pub animate: Vec<bool>,
    /// Bumped on every change, so the widget notices without comparing.
    pub version: u64,
    /// Nesting depth (0 = no enclosing surface) and the surface's top-left in
    /// the window, CSS px. Kept current by every pass for depth-based lighting
    /// (not used by rendering yet; a window-level height map would be built
    /// from these, see SURFACES.md). Changes here do not bump `version`.
    pub depth: u32,
    pub origin: [f32; 2],
}

pub(super) type Handle = Rc<RefCell<Bound>>;

/// One bound shape as the lab's tests see it (`Registry::shapes_of`).
#[cfg(feature = "surface-demo")]
#[derive(Clone, Debug, PartialEq)]
pub struct MaterialShape {
    pub rect: [f32; 4],
    pub radii: [f32; 4],
    pub fill: Option<[f32; 4]>,
    pub bevel: Option<f32>,
    pub recessed: bool,
}

/// A member's shape in one surface: sort key (subtract?, attached?, depth,
/// node; depth orders plates in a materials layer and is 0 for members),
/// shape, whether it asked to animate, and its attachment if any.
type Placed = ((bool, bool, u32, NodeId), Shape, bool, Option<Attach>);

/// Which side of a member meets the edge it is attached to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Side {
    Left,
    Right,
}

/// What `attached` needs about a member with `surface-attach`.
#[derive(Clone, Copy)]
struct Attach {
    side: Side,
    rect: [f32; 4],
    radii: [f32; 4],
    join: f32,
}

struct Entry {
    handle: Handle,
    /// Last shapes handed over, by member (the widget may still be animating
    /// to them).
    last: Vec<(NodeId, Shape)>,
    /// The surface's size in the last pass, to tell a resize from a move.
    size: Option<(f32, f32)>,
}

/// Every surface widget and every member element of one document.
#[derive(Default)]
pub(crate) struct Registry {
    surfaces: HashMap<NodeId, Entry>,
    members: BTreeSet<NodeId>,
    /// Plates (see "Plates"), by how they were found.
    plates: BTreeMap<NodeId, Plate>,
    /// Per plate: the computed style its material was last read from, and
    /// that material (None: the style sets no `--tk-fill`).
    seen: HashMap<NodeId, Seen>,
}

/// How an element became a plate: the build's `tk-plate` marker, or a
/// `material-*` token in its `class` (the run-time fallback).
#[derive(Clone, Copy, Default)]
struct Plate {
    marked: bool,
    classed: bool,
}

type Style = style::servo_arc::Arc<style::properties::ComputedValues>;

struct Seen {
    style: Style,
    look: Option<(Paint, [f32; 4])>,
    width: f32,
    height: f32,
}

/// True if a `class` value can make its element a plate: a `material-*` or
/// `bg-*` utility, bare or behind variants (`active:material-key-pressed`,
/// `hover:bg-chip`). The run-time fallback for classes the build could not
/// read (see "Plates"); the element's computed `--tk-fill` then decides
/// whether anything is drawn. `bg-transparent`, `bg-current*` and
/// `bg-inherit` do not count: their colour is not the element's own, so an
/// element with only those stays Blitz's to paint.
pub(crate) fn has_plate_class(class: &str) -> bool {
    class.split_whitespace().any(|token| {
        token.rsplit(':').next().is_some_and(|u| {
            let u = u.trim_start_matches('!').trim_end_matches('!');
            u.starts_with("material-")
                || (u.starts_with("bg-")
                    && !matches!(u, "bg-transparent" | "bg-inherit")
                    && !u.starts_with("bg-current"))
        })
    })
}

/// A computed colour as straight-alpha sRGB from its serialization: a
/// registered `<color>` serializes as `rgb()`, `oklch()`, `oklab()` and so
/// on (whatever the source was: hex, a theme variable, `color-mix()`).
/// None for anything that is not one colour (`currentcolor`, a mix with it).
pub(super) fn css_colour(text: &str) -> Option<[f32; 4]> {
    use peniko::color::{Srgb, parse_color};
    let colour = parse_color(text.trim()).ok()?.to_alpha_color::<Srgb>();
    // Out-of-gamut colours (wide oklch) are clipped to sRGB.
    Some(colour.components.map(|v| {
        if v.is_finite() {
            v.clamp(0.0, 1.0)
        } else {
            0.0
        }
    }))
}

/// Paint and corner radii of a plate from its computed style. None when it
/// draws nothing: no fill or a fully transparent one, or `visibility` other
/// than visible. The element's own `opacity` scales the fill's alpha (an
/// ancestor's does not: the layer is not painted inside the ancestor).
fn material_of(style: &Style, width: f32) -> Option<(Paint, [f32; 4])> {
    use blitz_dom::Atom;
    use style::properties::longhands::visibility::computed_value::T as Visibility;
    if style.get_inherited_box().visibility != Visibility::Visible {
        return None;
    }
    let props = style.custom_properties();
    let text = |name: &str| -> Option<String> {
        let atom = Atom::from(name);
        let value = props
            .non_inherited
            .get(&atom)
            .or_else(|| props.inherited.get(&atom))?;
        // `--tk-fill` is a registered `<color>` (materials.css); the others
        // keep their text (universal syntax).
        Some(match value.as_universal() {
            Some(text) => text.css.trim().to_string(),
            None => value.to_variable_value().css,
        })
    };
    let mut fill = css_colour(&text("tk-fill")?)?;
    fill[3] *= style.get_effects().opacity.clamp(0.0, 1.0);
    if fill[3] <= 0.0 {
        return None;
    }
    // Without `bevel-*` the plate is flat.
    let bevel = text("tk-bevel")
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
        .max(0.0);
    let recessed = text("tk-elevation").as_deref() == Some("recessed");
    let border = style.get_border();
    // A corner's horizontal radius (elliptical corners are drawn circular).
    let r = |c: &style::values::computed::BorderCornerRadius| {
        c.0.width
            .0
            .resolve(style::values::computed::Length::new(width))
            .px()
            .max(0.0)
    };
    let radii = [
        r(&border.border_top_left_radius),
        r(&border.border_top_right_radius),
        r(&border.border_bottom_right_radius),
        r(&border.border_bottom_left_radius),
    ];
    Some((
        Paint {
            fill,
            bevel,
            recessed,
        },
        radii,
    ))
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

impl Registry {
    /// A new surface widget for `node`, sharing its handle with the registry.
    pub fn surface(&mut self, node: NodeId) -> Box<dyn blitz_dom::node::Widget> {
        let handle = Handle::default();
        self.surfaces.insert(
            node,
            Entry {
                handle: handle.clone(),
                last: Vec::new(),
                size: None,
            },
        );
        Box::new(super::widget::Surface::bound(handle))
    }

    /// Lab test probe: the shapes last handed to surface `node`; a shape
    /// without its own material (a group member) reports None for it.
    #[cfg(feature = "surface-demo")]
    pub fn shapes_of(&self, node: NodeId) -> Vec<MaterialShape> {
        let Some(entry) = self.surfaces.get(&node) else {
            return Vec::new();
        };
        let bound = entry.handle.borrow();
        bound
            .shapes
            .iter()
            .map(|s| MaterialShape {
                rect: s.rect,
                radii: s.radii,
                fill: s.paint.map(|p| p.fill),
                bevel: s.paint.map(|p| p.bevel),
                recessed: s.paint.is_some_and(|p| p.recessed),
            })
            .collect()
    }

    #[cfg(test)]
    pub(super) fn handle(&self, node: NodeId) -> Handle {
        self.surfaces[&node].handle.clone()
    }

    #[cfg(test)]
    pub(super) fn is_plate(&self, node: NodeId) -> bool {
        self.plates.contains_key(&node)
    }

    /// Track `surface-groups` on an element (added, changed or removed).
    pub fn member(&mut self, node: NodeId, present: bool) {
        if present {
            self.members.insert(node);
        } else {
            self.members.remove(&node);
        }
    }

    /// Track the build's `tk-plate` marker on an element.
    pub fn plate_marker(&mut self, node: NodeId, present: bool) {
        self.set_plate(node, |p| p.marked = present);
    }

    /// Track an element's `class` (the fallback: a `material-*` or `bg-*`
    /// token makes it a plate, see `has_plate_class`). Elements the build
    /// marked skip the scan. Returns the new state when the fallback turned
    /// the element into a plate or back: the host mirrors it as a `tk-plate`
    /// attribute, which is what materials.css keys on to stop Blitz painting
    /// the background under the plate.
    pub fn plate_class(&mut self, node: NodeId, class: Option<&str>) -> Option<bool> {
        if self.plates.get(&node).is_some_and(|p| p.marked) {
            return None;
        }
        let present = class.is_some_and(has_plate_class);
        let was = self.plates.get(&node).is_some_and(|p| p.classed);
        self.set_plate(node, |p| p.classed = present);
        (was != present).then_some(present)
    }

    fn set_plate(&mut self, node: NodeId, change: impl FnOnce(&mut Plate)) {
        let plate = self.plates.entry(node).or_default();
        change(plate);
        if !plate.marked && !plate.classed {
            self.plates.remove(&node);
            self.seen.remove(&node);
        }
    }

    /// The layout pass. `doc` must be resolved (styles and layout current).
    pub fn bind(&mut self, doc: &BaseDocument) {
        let live = |id: NodeId| {
            doc.get_node(id)
                .filter(|n| n.flags.is_in_document() && n.element_data().is_some())
        };
        // Forget nodes Blitz has dropped; keep detached ones (they may return).
        self.surfaces.retain(|id, _| doc.get_node(*id).is_some());
        self.members.retain(|id| doc.get_node(*id).is_some());
        self.plates.retain(|id, _| doc.get_node(*id).is_some());
        self.seen.retain(|id, _| doc.get_node(*id).is_some());

        let mut groups: HashMap<&str, NodeId> = HashMap::new();
        // Materials layers by region (the element holding the layer).
        let mut regions: HashMap<NodeId, NodeId> = HashMap::new();
        let mut boxes: HashMap<NodeId, [f32; 4]> = HashMap::new();
        for &id in self.surfaces.keys() {
            if let (Some(node), Some(rect)) = (live(id), doc.get_client_bounding_rect(id)) {
                if let Some(group) = attr(node, "group") {
                    groups.insert(group, id);
                }
                if attr(node, "materials").is_some()
                    && let Some(region) = node.parent
                {
                    regions.insert(region, id);
                }
                boxes.insert(
                    id,
                    [
                        rect.x as f32,
                        rect.y as f32,
                        rect.width as f32,
                        rect.height as f32,
                    ],
                );
            }
        }
        // (subtract?, attached?, node) sorts plain unions first, then
        // attached unions (they need their target in place, and join it
        // exactly), then subtractions, each in document order.
        let mut lists: HashMap<NodeId, Vec<Placed>> = HashMap::new();
        for &id in &self.members {
            let Some(node) = live(id) else { continue };
            let Some(rect) = doc.get_client_bounding_rect(id) else {
                continue;
            };
            if rect.width <= 0.0 && rect.height <= 0.0 {
                continue; // not rendered (display: none)
            }
            let mut joined: Vec<NodeId> = Vec::new();
            for group in attr(node, "surface-groups")
                .unwrap_or("")
                .split_whitespace()
            {
                let Some(&surface) = groups.get(group) else {
                    continue;
                };
                // One shape per member and surface: the node is its identity.
                if joined.contains(&surface) {
                    continue;
                }
                joined.push(surface);
                let origin = boxes[&surface];
                let local = [
                    rect.x as f32 - origin[0],
                    rect.y as f32 - origin[1],
                    rect.width as f32,
                    rect.height as f32,
                ];
                let shape = member_shape(node, local);
                let animate = attr(node, "surface-animate").is_some();
                let attach = match attr(node, "surface-attach") {
                    Some("right") => Some(Side::Right),
                    Some("left") => Some(Side::Left),
                    _ => None,
                }
                .filter(|_| !shape.sub)
                .map(|side| Attach {
                    side,
                    rect: local,
                    radii: shape.radii,
                    // The member's join, else the surface's default.
                    join: number(node, "surface-join")
                        .or_else(|| live(surface).and_then(|n| number(n, "join")))
                        .unwrap_or(0.0)
                        .max(0.0),
                });
                lists.entry(surface).or_default().push((
                    (shape.sub, attach.is_some(), 0, id),
                    shape,
                    animate,
                    attach,
                ));
            }
        }
        if !regions.is_empty() {
            self.place_plates(doc, &regions, &boxes, &mut lists);
        }
        // Depth: ancestors that directly contain another registered surface
        // element (a `Surface` component's root holds its `<tk-surface>`).
        let holders: std::collections::HashSet<NodeId> = boxes
            .keys()
            .filter_map(|id| doc.get_node(*id).and_then(|n| n.parent))
            .collect();
        for (id, entry) in &mut self.surfaces {
            let Some(origin) = boxes.get(id) else {
                continue;
            };
            {
                let own = doc.get_node(*id).and_then(|n| n.parent);
                let mut current = own.and_then(|p| doc.get_node(p)).and_then(|n| n.parent);
                let mut depth = 0;
                while let Some(ancestor) = current {
                    depth += u32::from(holders.contains(&ancestor));
                    current = doc.get_node(ancestor).and_then(|n| n.parent);
                }
                let mut bound = entry.handle.borrow_mut();
                bound.depth = depth;
                bound.origin = [origin[0], origin[1]];
            }
            let size = (origin[2], origin[3]);
            let mut list = lists.remove(id).unwrap_or_default();
            list.sort_by_key(|(key, ..)| *key);
            resolve_attached(&mut list);
            let next: Vec<(NodeId, Shape)> = list
                .iter()
                .map(|((_, _, _, node), shape, ..)| (*node, shape.clone()))
                .collect();
            if next != entry.last {
                let resized = entry.size.is_some_and(|s| s != size);
                // Per member: animate only if it asked to, was there before
                // and its own box changed.
                let animate: Vec<bool> = list
                    .iter()
                    .map(|((_, _, _, node), shape, wants, _)| {
                        *wants
                            && !resized
                            && entry.last.iter().any(|(n, old)| n == node && old != shape)
                    })
                    .collect();
                let mut bound = entry.handle.borrow_mut();
                bound.keys = next.iter().map(|(n, _)| Key::Member(*n)).collect();
                bound.shapes = next.iter().map(|(_, s)| s.clone()).collect();
                bound.animate = animate;
                bound.version += 1;
                entry.last = next;
            }
            entry.size = Some(size);
        }
    }

    /// Plates into the lists of their regions' layers (see "Plates").
    fn place_plates(
        &mut self,
        doc: &BaseDocument,
        regions: &HashMap<NodeId, NodeId>,
        boxes: &HashMap<NodeId, [f32; 4]>,
        lists: &mut HashMap<NodeId, Vec<Placed>>,
    ) {
        for &id in self.plates.keys() {
            let Some(node) = doc
                .get_node(id)
                .filter(|n| n.flags.is_in_document() && n.element_data().is_some())
            else {
                continue;
            };
            let Some(rect) = doc.get_client_bounding_rect(id) else {
                continue;
            };
            let (w, h) = (rect.width as f32, rect.height as f32);
            if w <= 0.0 || h <= 0.0 {
                continue; // not rendered (display: none)
            }
            // Blitz moves an element's client rect by its own scroll offset
            // too; a plate that scrolls its content stays where it is.
            let scroll = node.scroll_offset();
            let (x, y) = ((rect.x + scroll.x) as f32, (rect.y + scroll.y) as f32);
            // The nearest region, starting at the plate itself (a `Sheet`
            // with its own material draws in its own layer), and the plate's
            // depth in the document (outer plates paint first).
            let mut layer = None;
            let mut depth = 0u32;
            let mut current = Some(id);
            while let Some(at) = current {
                if layer.is_none() {
                    layer = regions.get(&at).copied();
                }
                depth += 1;
                current = doc.get_node(at).and_then(|n| n.parent);
            }
            let Some(layer) = layer else { continue };
            let origin = boxes[&layer];
            let local = [x - origin[0], y - origin[1], w, h];
            // Out of the layer's box (scrolled away): nothing to draw.
            if local[0] >= origin[2]
                || local[1] >= origin[3]
                || local[0] + w <= 0.0
                || local[1] + h <= 0.0
            {
                continue;
            }
            let Some(style) = node.primary_styles().map(|s| (*s).clone()) else {
                continue;
            };
            let look = match self.seen.get(&id) {
                Some(seen)
                    if Style::ptr_eq(&seen.style, &style)
                        && seen.width == w
                        && seen.height == h =>
                {
                    seen.look
                }
                _ => {
                    let look = material_of(&style, w);
                    self.seen.insert(
                        id,
                        Seen {
                            style,
                            look,
                            width: w,
                            height: h,
                        },
                    );
                    look
                }
            };
            let Some((paint, radii)) = look else { continue };
            let shape = Shape {
                paint: Some(paint),
                ..Shape::rect(false, local, radii)
            };
            lists
                .entry(layer)
                .or_default()
                .push(((false, false, depth, id), shape, false, None));
        }
    }
}

/// Replace each attached member's shape by its exact outline against the
/// plain union it touches (see `attached`). A member whose target is missing
/// keeps its plain rounded box.
fn resolve_attached(list: &mut [Placed]) {
    let targets: Vec<Shape> = list
        .iter()
        .filter(|((sub, attached, ..), s, ..)| !sub && !attached && s.poly.is_none())
        .map(|(_, s, ..)| s.clone())
        .collect();
    for (_, shape, _, attach) in list.iter_mut() {
        let Some(a) = attach else { continue };
        let [x, y, w, h] = a.rect;
        let edge = match a.side {
            Side::Right => x + w,
            Side::Left => x,
        };
        let target = targets.iter().find(|t| {
            let [tx, ty, tw, th] = t.rect;
            let touching = match a.side {
                Side::Right => (tx - edge).abs() < 0.5,
                Side::Left => (tx + tw - edge).abs() < 0.5,
            };
            touching && ty < y + h && ty + th > y
        });
        if let Some(outline) =
            target.and_then(|t| attached(a.side, a.rect, a.radii, a.join, t.rect, t.radii))
        {
            *shape = outline;
        }
    }
}

/// A member attached by one side (`surface-attach`) to a vertical edge of
/// the plain union shape it touches (a rail tab against its container), as
/// ONE exact outline: the member's free corners keep its own radii, the two
/// places where its top and bottom edges meet the target's edge carry
/// concave fillets of radius `join`, and a strip running along the inside of
/// the target's whole edge (and around its corners, with the target's own
/// corner radii) closes the outline. The CSG join of the result is 0 and it
/// sorts after its target: a plain union of exactly coincident boundaries,
/// so nothing bulges. (A CSG round join treats two collinear boundaries as a
/// crease and fills it, which is what made a tab level with the container's
/// top bulge.)
///
/// Near the target's corner the fillet flattens: with the member's top `d`
/// px below the target's top, the fillet and the target's corner share the
/// leg between them as an S-curve until there is room for both (at
/// `d = 2 * max(join, corner)`). At `d = 0` both are gone: the member's top
/// edge runs straight into the target's top edge, the strip covering the
/// target's rounded corner. Same at the bottom. The outline always has 8
/// vertices, so an animating member interpolates them continuously.
pub(super) fn attached(
    side: Side,
    rect: [f32; 4],
    radii: [f32; 4],
    join: f32,
    target: [f32; 4],
    target_radii: [f32; 4],
) -> Option<Shape> {
    // Work as if attached on the right; mirror x for the left side.
    let mirror = side == Side::Left;
    let flip = |r: [f32; 4]| {
        if mirror {
            [-r[0] - r[2], r[1], r[2], r[3]]
        } else {
            r
        }
    };
    let [x, y, w, h] = flip(rect);
    let [_, ty, tw, th] = flip(target);
    // Member corners on the free side, target corners on the attached edge
    // (tl tr br bl, as seen after mirroring).
    let (tl, bl) = if mirror {
        (radii[1], radii[2])
    } else {
        (radii[0], radii[3])
    };
    let (ct, cb) = if mirror {
        (target_radii[1], target_radii[2])
    } else {
        (target_radii[0], target_radii[3])
    };
    let edge = x + w;
    let (top, bottom) = (ty, ty + th);
    // How much of the fillet and the target's corner fit in the leg between.
    let room = |d: f32, corner: f32| {
        let full = 2.0 * join.max(corner);
        if full <= 0.0 {
            1.0
        } else {
            (d.max(0.0) / full).min(1.0)
        }
    };
    let st = room(y - top, ct);
    let sb = room(bottom - (y + h), cb);
    // Wide enough that the target's corner arc fits on the strip's top and
    // bottom edges (a vertex arc may use at most half of each edge).
    let strip = edge + (2.0 * join.max(ct).max(cb) + 2.0).min(tw);
    let (yt, yb) = (top.min(y), bottom.max(y + h));
    let mut points = vec![
        [x, y, tl],
        [edge, y, join * st],
        [edge, yt, ct * st],
        [strip, yt, 0.0],
        [strip, yb, 0.0],
        [edge, yb, cb * sb],
        [edge, y + h, join * sb],
        [x, y + h, bl],
    ];
    if mirror {
        for p in &mut points {
            p[0] = -p[0];
        }
    }
    let mut shape = Shape::from_poly(false, Poly::new(points)?);
    shape.join = 0.0;
    Some(shape)
}

/// A member's shape from its box (CSS px, relative to the surface) and its
/// `surface-*` settings.
fn member_shape(node: &Node, rect: [f32; 4]) -> Shape {
    let sub = attr(node, "surface-op") == Some("subtract");
    let radii = match numbers(node, "surface-radius").as_slice() {
        [r] => [r.max(0.0); 4],
        [a, b, c, d] => [*a, *b, *c, *d].map(|v| v.max(0.0)),
        _ => [0.0; 4],
    };
    let join = number(node, "surface-join").map_or(-1.0, |v| v.max(0.0));
    let gap = number(node, "surface-gap").map_or(-1.0, |v| v.max(0.0));
    let slant = match numbers(node, "surface-slant").as_slice() {
        [a] => [*a; 2],
        [a, b] => [*a, *b],
        _ => [0.0; 2],
    }
    .map(|a| a.clamp(-75.0, 75.0));
    if slant != [0.0; 2]
        && let Some(shape) = slanted(sub, rect, radii, join.max(0.0), slant)
    {
        return Shape { gap, ..shape };
    }
    Shape {
        join,
        gap,
        ..Shape::rect(sub, rect, radii)
    }
}

/// A member with leaning sides, as an exact outline. `slant` is degrees from
/// vertical per side (left, right); positive leans the side outward towards
/// the top, so the top is the wide end; negative angles make the bottom wide.
/// The wide end is the end that meets the plate edge (a notch hanging from a
/// top edge, a composer rising from a bottom edge): the outline continues
/// along that edge line beyond both sides, and the two vertices where the
/// sides meet that line carry the `join` radius. Those vertices become exact
/// circular fillets of radius `join`, tangent to the side and to the edge, at
/// any angle (CSG joins are exact only at 90 degrees). The far corners carry
/// the member's own radii. The CSG join of the shape is 0: the outline
/// already contains the fillets.
pub(super) fn slanted(
    sub: bool,
    rect: [f32; 4],
    radii: [f32; 4],
    join: f32,
    slant: [f32; 2],
) -> Option<Shape> {
    let [x, y, w, h] = rect;
    let [tl, tr] = slant.map(|a| a.to_radians().tan());
    // How far the outline continues along the edge line, and beyond it.
    let ext = join * 3.0 + 4.0;
    let points = if tl + tr >= 0.0 {
        // Wide at the top (y): far corners at the bottom keep x..x+w.
        let (jl, jr) = (x - h * tl, x + w + h * tr);
        vec![
            [jl - ext, y - ext, 0.0],
            [jr + ext, y - ext, 0.0],
            [jr + ext, y, 0.0],
            [jr, y, join],
            [x + w, y + h, radii[2]],
            [x, y + h, radii[3]],
            [jl, y, join],
            [jl - ext, y, 0.0],
        ]
    } else {
        // Wide at the bottom (y + h): far corners at the top keep x..x+w.
        let (jl, jr) = (x + h * tl, x + w - h * tr);
        let b = y + h;
        vec![
            [jl - ext, b, 0.0],
            [jl, b, join],
            [x, y, radii[0]],
            [x + w, y, radii[1]],
            [jr, b, join],
            [jr + ext, b, 0.0],
            [jr + ext, b + ext, 0.0],
            [jl - ext, b + ext, 0.0],
        ]
    };
    let mut shape = Shape::from_poly(sub, Poly::new(points)?);
    shape.join = 0.0;
    Some(shape)
}
