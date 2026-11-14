use super::*;
use anyrender::recording::RenderCommand;
use blitz_dom::{Document, Namespace, QualName};
use blitz_html::HtmlDocument;
use blitz_traits::shell::Viewport;
use geo::{Area, BooleanOps, Buffer, Contains, Point};
use outline::{attached, path, polygon, region, slanted};
use peniko::kurbo::Shape as _;

struct Fixture {
    doc: HtmlDocument,
    surfaces: Surfaces,
    layer: NodeId,
}
impl Fixture {
    fn new(content: &str, members: &[&str]) -> Self {
        let html = format!(
            r#"<html><head><style>
          @property --tk-fill {{ syntax: '<color>'; inherits: false; initial-value: transparent; }}
          body {{ margin:0 }}
          [tk-group] {{ position:absolute;left:20px;top:30px;width:100px;height:100px;--tk-fill:#808080 }}
          tk-surface {{ position:absolute;inset:0;width:100%;height:100% }}
          [surface-groups] {{ position:absolute;width:20px;height:20px }}
          </style></head><body>{content}</body></html>"#
        );
        let mut doc = HtmlDocument::from_html(&html, Default::default());
        doc.inner_mut()
            .add_user_agent_stylesheet(blitz_dom::UserAgentStylesheet::parse(UA_CSS));
        doc.inner_mut().set_viewport(Viewport {
            window_size: (400, 300),
            ..Default::default()
        });
        let mut surfaces = Surfaces::default();
        let layer = doc.get_element_by_id("surface").unwrap();
        for name in ["surface", "second"] {
            if let Some(id) = doc.get_element_by_id(name) {
                doc.inner_mut()
                    .mutate()
                    .set_custom_widget(id, surfaces.widget(id));
            }
        }
        for name in members {
            surfaces.member(doc.get_element_by_id(name).unwrap(), true);
        }
        let mut f = Self {
            doc,
            surfaces,
            layer,
        };
        f.frame();
        f
    }
    fn id(&self, name: &str) -> NodeId {
        self.doc.get_element_by_id(name).unwrap()
    }
    fn attr(&mut self, name: &str, attr: &str, value: &str) {
        let id = self.id(name);
        self.doc.inner_mut().mutate().set_attribute(
            id,
            QualName::new(None, Namespace::from(""), LocalName::from(attr)),
            value,
        );
    }
    fn frame(&mut self) {
        self.doc.inner_mut().resolve(0.0);
        self.surfaces.after_layout(&self.doc.inner());
    }
    fn state(&self) -> std::cell::Ref<'_, Surface> {
        self.surfaces.layers[&self.layer].borrow()
    }
    fn region(&self) -> geo::MultiPolygon<f64> {
        region(&self.state().shown)
    }
    fn moving(&self) -> bool {
        Layer(self.surfaces.layers[&self.layer].clone()).requires_redraw()
    }
    fn advance(&self, elapsed: Duration) {
        let mut state = self.surfaces.layers[&self.layer].borrow_mut();
        for tween in state.tweens.values_mut() {
            tween.start = Instant::now() - elapsed;
        }
        state.step();
    }
}
fn inside(region: &geo::MultiPolygon<f64>, x: f64, y: f64) -> bool {
    region.contains(&Point::new(x, y))
}

#[test]
fn root_add_cut_and_registered_root_style() {
    let f = Fixture::new(
        r#"<div id="root" tk-group="g" style="border-radius:0;--tk-bevel:2;--tk-bevel-strength:.4;--tk-bevel-base:.055;--tk-bevel-inset:1">
      <tk-surface id="surface" group="g" fill='#ff0000' bevel="99"></tk-surface>
      <div id="add" surface-groups="g" surface-op="add" style="left:100px;top:0"></div>
      <div id="cut" surface-groups="g" surface-op="cut" style="left:40px;top:40px"></div>
      </div>"#,
        &["cut", "add"],
    );
    let r = f.region();
    assert!((r.unsigned_area() - 10000.0).abs() < 0.1);
    assert!(inside(&r, 10.0, 10.0) && inside(&r, 110.0, 10.0));
    assert!(!inside(&r, 50.0, 50.0) && !inside(&r, 130.0, 10.0));
    let state = f.state();
    assert_eq!(
        state.look.fill,
        [128.0 / 255.0, 128.0 / 255.0, 128.0 / 255.0, 1.0]
    );
    assert_eq!(
        (state.look.bevel, state.look.strength, state.look.inset),
        (2.0, 0.4, true)
    );
    assert_eq!(state.look.base, 0.055);
    assert!(!f.moving());
}

#[test]
fn external_members_attach_to_the_root_and_inherit_its_join() {
    let f = Fixture::new(
        r#"<div tk-group="g" surface-join="8" style="border-radius:10px 20px 30px 40px">
      <tk-surface id="surface" group="g"></tk-surface></div>
      <div id="tab" surface-groups="g" surface-attach="right" style="left:0;top:60px;border-radius:4px"></div>
      <div id="plain" surface-groups="g" style="left:150px;top:30px"></div>
      <div id="override" surface-groups="g" surface-join="2" style="left:180px;top:30px"></div>"#,
        &["tab", "plain", "override"],
    );
    let state = f.state();
    assert_eq!(state.target[0].radii, [10.0, 20.0, 30.0, 40.0]);
    assert_eq!(state.target[1].join, 8.0);
    assert_eq!(state.target[2].join, 2.0);
    assert!(state.target[3].poly.is_some());
    assert_eq!(state.target[3].join, 0.0);
    assert_eq!(state.look.bevel, 0.0);
    assert_eq!(state.look.strength, 1.0);
}

#[test]
fn own_false_and_one_member_in_two_groups() {
    let f = Fixture::new(
        r#"<div tk-group="g" surface-own="false"><tk-surface id="surface" group="g"></tk-surface>
      <div id="member" surface-groups="g h g" style="left:10px;top:10px;border-radius:3px 4px 5px 6px"></div></div>
      <div tk-group="h" surface-own="false" style="left:20px;top:30px"><tk-surface id="second" group="h"></tk-surface></div>"#,
        &["member"],
    );
    let a = f.state();
    let b = f.surfaces.layers[&f.id("second")].borrow();
    assert_eq!(a.target.len(), 1);
    assert_eq!(a.target, b.target);
    assert_eq!(a.target[0].radii, [3.0, 4.0, 5.0, 6.0]);
    assert!(!inside(&f.region(), 50.0, 50.0));
    assert!(inside(&f.region(), 15.0, 15.0));
}

#[test]
fn unregistered_and_removed_members_do_not_join() {
    let mut f = Fixture::new(
        r#"<div tk-group="g" surface-own="false"><tk-surface id="surface" group="g"></tk-surface>
      <div id="a" surface-groups="g"></div><div id="b" surface-groups="g"></div></div>"#,
        &["a"],
    );
    assert_eq!(f.state().target.len(), 1);
    f.surfaces.member(f.id("a"), false);
    f.frame();
    assert!(f.state().target.is_empty());
}

#[test]
fn ordering_is_plain_adds_attached_adds_cuts_in_document_order() {
    let mut f = Fixture::new(
        r#"<div tk-group="g" surface-own="false"><tk-surface id="surface" group="g"></tk-surface>
      <div id="cut" surface-groups="g" surface-op="cut"></div>
      <div id="tab" surface-groups="g" surface-attach="left"></div>
      <div id="a" surface-groups="g"></div><div id="b" surface-groups="g"></div></div>"#,
        &["cut", "tab", "a", "b"],
    );
    let expected = |f: &Fixture| [f.id("b"), f.id("a"), f.id("tab"), f.id("cut")];
    let (a, b) = (f.id("a"), f.id("b"));
    f.doc.inner_mut().mutate().insert_nodes_before(a, &[b]);
    f.frame();
    assert_eq!(f.state().keys, expected(&f).map(Key::Member));
}

#[test]
fn transparent_or_unset_fill_records_no_scene_commands() {
    let mut f = Fixture::new(
        r#"<div id="root" tk-group="g" style="--tk-fill:transparent;--tk-bevel:3"><tk-surface id="surface" group="g"></tk-surface></div>"#,
        &[],
    );
    assert!(
        draw(&f.state().shown, f.state().look, 1.0)
            .commands
            .is_empty()
    );
    f.attr("root", "style", "--tk-fill:initial");
    f.frame();
    assert!(
        draw(&f.state().shown, f.state().look, 2.0)
            .commands
            .is_empty()
    );
}

const MOVING: &str = r#"<div id="root" tk-group="g" surface-own="false"><tk-surface id="surface" group="g"></tk-surface>
    <div id="a" surface-groups="g" surface-animate style="left:0;top:0"></div>
    <div id="b" surface-groups="g" style="left:0;top:50px"></div></div>"#;

#[test]
fn tween_lasts_220_ms_and_static_layout_does_not_restart_it() {
    let mut f = Fixture::new(MOVING, &["a", "b"]);
    assert!(!f.moving());
    f.attr("a", "style", "left:80px;top:0");
    f.frame();
    assert!(f.moving());
    assert_eq!(ANIMATION, Duration::from_millis(220));
    f.advance(Duration::from_millis(100));
    let before = f.state().shown[0].rect[0];
    assert!(before > 0.0 && before < 80.0);
    f.surfaces.member(f.id("b"), false);
    f.frame();
    assert!(f.moving());
    assert!(f.state().shown[0].rect[0] >= before);
    f.advance(Duration::from_millis(210));
    assert!(f.moving());
    f.advance(Duration::from_millis(221));
    assert!(!f.moving());
    assert_eq!(f.state().shown[0].rect[0], 80.0);
    f.frame();
    assert!(!f.moving());
}

#[test]
fn appearing_members_and_resizing_layers_snap() {
    let mut f = Fixture::new(MOVING, &["b"]);
    f.surfaces.member(f.id("a"), true);
    f.frame();
    assert!(!f.moving());
    f.attr("a", "style", "left:80px;top:0");
    f.attr("root", "style", "width:200px");
    f.frame();
    assert!(!f.moving());
    assert_eq!(f.state().shown[0].rect[0], 80.0);
    f.attr("a", "style", "left:40px;top:0");
    f.frame();
    assert!(f.moving());
    f.attr("a", "style", "left:20px;top:0");
    f.frame();
    assert!(f.moving());
    f.advance(ANIMATION);
    assert_eq!(f.state().shown[0].rect[0], 20.0);
}

#[test]
fn a_member_without_animation_follows_immediately() {
    let mut f = Fixture::new(MOVING, &["a", "b"]);
    f.attr("b", "style", "left:60px;top:50px");
    f.frame();
    assert!(!f.moving());
    assert_eq!(f.state().shown[1].rect[0], 60.0);
}

#[test]
fn rounded_polygon_arcs_are_tangent_in_both_windings() {
    for reverse in [false, true] {
        let mut vertices = vec![
            [0.0, 0.0, 6.0],
            [80.0, 0.0, 8.0],
            [80.0, 60.0, 10.0],
            [40.0, 30.0, 4.0],
            [0.0, 60.0, 3.0],
        ];
        if reverse {
            vertices.reverse();
        }
        let poly = Poly::new(vertices).unwrap();
        assert!(poly.corners.iter().any(|c| !c.convex));
        for c in &poly.corners {
            for t in [c.t1, c.t2] {
                assert!((outline::len2(outline::sub2(t, c.c)) - c.r).abs() < 0.001);
            }
        }
        let shape = Shape::from_poly(false, poly);
        assert!(polygon(&shape).unsigned_area() > 3000.0);
    }
    assert!(Poly::new(vec![[0.0, 0.0, 1.0]; 3]).is_none());
}

#[test]
fn attached_tabs_are_flush_at_the_corner_and_transpose_for_horizontal_edges() {
    let base = Shape::rect(false, [46.0, 0.0, 300.0, 400.0], [12.0; 4]);
    let tab = attached(
        Side::Right,
        [7.0, 0.0, 39.0, 32.0],
        [10.0; 4],
        10.0,
        base.rect,
        base.radii,
    )
    .unwrap();
    let r = region(&[base, tab]);
    for x in 17..80 {
        assert!(!inside(&r, x as f64, -0.1));
        assert!(inside(&r, x as f64, 0.1));
    }
    let base = Shape::rect(false, [0.0, 26.0, 240.0, 120.0], [0.0, 12.0, 12.0, 12.0]);
    let tab = attached(
        Side::Bottom,
        [0.0, 0.0, 60.0, 26.0],
        [6.0; 4],
        3.0,
        base.rect,
        base.radii,
    )
    .unwrap();
    let r = region(&[base, tab]);
    for y in 7..60 {
        assert!(!inside(&r, -0.1, y as f64));
        assert!(inside(&r, 0.1, y as f64));
    }
}

#[test]
fn slanted_cut_uses_exact_join_arcs_and_interpolates_vertices() {
    let a = slanted(true, [100.0, 0.0, 80.0, 40.0], [10.0; 4], 14.0, [0.0, 45.0]).unwrap();
    let b = slanted(true, [110.0, 0.0, 80.0, 40.0], [10.0; 4], 14.0, [0.0, 45.0]).unwrap();
    assert_eq!(a.join, 0.0);
    assert!(
        a.poly
            .as_ref()
            .unwrap()
            .corners
            .iter()
            .any(|c| (c.r - 14.0).abs() < 0.001)
    );
    let middle = Shape::lerp(&a, &b, 0.5);
    assert!((middle.rect[0] - (a.rect[0] + 5.0)).abs() < 0.001);
    let base = Shape::rect(false, [0.0, 0.0, 300.0, 200.0], [0.0; 4]);
    let r = region(&[base, a]);
    assert!(!inside(&r, 150.0, 10.0));
    assert!(inside(&r, 250.0, 10.0));
}

#[test]
fn general_join_rounds_the_intersection() {
    let a = Shape::rect(false, [0.0, 0.0, 10.0, 40.0], [0.0; 4]);
    let mut b = Shape::rect(false, [0.0, 0.0, 40.0, 10.0], [0.0; 4]);
    b.join = 6.0;
    let r = region(&[a, b]);
    assert!(inside(&r, 11.0, 11.0));
    assert!(!inside(&r, 16.0, 16.0));
}

#[test]
fn edge_strokes_are_clipped_inside_outer_and_hole_contours_at_both_scales() {
    let shapes = [
        Shape::rect(false, [0.0, 0.0, 100.0, 100.0], [8.0; 4]),
        Shape::rect(true, [30.0, 30.0, 40.0, 40.0], [4.0; 4]),
    ];
    let r = region(&shapes);
    let outline = path(&r);
    for scale in [1.0, 2.0] {
        let scene = draw(
            &shapes,
            Look {
                fill: [0.5, 0.5, 0.5, 0.4],
                bevel: 2.0,
                strength: 1.0,
                base: 0.0,
                inset: false,
            },
            scale,
        );
        let RenderCommand::PushLayer(clip) = &scene.commands[0] else {
            panic!("missing outline clip")
        };
        assert_eq!(clip.clip, outline);
        assert_eq!(clip.transform, Affine::scale(scale));
        let mut strokes = 0;
        let mut band = geo::MultiPolygon::new(vec![]);
        let mut lit_edges = 0;
        for command in &scene.commands {
            if let RenderCommand::Stroke(edge) = command {
                strokes += 1;
                assert_eq!(edge.style.width, 4.0);
                assert_eq!(edge.transform, Affine::scale(scale));
                let points: Vec<_> = edge
                    .shape
                    .elements()
                    .iter()
                    .filter_map(|el| match el {
                        peniko::kurbo::PathEl::MoveTo(p) | peniko::kurbo::PathEl::LineTo(p) => {
                            Some((p.x, p.y))
                        }
                        _ => None,
                    })
                    .collect();
                if (points[0].1 - points[1].1).abs() < 0.001 {
                    let y = points[0].1;
                    let anyrender::Paint::Solid(colour) = edge.brush else {
                        panic!("expected solid edge")
                    };
                    let expected = if (y - 0.0).abs() < 0.001 || (y - 70.0).abs() < 0.001 {
                        Some(0.59)
                    } else if (y - 100.0).abs() < 0.001 || (y - 30.0).abs() < 0.001 {
                        Some(0.275)
                    } else {
                        None
                    };
                    if let Some(expected) = expected {
                        assert!((colour.components[0] - expected).abs() < 0.001);
                        lit_edges += 1;
                    }
                }
                band = band.union(&geo::LineString::from(points).buffer(2.0));
            }
        }
        assert!(strokes > 8 && lit_edges == 4);
        let band = band.intersection(&r);
        assert!(band.difference(&r).unsigned_area() < 0.001);
        assert!(inside(&band, 1.0, 50.0) && inside(&band, 29.0, 50.0));
        assert!(!inside(&band, -1.0, 50.0) && !inside(&band, 31.0, 50.0));
        assert!(!inside(&band, 3.0, 50.0) && !inside(&band, 27.0, 50.0));
        assert!(!inside(&band, 50.0, 50.0));
        assert!(matches!(
            scene.commands.last(),
            Some(RenderCommand::PopLayer)
        ));
    }
    let top = edge_colour([0.5; 4], 1.0).components[0];
    let bottom = edge_colour([0.5; 4], -1.0).components[0];
    assert!((top - 0.59).abs() < 0.0001 && (bottom - 0.275).abs() < 0.0001);
    assert_eq!(edge_colour([0.5; 4], 0.0).components[0], 0.5);
    assert!(outline.area() > 0.0);
}

#[test]
fn a_cut_join_preserves_distant_square_corners() {
    let base = Shape::rect(false, [0.0, 0.0, 300.0, 200.0], [0.0; 4]);
    let mut cut = Shape::rect(true, [100.0, 160.0, 100.0, 60.0], [18.0; 4]);
    cut.join = 22.0;
    let r = region(&[base, cut]);
    for (x, y) in [(0.1, 0.1), (299.9, 0.1), (0.1, 199.9), (299.9, 199.9)] {
        assert!(inside(&r, x, y));
    }
    assert!(!inside(&r, 150.0, 190.0));
}

#[test]
fn uniform_bevel_lift_is_visible_on_every_side() {
    let scene = draw(
        &[Shape::rect(false, [0.0, 0.0, 100.0, 100.0], [0.0; 4])],
        Look {
            fill: [0.5, 0.5, 0.5, 1.0],
            bevel: 1.0,
            base: 0.055,
            ..Default::default()
        },
        1.0,
    );
    let mut sides = 0;
    for command in &scene.commands {
        if let RenderCommand::Stroke(edge) = command {
            let anyrender::Paint::Solid(colour) = edge.brush else {
                panic!("solid edge")
            };
            assert!((colour.components[0] - 0.5275).abs() < 0.0001);
            sides += 1;
        }
    }
    assert_eq!(sides, 4);
}

#[test]
fn joined_cuts_have_only_real_contours() {
    let root = Shape::rect(false, [0.0, 0.0, 420.0, 200.0], [20.0; 4]);
    let mut cut = Shape::rect(true, [280.0, 60.0, 80.0, 80.0], [40.0; 4]);
    cut.join = 6.0;
    for extra in [false, true] {
        let mut shapes = vec![root.clone()];
        if extra {
            shapes.push(Shape::rect(false, [420.0, 80.0, 40.0, 40.0], [0.0; 4]));
        }
        shapes.push(cut.clone());
        if extra {
            shapes.push(Shape {
                rect: [100.0, 60.0, 80.0, 80.0],
                ..cut.clone()
            });
        }
        let raw = shapes.iter().fold(geo::MultiPolygon::new(vec![]), |r, s| {
            if s.sub {
                r.difference(&polygon(s))
            } else {
                r.union(&polygon(s))
            }
        });
        let r = region(&shapes);
        assert_eq!(r.0.len(), 1);
        assert_eq!(r.0[0].interiors().len(), if extra { 2 } else { 1 });
        assert!(
            (r.unsigned_area() - raw.unsigned_area()).abs() < 2.0,
            "area {} vs {}",
            r.unsigned_area(),
            raw.unsigned_area()
        );
    }
}

#[test]
fn asymmetric_css_radii_and_pills() {
    let f = Fixture::new(
        r#"<div tk-group="g" style="border-radius:80px 0 0 0"><tk-surface id="surface" group="g"></tk-surface></div>"#,
        &[],
    );
    assert!(!inside(&f.region(), 20.0, 20.0));
    assert!(inside(&f.region(), 30.0, 30.0));
    let f = Fixture::new(
        r#"<div tk-group="g" surface-own="false"><tk-surface id="surface" group="g"></tk-surface><div id="member" surface-groups="g" style="width:100px;height:100px;border-radius:80px 0 0 0"></div></div>"#,
        &["member"],
    );
    assert!(!inside(&f.region(), 20.0, 20.0));
    let pill = polygon(&Shape::rect(false, [0.0, 0.0, 100.0, 40.0], [9999.0; 4]));
    assert!(!inside(&pill, 2.0, 2.0));
    assert!(inside(&pill, 20.0, 1.0) && inside(&pill, 99.0, 20.0));
}
