//! Behaviour of the surface maths and widget, checked on the CPU reference.
//! The GPU path is exercised by the lab's offscreen tests (lab/tests).
use super::reference::{field, raster, shade};
use super::shape::{Align, Look, Poly, Shape, V2, dot2, len2, parse_colour, parse_shapes};
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
    look.border_lit = true;
    let buf = raster(&plate, &look, 40, 40, 1.0);
    let (top, bottom) = (px(&buf, 40, 20, 5), px(&buf, 40, 20, 34));
    assert!(top[0] > 128 && bottom[0] < 128, "{top:?} {bottom:?}");
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
        border_lit: true,
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
    let rects = dirty_rects(&shapes, &moved, &look, w, h, scale).unwrap();
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
        dirty_rects(&shapes, &shapes, &look, w, h, scale),
        Some(vec![])
    );
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

#[cfg(feature = "surface-demo")]
#[test]
fn a_demo_with_nothing_moving_requests_no_frames() {
    let mut surface = Surface::new();
    surface.attribute_changed("demo", None, Some("bounce"));
    surface.attribute_changed("count", None, Some("1000"));
    surface.attribute_changed("running", None, Some("true"));
    assert!(surface.requires_redraw());
    surface.attribute_changed("moving", None, Some("0"));
    assert!(!surface.requires_redraw());
}
