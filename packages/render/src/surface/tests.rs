//! Behaviour of the surface maths and widget, checked on the CPU reference.
//! The GPU path is exercised by the lab's offscreen tests (lab/tests).
use super::reference::{field, raster, shade};
use super::shape::{
    Align, Key, Look, Poly, Shape, V2, dot2, index_keys, len2, parse_colour, parse_shapes,
};
use super::tiles::dirty_rects;
use super::widget::{ANIMATION, Surface};
use blitz_dom::node::Widget;

fn px(buf: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * width + x) * 4) as usize;
    buf[i..i + 4].try_into().unwrap()
}

fn field_all(shapes: &[Shape], look: &Look, p: V2) -> f32 {
    let all: Vec<u32> = (0..shapes.len() as u32).collect();
    field(shapes, &all, look, p)
}

#[test]
fn attribute_format_parses_corners_circles_polys_and_overrides() {
    let shapes = parse_shapes(
        r#"[{"op":"add","x":0,"y":0,"w":100,"h":50,"r":[1,2,3,4]},
            {"op":"sub","kind":"circle","x":10,"y":10,"w":20,"h":30,"gap":3,"join":5},
            {"op":"add","kind":"poly","points":[[0,0],[40,0,6],[40,30,2]]}]"#,
    )
    .unwrap();
    assert_eq!(shapes[0].radii, [1.0, 2.0, 3.0, 4.0]);
    assert!(shapes[1].sub);
    assert_eq!(shapes[1].radii, [10.0; 4]);
    assert_eq!((shapes[1].join, shapes[1].gap), (5.0, 3.0));
    assert_eq!(shapes[2].rect, [0.0, 0.0, 40.0, 30.0]);
    assert!(parse_shapes(r#"[{"op":"add","x":0,"y":0,"w":-1,"h":1}]"#).is_err());
    assert!(parse_shapes(r#"[{"op":"mul","x":0,"y":0,"w":1,"h":1}]"#).is_err());
    assert!(parse_shapes(r#"[{"op":"add","kind":"poly","points":[[0,0],[1,1]]}]"#).is_err());
    assert!(parse_shapes(r#"[{"op":"add","x":0,"y":0,"w":1,"h":1,"slant":30}]"#).is_err());
    assert_eq!(parse_colour("#1b1b1b").unwrap()[0], 27.0 / 255.0);
    assert!(parse_colour("1b1b1b").is_none());
}

#[test]
fn join_between_two_shapes_is_an_exact_fillet_at_ninety_degrees() {
    // An L of two rectangles meeting at (10, 10): the inner corner gets a
    // quarter circle of radius k centred at (10 + k, 10 + k).
    let look = Look::default();
    let k = 6.0;
    let mut a = Shape::rect(false, [0.0, 0.0, 10.0, 40.0], [0.0; 4]);
    let mut b = Shape::rect(false, [0.0, 0.0, 40.0, 10.0], [0.0; 4]);
    a.join = k;
    b.join = k;
    let shapes = [a, b];
    let corner = [10.0 + k, 10.0 + k];
    let on_arc = [corner[0] - k * 0.70710677, corner[1] - k * 0.70710677];
    assert!(field_all(&shapes, &look, on_arc).abs() < 1e-3);
    assert!((field_all(&shapes, &look, corner) - k).abs() < 1e-3);
    assert!(field_all(&shapes, &look, [30.0, 10.0]).abs() < 1e-4);
}

#[test]
fn edges_facing_the_light_are_lighter_and_recessed_inverts() {
    let mut look = Look::default();
    let plate = [Shape::rect(false, [2.0, 2.0, 36.0, 36.0], [8.0; 4])];
    let buf = raster(&plate, &look, 40, 40, 1.0);
    let (fill, top, bottom) = (
        px(&buf, 40, 20, 20),
        px(&buf, 40, 20, 2),
        px(&buf, 40, 20, 37),
    );
    assert_eq!(fill[3], 255);
    assert!(
        top[0] > fill[0] && bottom[0] < fill[0],
        "{top:?} {fill:?} {bottom:?}"
    );
    assert_eq!(px(&buf, 40, 0, 0)[3], 0, "outside is transparent");
    look.recessed = true;
    let buf = raster(&plate, &look, 40, 40, 1.0);
    assert!(px(&buf, 40, 20, 2)[0] < fill[0] && px(&buf, 40, 20, 37)[0] > fill[0]);
}

#[test]
fn gap_cut_leaves_a_ring_and_an_island() {
    let look = Look::default();
    let shapes = parse_shapes(
        r#"[{"op":"add","x":0,"y":0,"w":100,"h":100},
            {"op":"sub","kind":"circle","x":40,"y":40,"w":20,"h":20,"gap":3}]"#,
    )
    .unwrap();
    assert!(field_all(&shapes, &look, [50.0, 50.0]) < 0.0, "island");
    assert!(field_all(&shapes, &look, [61.5, 50.0]) > 0.0, "gap ring");
    assert!(field_all(&shapes, &look, [70.0, 50.0]) < 0.0, "plate");
}

/// Panel top edge (y = 0) with a notch whose right side leans by `angle`
/// from vertical, sweeping into the top edge. Returns the outline and the
/// arc centres expected from geometry alone (independent of `Poly`): the
/// join (where the side meets the top edge, convex for the panel material)
/// is r inside the material from both lines; the notch corner (concave for
/// the material) is r inside the notch from both lines.
fn notch(angle: f32, join: f32, corner: f32) -> (Shape, V2, V2) {
    let (depth, right) = (40.0, 120.0);
    let lean = depth * angle.to_radians().tan();
    let poly = Poly::new(vec![
        [0.0, 0.0, 0.0],
        [40.0, 0.0, 0.0],
        [40.0, depth, 0.0],
        [right, depth, corner],
        [right + lean, 0.0, join],
        [300.0, 0.0, 0.0],
        [300.0, 200.0, 0.0],
        [0.0, 200.0, 0.0],
    ])
    .unwrap();
    // Unit normal of the slanted side pointing into the material (right).
    let side = [lean, -depth];
    let l = len2(side);
    let into = [depth / l, lean / l];
    let p0 = [right, depth];
    // Points with dot(q - p0, into) = d at a given y.
    let at = |y: f32, d: f32| [p0[0] + (d - (y - p0[1]) * into[1]) / into[0], y];
    (
        Shape::from_poly(false, poly),
        at(join, join),
        at(depth - corner, -corner),
    )
}

#[test]
fn poly_joins_and_corners_are_true_arcs_at_any_angle() {
    let look = Look::default();
    for angle in [15.0_f32, 30.0, 45.0, 60.0] {
        let (join, corner) = (14.0, 10.0);
        let (shape, join_c, corner_c) = notch(angle, join, corner);
        let shapes = [shape];
        for (c, r, label) in [(join_c, join, "join"), (corner_c, corner, "corner")] {
            // Points at radius r from the expected centre lie on the outline
            // along the arc's span, and the centre is exactly r from it: the
            // arc is circular, has the requested radius, and is tangent to
            // both edges (its centre is r from each line).
            let on_arc = (0..=72)
                .map(|step| (step as f32 * 5.0).to_radians())
                .filter(|a| {
                    let p = [c[0] + r * a.cos(), c[1] + r * a.sin()];
                    field_all(&shapes, &look, p).abs() < 1e-3
                })
                .count();
            assert!(
                on_arc >= 3,
                "{angle} deg {label}: {on_arc} samples on the arc"
            );
            let d = field_all(&shapes, &look, c).abs();
            assert!(
                (d - r).abs() < 1e-3,
                "{angle} deg {label}: centre {d} from outline, r {r}"
            );
        }
        // Normals turn smoothly along the outline (no kink at tangent points),
        // so the bevel and a lit border stay clean.
        let normal = |p: V2| {
            let e = 1e-3;
            let d = field_all(&shapes, &look, p);
            let g = [
                field_all(&shapes, &look, [p[0] + e, p[1]]) - d,
                field_all(&shapes, &look, [p[0], p[1] + e]) - d,
            ];
            let l = len2(g);
            [g[0] / l, g[1] / l]
        };
        let mut prev: Option<V2> = None;
        for x in 100..=220 {
            let x = x as f32;
            let inside = |y: f32| field_all(&shapes, &look, [x, y]) < 0.0;
            let (mut lo, mut hi) = (-1.0_f32, 39.0_f32);
            if inside(lo) == inside(hi) {
                continue;
            }
            for _ in 0..40 {
                let mid = (lo + hi) * 0.5;
                if inside(mid) == inside(lo) {
                    lo = mid
                } else {
                    hi = mid
                }
            }
            let n = normal([x, (lo + hi) * 0.5]);
            if let Some(p) = prev {
                assert!(dot2(n, p) > 0.9, "{angle} deg: kink near x={x}");
            }
            prev = Some(n);
        }
    }
}

#[test]
fn border_follows_the_silhouette_and_lit_border_takes_the_light() {
    let mut look = Look {
        border: 2.0,
        border_colour: [0.5, 0.5, 0.5, 1.0],
        ..Look::default()
    };
    let plate = parse_shapes(r#"[{"op":"add","x":4,"y":4,"w":32,"h":32,"r":6}]"#).unwrap();
    let buf = raster(&plate, &look, 40, 40, 1.0);
    let (top, centre) = (px(&buf, 40, 20, 5), px(&buf, 40, 20, 20));
    assert!(top[0] > 100 && centre[0] < 40, "{top:?} {centre:?}");
    look.border_lit = 1.0;
    let buf = raster(&plate, &look, 40, 40, 1.0);
    let (top, bottom) = (px(&buf, 40, 20, 5), px(&buf, 40, 20, 34));
    assert!(top[0] > 128 && bottom[0] < 128, "{top:?} {bottom:?}");
    // A calm hairline: `border-mix` derives the colour from the fill, and a
    // low `border-lit` leaves only a small bias between top and bottom; at
    // 0 the hairline is flat all round.
    let mut calm = Look {
        border: 1.0,
        border_mix: 0.055,
        border_lit: 0.25,
        ..Look::default()
    };
    let (top_y, bottom_y) = (4, 35);
    let swing = |look: &Look| {
        let buf = raster(&plate, look, 40, 40, 1.0);
        (
            px(&buf, 40, 20, top_y)[0] as i32,
            px(&buf, 40, 20, bottom_y)[0] as i32,
        )
    };
    let (full_top, full_bottom) = swing(&look);
    let (top, bottom) = swing(&calm);
    assert!(top > bottom, "still a hint of light: {top} {bottom}");
    assert!(
        (top - bottom) * 3 < full_top - full_bottom,
        "much less swing than fully lit: {top}/{bottom} vs {full_top}/{full_bottom}"
    );
    calm.border_lit = 0.0;
    let (top, bottom) = swing(&calm);
    assert_eq!(top, bottom, "flat hairline");
    // 5.5% of the way from the fill (0x12) to white.
    let want = (0x12 as f32 + (255.0 - 0x12 as f32) * 0.055).round() as i32;
    assert!((top - want).abs() <= 1, "{top} vs {want}");
    look.border_align = Align::Outside;
    let buf = raster(&plate, &look, 40, 40, 1.0);
    assert!(
        px(&buf, 40, 20, 3)[3] > 200,
        "outside border paints beyond the shape"
    );
}

#[test]
fn culling_and_partial_rects_do_not_change_any_pixel() {
    // Many fused shapes with a gap cut, border and bevel.
    let look = Look {
        join: 12.0,
        border: 1.5,
        border_lit: 1.0,
        ..Look::default()
    };
    let mut shapes: Vec<Shape> = (0..60)
        .map(|i| {
            let (x, y) = ((i * 37 % 300) as f32, (i * 53 % 180) as f32);
            Shape::rect(false, [x, y, 26.0, 26.0], [7.0; 4])
        })
        .collect();
    shapes.extend(
        parse_shapes(r#"[{"op":"sub","kind":"circle","x":150,"y":90,"w":40,"h":40,"gap":3}]"#)
            .unwrap(),
    );
    let (w, h, scale) = (330, 210, 1.0);
    // Culled (per-tile lists) equals evaluating every shape.
    let culled = raster(&shapes, &look, w, h, scale);
    let all: Vec<u32> = (0..shapes.len() as u32).collect();
    for y in (0..h).step_by(3) {
        for x in (0..w).step_by(3) {
            let full = shade(
                &shapes,
                &all,
                &look,
                [x as f32 + 0.5, y as f32 + 0.5],
                scale,
            );
            let got = px(&culled, w, x, y);
            let diff = full
                .iter()
                .zip(got)
                .map(|(a, b)| a.abs_diff(b))
                .max()
                .unwrap();
            assert!(diff <= 1, "({x},{y}): {full:?} vs {got:?}");
        }
    }
    // Moving one shape dirties one rect, and nothing outside it changes.
    let mut moved = shapes.clone();
    moved[3].rect[0] += 10.0;
    let keys = index_keys(shapes.len());
    let rects = dirty_rects((&keys, &shapes), (&keys, &moved), &look, w, h, scale).unwrap();
    assert_eq!(rects.len(), 1);
    let after = raster(&moved, &look, w, h, scale);
    let [rx, ry, rw, rh] = rects[0];
    for y in 0..h {
        for x in 0..w {
            if !(x >= rx && x < rx + rw && y >= ry && y < ry + rh) {
                assert_eq!(px(&culled, w, x, y), px(&after, w, x, y), "({x},{y})");
            }
        }
    }
    // Identical shapes: nothing to re-render.
    assert_eq!(
        dirty_rects((&keys, &shapes), (&keys, &shapes), &look, w, h, scale),
        Some(vec![])
    );
    // Removing a shape from the middle of the list (shapes matched by key,
    // so the ones after it do not count as moved) dirties only its old area,
    // and nothing outside that area changes.
    let removed = 7;
    let (fewer_keys, fewer): (Vec<Key>, Vec<Shape>) = keys
        .iter()
        .zip(&shapes)
        .enumerate()
        .filter(|(i, _)| *i != removed)
        .map(|(_, (k, s))| (*k, s.clone()))
        .unzip();
    let rects = dirty_rects((&keys, &shapes), (&fewer_keys, &fewer), &look, w, h, scale).unwrap();
    assert_eq!(rects.len(), 1, "one area: the removed shape's");
    let [x0, y0, x1, y1] = super::tiles::influence(&look, &shapes[removed]);
    let [rx, ry, rw, rh] = rects[0];
    assert!(
        rx as f32 <= x0.max(0.0) && ry as f32 <= y0.max(0.0),
        "{rects:?} covers the old area"
    );
    assert!(((rx + rw) as f32) >= x1.min(w as f32) && ((ry + rh) as f32) >= y1.min(h as f32));
    let after = raster(&fewer, &look, w, h, scale);
    for y in 0..h {
        for x in 0..w {
            if !(x >= rx && x < rx + rw && y >= ry && y < ry + rh) {
                assert_eq!(px(&culled, w, x, y), px(&after, w, x, y), "({x},{y})");
            }
        }
    }
}

#[test]
fn shape_changes_animate_by_index_and_stop_requesting_redraws() {
    let mut surface = Surface::new();
    let a = r#"[{"op":"add","x":0,"y":0,"w":20,"h":20}]"#;
    let b = r#"[{"op":"add","x":10,"y":0,"w":20,"h":20}]"#;
    surface.attribute_changed("shapes", None, Some(a));
    assert!(
        !surface.requires_redraw(),
        "first geometry does not animate"
    );
    surface.attribute_changed("shapes", Some(a), Some(b));
    assert!(surface.requires_redraw());
    surface.step_for_test(Default::default());
    assert!(
        surface.shown()[0].rect[0] < 10.0,
        "starts near the old position"
    );
    assert!(
        surface.step_for_test(ANIMATION),
        "finishes after the duration"
    );
    assert_eq!(surface.shown(), surface.target());
}

// ---------------------------------------------------------------- layout binding

mod binding {
    use super::super::bind::{Registry, Side, attached, slanted};
    use super::super::shape::Look;
    use super::super::tiles::dirty_rects;
    use super::super::widget::{ANIMATION, Surface};
    use super::field_all;
    use blitz_dom::node::Widget;
    use blitz_dom::{Document, LocalName, Namespace, QualName};
    use blitz_html::HtmlDocument;
    use blitz_traits::{NodeId, shell::Viewport};

    const HTML: &str = r#"<html><body style="margin:0">
      <div style="position:relative;width:100%;height:200px">
        <tk-surface id="surface" group="g"
          style="position:absolute;left:0;top:0;width:100%;height:100%"></tk-surface>
        <div id="plate" surface-groups="g" surface-radius="8"
          style="position:absolute;left:10px;top:10px;width:50%;height:120px"></div>
        <div id="tab" surface-groups="g" surface-animate=""
          style="position:absolute;left:20px;top:150px;width:30px;height:30px"></div>
        <div id="other" surface-groups="elsewhere"
          style="position:absolute;left:0;top:0;width:10px;height:10px"></div>
        <div id="notch" surface-groups="g" surface-op="subtract" surface-radius="6"
          style="position:absolute;left:100px;top:10px;width:60px;height:20px"></div>
        <div id="composer" surface-groups="g" surface-op="subtract"
          style="position:absolute;left:100px;top:100px;width:80px;height:30px"></div>
        <div id="fresh" surface-groups="g"
          style="position:absolute;left:300px;top:150px;width:40px;height:30px"></div>
      </div></body></html>"#;

    struct Fixture {
        doc: HtmlDocument,
        registry: Registry,
        surface: NodeId,
    }

    impl Fixture {
        /// The plate, the tab and a member of another group.
        fn new() -> Self {
            Self::with(&["plate", "tab", "other"])
        }

        /// The fixture with only `members` registered (the others are not
        /// members yet, like elements a view has not mounted).
        fn with(members: &[&str]) -> Self {
            let doc = HtmlDocument::from_html(HTML, Default::default());
            let id = |doc: &HtmlDocument, name: &str| doc.inner().get_element_by_id(name).unwrap();
            let mut registry = Registry::default();
            let surface = id(&doc, "surface");
            let _widget = registry.surface(surface);
            for member in members {
                registry.member(id(&doc, member), true);
            }
            let mut fixture = Fixture {
                doc,
                registry,
                surface,
            };
            fixture.resize(400);
            fixture
        }

        fn id(&self, name: &str) -> NodeId {
            self.doc.inner().get_element_by_id(name).unwrap()
        }

        fn resize(&mut self, width: u32) {
            self.doc.inner_mut().set_viewport(Viewport {
                window_size: (width, 300),
                ..Default::default()
            });
        }

        fn style(&mut self, name: &str, style: &str) {
            let node = self.id(name);
            let attr = QualName::new(None, Namespace::from(""), LocalName::from("style"));
            self.doc
                .inner_mut()
                .mutate()
                .set_attribute(node, attr, style);
        }

        /// One frame's pass: layout, then binding. Returns (version, animate).
        fn frame(&mut self) -> (u64, bool) {
            self.doc.inner_mut().resolve(0.0);
            self.registry.bind(&mut self.doc.inner_mut());
            let handle = self.registry.handle(self.surface);
            let b = handle.borrow();
            (b.version, b.animate.iter().any(|a| *a))
        }

        fn member(&mut self, name: &str, present: bool) {
            let node = self.id(name);
            self.registry.member(node, present);
        }

        /// A widget sharing this surface's handle, synced to the last pass.
        fn widget(&self) -> Surface {
            let mut widget = Surface::bound(self.registry.handle(self.surface));
            widget.sync_for_test();
            widget
        }

        fn shapes(&self) -> Vec<super::Shape> {
            self.registry.handle(self.surface).borrow().shapes.clone()
        }
    }

    #[test]
    fn members_become_shapes_relative_to_the_surface_and_idle_frames_change_nothing() {
        let mut f = Fixture::new();
        assert_eq!(f.frame().0, 1);
        let shapes = f.shapes();
        assert_eq!(
            shapes.len(),
            2,
            "the member of another group is not included"
        );
        assert_eq!(shapes[0].rect, [10.0, 10.0, 200.0, 120.0]);
        assert_eq!(shapes[0].radii, [8.0; 4]);
        assert_eq!(shapes[1].rect, [20.0, 150.0, 30.0, 30.0]);
        // Nothing changed: no new version, so the widget has nothing to do and
        // requests no frames.
        assert_eq!(f.frame().0, 1);
        let widget = Surface::bound(f.registry.handle(f.surface));
        assert!(!widget.requires_redraw());
    }

    #[test]
    fn members_follow_layout_on_resize_without_animating() {
        let mut f = Fixture::new();
        f.frame();
        f.resize(300);
        let (version, animate) = f.frame();
        assert_eq!(version, 2);
        assert!(!animate, "a resize follows, it does not animate");
        assert_eq!(f.shapes()[0].rect, [10.0, 10.0, 150.0, 120.0]);
    }

    #[test]
    fn a_moving_member_animates_and_dirties_only_its_own_area() {
        let mut f = Fixture::new();
        f.frame();
        let before = f.shapes();
        f.style(
            "tab",
            "position:absolute;left:120px;top:150px;width:30px;height:30px",
        );
        let (version, animate) = f.frame();
        assert_eq!(version, 2);
        assert!(
            animate,
            "a member that asked to animate, in an unchanged surface"
        );
        let widget = Surface::bound(f.registry.handle(f.surface));
        assert!(
            widget.requires_redraw(),
            "the pending animation requests frames"
        );
        let after = f.shapes();
        let keys = f.registry.handle(f.surface).borrow().keys.clone();
        let rects = dirty_rects(
            (&keys, &before),
            (&keys, &after),
            &Look::default(),
            400,
            200,
            1.0,
        )
        .unwrap();
        assert_eq!(rects.len(), 1);
        let [x, y, w, h] = rects[0];
        // Old and new tab boxes (x 20..150, y 150..180) plus padding, nothing
        // of the plate's interior above.
        assert!(
            x <= 20 && x + w >= 150 && y >= 140 && y + h <= 200,
            "{:?}",
            rects[0]
        );
        // Moving the plate (no animate flag) snaps.
        f.style(
            "plate",
            "position:absolute;left:30px;top:10px;width:50%;height:120px",
        );
        assert_eq!(f.frame(), (3, false));
    }

    #[test]
    fn adding_and_removing_members_updates_the_surface() {
        let mut f = Fixture::new();
        f.frame();
        let tab = f.id("tab");
        f.registry.member(tab, false);
        assert_eq!(f.frame().0, 2);
        assert_eq!(f.shapes().len(), 1);
        f.registry.member(tab, true);
        assert_eq!(f.frame().0, 3);
        assert_eq!(f.shapes().len(), 2);
    }

    /// The shape of `name` as the widget shows it, found by identity.
    fn shown(widget: &Surface, f: &Fixture, name: &str) -> super::Shape {
        let key = super::Key::Member(f.id(name));
        let i = widget.keys().iter().position(|k| *k == key).unwrap();
        widget.shown()[i].clone()
    }

    fn target(widget: &Surface, f: &Fixture, name: &str) -> super::Shape {
        let key = super::Key::Member(f.id(name));
        let i = widget.keys().iter().position(|k| *k == key).unwrap();
        widget.target()[i].clone()
    }

    /// A view switch: the rail tab moves while two members (the chat view's
    /// title notch and composer) leave and another arrives, all in one pass.
    /// The tab animates between its own two boxes; nothing else moves.
    #[test]
    fn a_tab_moving_while_members_come_and_go_animates_between_its_own_boxes() {
        let mut f = Fixture::with(&["plate", "tab", "notch", "composer"]);
        f.frame();
        let mut widget = f.widget();
        assert_eq!(widget.shown().len(), 4);
        let plate = shown(&widget, &f, "plate");
        f.style(
            "tab",
            "position:absolute;left:20px;top:60px;width:30px;height:30px",
        );
        f.member("notch", false);
        f.member("composer", false);
        f.member("fresh", true);
        let (_, animate) = f.frame();
        assert!(animate, "the tab still animates although the count changed");
        widget.sync_for_test();
        assert!(widget.requires_redraw());
        assert_eq!(widget.shown().len(), 3, "plate, tab, fresh");
        widget.step_for_test(Default::default());
        let tab = shown(&widget, &f, "tab");
        assert!(
            tab.rect[0] == 20.0 && (tab.rect[1] - 150.0).abs() < 0.5,
            "starts at its own old box: {:?}",
            tab.rect
        );
        assert_eq!(
            shown(&widget, &f, "plate"),
            plate,
            "the plate does not move"
        );
        assert_eq!(
            shown(&widget, &f, "fresh"),
            target(&widget, &f, "fresh"),
            "an arriving member appears at once, it does not morph from another shape"
        );
        widget.step_for_test(ANIMATION / 2);
        let mid = shown(&widget, &f, "tab").rect;
        assert!(mid[1] < 150.0 && mid[1] > 60.0, "half way: {mid:?}");
        assert_eq!(mid[0], 20.0, "it moves along its own path only");
        assert!(widget.step_for_test(ANIMATION), "finishes");
        assert_eq!(shown(&widget, &f, "tab").rect, [20.0, 60.0, 30.0, 30.0]);
        assert!(!widget.requires_redraw());
    }

    /// Removing a member while another is in flight does not restart, snap
    /// or redirect the one in flight.
    #[test]
    fn removing_a_member_mid_animation_leaves_the_animating_one_alone() {
        let mut f = Fixture::with(&["plate", "tab", "notch"]);
        f.frame();
        let mut widget = f.widget();
        f.style(
            "tab",
            "position:absolute;left:220px;top:150px;width:30px;height:30px",
        );
        f.frame();
        widget.sync_for_test();
        widget.step_for_test(ANIMATION / 3);
        let before = shown(&widget, &f, "tab").rect[0];
        assert!(before > 20.0 && before < 220.0, "in flight: {before}");
        f.member("notch", false);
        let (_, animate) = f.frame();
        assert!(!animate, "nothing new to animate");
        widget.sync_for_test();
        assert_eq!(widget.shown().len(), 2);
        assert!(widget.requires_redraw(), "the tab is still in flight");
        widget.step_for_test(Default::default());
        let after = shown(&widget, &f, "tab").rect[0];
        assert!(
            (after - before).abs() < 8.0 && after < 220.0,
            "continues from {before}, not restarted or snapped: {after}"
        );
        assert!(widget.step_for_test(ANIMATION));
        assert_eq!(shown(&widget, &f, "tab").rect[0], 220.0);
    }

    /// A rail tab attached to the left edge of its container (x = 46,
    /// top 0, corner 12) with 10 px fillets, the tab 39 x 32 with 10 px
    /// free corners, its top `d` px below the container's top.
    fn tab(d: f32) -> [super::Shape; 2] {
        let mut container = super::Shape::rect(false, [46.0, 0.0, 300.0, 400.0], [12.0; 4]);
        container.join = 10.0;
        let tab = attached(
            Side::Right,
            [7.0, d, 39.0, 32.0],
            [10.0, 0.0, 0.0, 10.0],
            10.0,
            container.rect,
            container.radii,
        )
        .unwrap();
        [container, tab]
    }

    #[test]
    fn a_tab_level_with_the_top_runs_straight_into_the_container() {
        let look = Look {
            join: 10.0,
            ..Look::default()
        };
        let shapes = tab(0.0);
        // From the end of the tab's own corner arc (x = 17) across where the
        // container's rounded corner was, into its straight top edge: on the
        // outline, no bulge above, no dip below.
        for i in 0..=100 {
            let x = 17.0 + i as f32 * 0.6;
            let on = field_all(&shapes, &look, [x, 0.0]);
            let above = field_all(&shapes, &look, [x, -0.5]);
            let below = field_all(&shapes, &look, [x, 0.5]);
            assert!(on.abs() < 1e-3, "x {x}: {on} on the top edge");
            assert!((above - 0.5).abs() < 1e-3, "x {x}: {above} above (bulge)");
            assert!((below + 0.5).abs() < 1e-3, "x {x}: {below} below (dip)");
        }
        // The lower fillet, where the tab's bottom meets the container's
        // left edge: an exact arc of radius 10 centred 10 px outside both.
        let (r, centre) = (10.0, [36.0, 42.0]);
        assert!((field_all(&shapes, &look, centre) - r).abs() < 1e-3);
        for step in 0..=9 {
            let a = (180.0 + step as f32 * 10.0).to_radians() + std::f32::consts::FRAC_PI_2;
            let p = [centre[0] + r * a.cos(), centre[1] + r * a.sin()];
            assert!(field_all(&shapes, &look, p).abs() < 1e-3, "{p:?}");
        }
        // Away from the top (item 1, 34 px down) the upper fillet is the
        // same exact arc and the container keeps its own rounded corner.
        let shapes = tab(34.0);
        assert!((field_all(&shapes, &look, [36.0, 24.0]) - r).abs() < 1e-3);
        let corner = [46.0 + 12.0, 12.0];
        assert!((field_all(&shapes, &look, corner) + 12.0).abs() < 1e-3);
        let on_corner = [58.0 - 12.0 * 0.70710677, 12.0 - 12.0 * 0.70710677];
        assert!(field_all(&shapes, &look, on_corner).abs() < 1e-3);
    }

    #[test]
    fn an_attached_tab_changes_continuously_as_it_leaves_the_top() {
        let look = Look {
            join: 10.0,
            ..Look::default()
        };
        let probes: Vec<[f32; 2]> = (0..12)
            .flat_map(|i| (0..8).map(move |j| [30.0 + i as f32 * 3.0, -4.0 + j as f32 * 5.0]))
            .collect();
        let sample = |d: f32| -> Vec<f32> {
            let shapes = tab(d);
            probes
                .iter()
                .map(|p| field_all(&shapes, &look, *p))
                .collect()
        };
        // Exact outlines at closely spaced positions: no pops.
        let mut prev = sample(0.0);
        for k in 1..=160 {
            let d = k as f32 * 0.25;
            let now = sample(d);
            let jump = prev
                .iter()
                .zip(&now)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f32::max);
            assert!(jump < 0.6, "d {d}: field jumped by {jump}");
            prev = now;
        }
        // The animation interpolates the two outlines vertex by vertex.
        let (a, b) = (&tab(0.0)[1], &tab(34.0)[1]);
        let mut prev = sample(0.0);
        for k in 1..=40 {
            let t = k as f32 / 40.0;
            let mid = super::Shape::lerp(a, b, t);
            assert!(mid.poly.is_some(), "stays an outline");
            let shapes = [tab(0.0)[0].clone(), mid];
            let now: Vec<f32> = probes
                .iter()
                .map(|p| field_all(&shapes, &look, *p))
                .collect();
            let jump = prev
                .iter()
                .zip(&now)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f32::max);
            assert!(jump < 1.5, "t {t}: field jumped by {jump}");
            prev = now;
        }
    }

    #[test]
    fn slanted_members_have_exact_flared_joins() {
        // A notch hanging from a top edge at y = 0, right side leaning 45
        // degrees: subtracted from a plate, the join where the side meets the
        // edge is an arc of radius `join` (centre r inside the plate from both
        // the edge and the side), as for a hand-written `poly`.
        let look = Look::default();
        let plate = super::Shape::rect(false, [0.0, 0.0, 300.0, 200.0], [0.0; 4]);
        let join = 14.0;
        let notch = slanted(true, [100.0, 0.0, 80.0, 40.0], [10.0; 4], join, [0.0, 45.0]).unwrap();
        let shapes = [plate, notch];
        // Side line through (180, 40) and (220, 0); unit normal into the plate.
        let n = [
            std::f32::consts::FRAC_1_SQRT_2,
            std::f32::consts::FRAC_1_SQRT_2,
        ];
        // Centre: y = join and signed distance `join` from the side line.
        let x = 180.0 + (join - (join - 40.0) * n[1]) / n[0];
        let centre = [x, join];
        assert!((field_all(&shapes, &look, centre) + join).abs() < 1e-2);
        for step in 0..=36 {
            let a = (step as f32 * 10.0).to_radians();
            let p = [centre[0] + join * a.cos(), centre[1] + join * a.sin()];
            // Points on the circle are inside or on the outline, never outside:
            // the fillet is the circle itself where it is the boundary.
            assert!(field_all(&shapes, &look, p) <= 1e-2, "{p:?}");
        }
    }
}

/// The run-time fallback for classes the build cannot see: a `material-*`
/// or `bg-*` utility in `class`, bare or behind variants, makes a plate
/// candidate; colours that are not the element's own do not.
#[test]
fn plate_classes_are_found_behind_variants() {
    use super::bind::has_plate_class;
    for class in [
        "material-key",
        "flex material-tray rounded-[10px]",
        "active:material-key-pressed px-2",
        "aria-pressed:hover:material-key-pressed",
        "!material-key",
        "bg-blue-600",
        "p-2 hover:bg-chip",
        "bg-[#3a2420]",
        "bg-white/50",
        "bg-red-500!",
    ] {
        assert!(has_plate_class(class), "{class}");
    }
    for class in [
        "",
        "flex gap-2",
        "materials",
        "text-material-x",
        "bevel-1",
        "bg-transparent",
        "hover:bg-current",
        "bg-current/50",
        "bg-inherit",
        "text-bg-x",
    ] {
        assert!(!has_plate_class(class), "{class}");
    }
}

/// The build's `tk-plate` marker makes a plate on its own: a marked
/// element's class is not scanned, and the class scan stays the fallback
/// for unmarked ones. The scan reports when it changes an element's state,
/// so the host can mirror it as the marker attribute.
#[test]
fn the_build_marker_registers_a_plate_without_the_class_scan() {
    let mut registry = super::bind::Registry::default();
    let node = blitz_traits::NodeId::from_u64(7);
    registry.plate_marker(node, true);
    assert_eq!(registry.plate_class(node, Some("flex bg-chip")), None);
    assert!(registry.is_plate(node), "marked, whatever the class says");
    registry.plate_marker(node, false);
    assert!(!registry.is_plate(node));
    assert_eq!(
        registry.plate_class(node, Some("flex material-key")),
        Some(true)
    );
    assert!(registry.is_plate(node), "the run-time fallback");
    assert_eq!(
        registry.plate_class(node, Some("bg-chip")),
        None,
        "unchanged"
    );
    assert_eq!(registry.plate_class(node, None), Some(false));
    assert!(!registry.is_plate(node));
}

/// Plate fills come from a computed `<color>`, serialized in whatever
/// space Stylo kept: every form ends as straight-alpha sRGB, and what is
/// not one colour is no fill.
#[test]
fn plate_fills_parse_every_computed_colour_form() {
    use super::bind::css_colour;
    let close = |text: &str, want: [f32; 4]| {
        let got = css_colour(text).unwrap_or_else(|| panic!("{text}"));
        assert!(
            got.iter().zip(want).all(|(a, b)| (a - b).abs() < 0.004),
            "{text}: {got:?}"
        );
    };
    close(
        "#3a2420",
        [
            0x3a as f32 / 255.0,
            0x24 as f32 / 255.0,
            0x20 as f32 / 255.0,
            1.0,
        ],
    );
    close(
        "rgb(37, 99, 235)",
        [37.0 / 255.0, 99.0 / 255.0, 235.0 / 255.0, 1.0],
    );
    close("rgba(255, 255, 255, 0.5)", [1.0, 1.0, 1.0, 0.5]);
    // Tailwind's blue-600 and white/50 as Stylo computes them.
    close("oklch(0.546 0.245 262.881)", [0.082, 0.364, 0.988, 1.0]);
    close("oklab(1 0 0 / 0.5)", [1.0, 1.0, 1.0, 0.5]);
    close("rgba(0, 0, 0, 0)", [0.0; 4]);
    assert_eq!(css_colour("currentcolor"), None);
    assert_eq!(
        css_colour("color-mix(in oklab, currentcolor 50%, transparent)"),
        None
    );
}

/// A materials layer renders only the grid-snapped part of its box that its
/// plates reach, clipped to the box, and nothing without plates.
#[test]
fn a_materials_layer_crops_to_its_plates() {
    use super::widget::crop;
    let look = Look {
        layered: true,
        ..Look::default()
    };
    let cap = Shape::rect(false, [100.0, 40.0, 60.0, 30.0], [7.0; 4]);
    // Scale 2: influence 100 - 4 = 96 .. 164 CSS px wide -> 192..328 device
    // px, snapped out to 64: 192..384.
    assert_eq!(
        crop(&[cap.clone()], &look, 2000, 1000, 2.0),
        Some([192, 64, 192, 128])
    );
    // Clipped at the box edge (a plate scrolled half out of view).
    let edge = Shape::rect(false, [-20.0, 980.0, 60.0, 30.0], [0.0; 4]);
    assert_eq!(
        crop(&[edge], &look, 2000, 1000, 1.0),
        Some([0, 960, 64, 40])
    );
    assert_eq!(crop(&[], &look, 2000, 1000, 2.0), None);
    // Moving a plate by a few px inside one grid cell keeps the crop.
    let nudged = Shape::rect(false, [102.0, 41.0, 60.0, 30.0], [7.0; 4]);
    assert_eq!(
        crop(&[cap], &look, 2000, 1000, 2.0),
        crop(&[nudged], &look, 2000, 1000, 2.0)
    );
}

/// Who draws a plate (bind.rs): by default the plate's own widget, attached
/// to the element by the layout pass; the region's layer for a
/// `tk-region="sheet"`, and for elements a widget cannot go on.
mod painters {
    use super::super::bind::{Handle, Registry};
    use blitz_dom::Document;
    use blitz_html::HtmlDocument;
    use blitz_traits::{NodeId, shell::Viewport};

    const HTML: &str = r#"<html><body style="margin:0">
      <div id="region" tk-region style="position:relative;width:300px;height:260px">
        <tk-surface id="layer" materials
          style="display:block;position:absolute;left:0;top:0;width:100%;height:100%"></tk-surface>
        <div id="box" style="--tk-fill:#ff0000;--tk-bevel:2;box-sizing:border-box;width:100px;height:40px;padding:5px;border-radius:6px;opacity:0.5">
          <input id="field" style="--tk-fill:#0000aa;--tk-bevel:1;display:block;box-sizing:border-box;width:60px;height:20px;margin:0;border:0;padding:0;opacity:0.5">
        </div>
        <button id="button" style="--tk-fill:#00ff00;display:block;width:80px;height:30px"></button>
        <input id="input" style="--tk-fill:#0000ff;display:block;width:80px;height:30px">
        <p style="margin:0">text <span id="inline" style="--tk-fill:#ffff00">inline</span></p>
        <div id="hidden" style="--tk-fill:#ffffff;display:none;width:10px;height:10px"></div>
        <div id="far" style="--tk-fill:#111111;--tk-bevel:1;position:absolute;left:0;top:2000px;width:40px;height:20px"></div>
        <div style="position:absolute;left:0;top:0;transform:translateY(-1900px)">
          <div id="moved" style="--tk-fill:#222222;--tk-bevel:1;position:absolute;left:0;top:2000px;width:40px;height:20px"></div>
        </div>
        <div id="sheet" tk-region="sheet" style="position:relative;width:200px;height:50px">
          <tk-surface id="sheet-layer" materials
            style="display:block;position:absolute;left:0;top:0;width:100%;height:100%"></tk-surface>
          <div id="inner" style="--tk-fill:#ff00ff;width:50px;height:20px;opacity:0.5"></div>
        </div>
      </div>
      <div id="outside" style="--tk-fill:#00ffff;width:50px;height:20px"></div>
    </body></html>"#;

    const PLATES: [&str; 10] = [
        "box", "field", "button", "input", "inline", "hidden", "far", "moved", "inner", "outside",
    ];

    struct Fixture {
        doc: HtmlDocument,
        registry: Registry,
    }

    impl Fixture {
        fn new() -> Self {
            let mut doc = HtmlDocument::from_html(HTML, Default::default());
            doc.inner_mut().set_viewport(Viewport {
                window_size: (400, 400),
                ..Default::default()
            });
            let mut registry = Registry::default();
            let id = |name: &str| doc.inner().get_element_by_id(name).unwrap();
            for layer in ["layer", "sheet-layer"] {
                let _widget = registry.surface(id(layer));
            }
            // What wire.rs reports as attributes arrive.
            for plate in PLATES {
                registry.plate_marker(id(plate), true);
            }
            registry.region(id("region"), Some("true"));
            registry.region(id("sheet"), Some("sheet"));
            let mut fixture = Fixture { doc, registry };
            fixture.frame();
            fixture
        }

        fn id(&self, name: &str) -> NodeId {
            self.doc.inner().get_element_by_id(name).unwrap()
        }

        /// One frame's pass: layout, then binding.
        fn frame(&mut self) {
            self.doc.inner_mut().resolve(0.0);
            self.registry.bind(&mut self.doc.inner_mut());
        }

        fn carries_widget(&self, name: &str) -> bool {
            let inner = self.doc.inner();
            let element = inner.get_node(self.id(name)).unwrap().element_data();
            element.is_some_and(|e| e.custom_widget_data().is_some())
        }

        fn own(&self, name: &str) -> Option<Handle> {
            self.registry.own_handle(self.id(name))
        }

        /// Fills (rgba, 0..255) of the shapes a layer draws, in paint order.
        fn drawn_by(&self, layer: &str) -> Vec<[u8; 4]> {
            let handle = self.registry.handle(self.id(layer));
            let bound = handle.borrow();
            bound
                .shapes
                .iter()
                .map(|s| s.paint.unwrap().fill.map(|v| (v * 255.0).round() as u8))
                .collect()
        }
    }

    const RED_HALF: [u8; 4] = [255, 0, 0, 128];
    const GREEN: [u8; 4] = [0, 255, 0, 255];
    const BLUE: [u8; 4] = [0, 0, 255, 255];
    const YELLOW: [u8; 4] = [255, 255, 0, 255];
    const MAGENTA_HALF: [u8; 4] = [255, 0, 255, 128];
    const FIELD_HALF: [u8; 4] = [0, 0, 170, 128];

    #[test]
    fn plates_paint_themselves_unless_the_region_is_a_sheet() {
        let mut f = Fixture::new();
        // Ordinary elements in a plain region carry their own plate.
        for name in ["box", "button"] {
            assert!(f.carries_widget(name), "{name}");
        }
        let handle = f.own("box").unwrap();
        {
            let bound = handle.borrow();
            let shape = &bound.shapes[0];
            assert_eq!(shape.rect, [0.0, 0.0, 100.0, 40.0], "its own border box");
            assert_eq!(shape.radii, [6.0; 4]);
            let paint = shape.paint.unwrap();
            assert_eq!(paint.bevel, 2.0);
            // Its own opacity is Blitz's to apply (the plate is drawn inside
            // the element's opacity layer), so the fill keeps its alpha.
            assert_eq!(paint.fill, [1.0, 0.0, 0.0, 1.0]);
        }
        // An element a widget cannot go on is drawn for it: the input
        // keeps its text editor, and an inline element without a box of its
        // own would never have its widget painted. Directly in the region,
        // the region's layer draws them.
        for name in ["input", "inline", "field"] {
            assert!(!f.carries_widget(name), "{name}");
        }
        // Inside a self-painting plate, that plate draws it as a guest,
        // over its own fill (the region's layer is under the plate): placed
        // in the plate's border box, with the guest's own opacity in its
        // fill (only the plate's opacity layers are around it).
        {
            let bound = handle.borrow();
            assert_eq!(bound.shapes.len(), 2, "the box and the field in it");
            let field = &bound.shapes[1];
            assert_eq!(field.rect, [5.0, 5.0, 60.0, 20.0]);
            let paint = field.paint.unwrap();
            assert_eq!(paint.fill.map(|v| (v * 255.0).round() as u8), FIELD_HALF);
            assert_eq!(paint.bevel, 1.0);
        }
        let input = f.id("input");
        assert!(
            f.doc
                .inner()
                .get_node(input)
                .unwrap()
                .element_data()
                .unwrap()
                .text_input_data()
                .is_some(),
            "the input is still a text input"
        );
        assert_eq!(f.drawn_by("layer"), [BLUE, YELLOW]);
        // A `tk-region="sheet"` inside it decides for its own plates; with
        // the sheet, the element's own opacity scales the fill.
        assert!(!f.carries_widget("inner"));
        assert_eq!(f.drawn_by("sheet-layer"), [MAGENTA_HALF]);
        // Not rendered, or outside every region: nobody draws it.
        for name in ["hidden", "outside"] {
            assert!(!f.carries_widget(name), "{name}");
            assert!(f.own(name).is_none(), "{name}");
        }

        // Laid out below the window (400 px tall): it carries its widget
        // but is handed no shape, so it holds no texture. Under a transform
        // the layout box does not say where it shows: kept.
        assert!(f.carries_widget("far") && f.carries_widget("moved"));
        assert!(f.own("far").unwrap().borrow().shapes.is_empty());
        assert_eq!(f.own("moved").unwrap().borrow().shapes.len(), 1);

        // Unchanged frames change nothing.
        let version = handle.borrow().version;
        f.frame();
        f.frame();
        assert_eq!(handle.borrow().version, version);
        assert!(std::rc::Rc::ptr_eq(&handle, &f.own("box").unwrap()));

        // The region becomes a sheet: its layer draws every plate, outer
        // first, then in document order, and the widgets are taken off.
        let region = f.id("region");
        f.registry.region(region, Some("sheet"));
        f.frame();
        for name in ["box", "button", "far", "moved"] {
            assert!(!f.carries_widget(name), "{name}");
            assert!(f.own(name).is_none(), "{name}");
        }
        // (The two plates laid out below the layer's box are skipped.)
        assert_eq!(
            f.drawn_by("layer"),
            [RED_HALF, GREEN, BLUE, FIELD_HALF, YELLOW]
        );
        // And back.
        f.registry.region(region, Some("true"));
        f.frame();
        assert!(f.carries_widget("box") && f.carries_widget("button"));
        assert_eq!(f.drawn_by("layer"), [BLUE, YELLOW]);
        assert_eq!(f.own("box").unwrap().borrow().shapes.len(), 2);
    }

    /// Blitz drops a widget when its element leaves the document. The pass
    /// stops tracking it and attaches a new one when the element returns.
    #[test]
    fn a_plate_that_leaves_and_returns_gets_its_widget_again() {
        let mut f = Fixture::new();
        let (node, parent) = (f.id("box"), f.id("region"));
        let before = f.own("box").unwrap();
        f.doc.inner_mut().mutate().remove_node(node);
        f.frame();
        assert!(f.registry.own_handle(node).is_none(), "not tracked");
        f.doc.inner_mut().mutate().append_children(parent, &[node]);
        f.frame();
        let after = f.registry.own_handle(node).expect("attached again");
        assert!(!std::rc::Rc::ptr_eq(&before, &after), "a new widget");
        assert_eq!(after.borrow().shapes.len(), 2, "itself and its field");
        let inner = f.doc.inner();
        let element = inner.get_node(node).unwrap().element_data().unwrap();
        assert!(element.custom_widget_data().is_some());
    }
}
