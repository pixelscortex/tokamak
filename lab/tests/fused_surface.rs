//! Surface interaction and DOM contracts. GPU captures need the merged renderer.
//! Run capture tests explicitly with `--ignored capture_ --test-threads=1`.
//! PNGs go to TK_CAPTURE_DIR (default /tmp/tkm-fused-poc).
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;
use anyrender::ImageRenderer;
use anyrender_vello::VelloImageRenderer;
use blitz_dom::Document;
use blitz_traits::shell::Viewport;
use render::NativeDocument;
use std::time::Duration;
const VIEWS: [&str; 5] = ["chat", "composer", "select", "buttons", "surfaces"];

fn document(scale: f32, height: f32) -> NativeDocument {
    let mut doc = NativeDocument::new(
        include_str!("../dist/shell.html"),
        include_str!("../dist/ui.js"),
    )
    .unwrap();
    doc.inner_mut().set_viewport(Viewport {
        window_size: ((1440.0 * scale) as u32, (height * scale) as u32),
        hidpi_scale: scale,
        ..Default::default()
    });
    doc.resolve_layout(0.0);
    doc
}
fn paint(doc: &mut NativeDocument) {
    let viewport = doc.inner().viewport().clone();
    render::paint_document(
        &mut anyrender::NullScenePainter,
        doc,
        (viewport.hidpi_scale * viewport.zoom) as f64,
        viewport.window_size.0,
        viewport.window_size.1,
    );
}
fn stage(doc: &NativeDocument) -> blitz_traits::NodeId {
    support::id(doc, "shell-stage")
}

fn scroll_stage(doc: &mut NativeDocument, y: f64) {
    let stage = stage(doc);
    let current = doc.inner().get_node(stage).unwrap().scroll_offset().y;
    doc.inner_mut()
        .scroll_by(stage, 0.0, y - current, Default::default());
    doc.resolve_layout(0.0);
}

fn click(doc: &mut NativeDocument, name: &str) {
    scroll_stage(doc, 0.0);
    support::pointer(doc, name);
    doc.resolve_layout(0.0);
}
fn lab_test(doc: &mut NativeDocument, request: serde_json::Value) {
    assert!(
        doc.host_event(doc.generation(), "lab-test", request)
            .unwrap()
    );
    doc.resolve_layout(0.0);
}
fn open(doc: &mut NativeDocument, view: &str) {
    if view == "fixtures" {
        lab_test(doc, serde_json::json!({ "view": "fixtures" }));
    } else {
        click(doc, &format!("lab-view-{view}"));
        doc.resolve_layout(0.0);
    }
}
fn scroll_to(doc: &mut NativeDocument, name: &str) {
    scroll_stage(doc, 0.0);
    let top = doc.inner().get_client_bounding_rect(stage(doc)).unwrap().y;
    let rect = doc
        .inner()
        .get_client_bounding_rect(support::id(doc, name))
        .unwrap();
    scroll_stage(doc, rect.y - top - 16.0);
}
#[derive(Default)]
struct Redraws(std::sync::atomic::AtomicUsize);
impl blitz_traits::shell::ShellProvider for Redraws {
    fn request_redraw(&self) {
        self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

#[test]
fn only_icons_are_custom_widgets() {
    let mut doc = document(1.0, 900.0);
    for view in VIEWS {
        open(&mut doc, view);
        let inner = doc.inner();
        assert!(inner.query_selector("tk-surface").unwrap().is_none());
        for id in inner.custom_widget_node_ids() {
            assert_eq!(
                &*inner
                    .get_node(id)
                    .unwrap()
                    .element_data()
                    .unwrap()
                    .name
                    .local,
                "tk-icon"
            );
        }
    }
}

#[test]
fn clicks_reach_controls_above_surfaces() {
    let mut doc = document(1.0, 900.0);
    open(&mut doc, "surfaces");
    scroll_to(&mut doc, "lab-cutout");
    support::pointer(&mut doc, "lab-shutter");
    assert_eq!(support::text(&doc, "lab-shutter-presses"), "1 presses");
    assert!(doc.take_error().is_none());
}
#[test]
fn wheel_over_a_surface_scrolls_the_page() {
    use blitz_traits::events::*;
    use keyboard_types::Modifiers;
    let mut doc = document(1.0, 520.0); // short enough that the Surfaces page scrolls
    open(&mut doc, "surfaces");
    scroll_to(&mut doc, "lab-cutout");
    let surface = support::id(&doc, "lab-cutout");
    let rect = doc.inner().get_client_bounding_rect(surface).unwrap();
    let before = doc.inner().get_node(stage(&doc)).unwrap().scroll_offset().y;
    let (x, client_y) = ((rect.x + 12.0) as f32, (rect.y + rect.height - 12.0) as f32);
    let page_y = client_y;
    let coords = PointerCoords {
        page_x: x,
        page_y,
        screen_x: x,
        screen_y: client_y,
        client_x: x,
        client_y,
    };
    let hit = doc.inner().hit(x, page_y).map(|hit| hit.node_id);
    assert!(
        hit.is_some(),
        "the ordinary group participates in hit testing"
    );
    doc.handle_ui_event(UiEvent::PointerMove(BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords,
        button: MouseEventButton::Main,
        buttons: MouseEventButtons::None,
        mods: Modifiers::empty(),
        details: Default::default(),
        element: Default::default(),
        active_pointers: Default::default(),
    }));
    doc.handle_ui_event(UiEvent::Wheel(BlitzWheelEvent {
        delta: BlitzWheelDelta::Pixels(0.0, 120.0),
        coords,
        buttons: MouseEventButtons::None,
        mods: Modifiers::empty(),
        element: Default::default(),
    }));
    let after = doc.inner().get_node(stage(&doc)).unwrap().scroll_offset().y;
    assert_ne!(after, before, "the stage scrolled");
    assert_eq!(
        doc.inner().viewport_scroll().y,
        0.0,
        "the window never scrolls"
    );
}
fn wheel_at(doc: &mut NativeDocument, x: f32, y: f32, delta_y: f64) {
    use blitz_traits::events::*;
    use keyboard_types::Modifiers;
    let coords = PointerCoords {
        page_x: x,
        page_y: y,
        screen_x: x,
        screen_y: y,
        client_x: x,
        client_y: y,
    };
    doc.handle_ui_event(UiEvent::PointerMove(BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords,
        button: MouseEventButton::Main,
        buttons: MouseEventButtons::None,
        mods: Modifiers::empty(),
        details: Default::default(),
        element: Default::default(),
        active_pointers: Default::default(),
    }));
    doc.handle_ui_event(UiEvent::Wheel(BlitzWheelEvent {
        delta: BlitzWheelDelta::Pixels(0.0, delta_y),
        coords,
        buttons: MouseEventButtons::None,
        mods: Modifiers::empty(),
        element: Default::default(),
    }));
}
#[test]
fn a_select_list_at_its_end_does_not_scroll_the_page() {
    let mut doc = document(1.0, 520.0); // short enough that the page scrolls
    open(&mut doc, "select");
    scroll_to(&mut doc, "lab-select-flip-box");
    paint(&mut doc);
    let list = doc
        .inner()
        .query_selector("#lab-select-flip-box [role=listbox]")
        .unwrap()
        .expect("the open list");
    let offset = |doc: &NativeDocument, id| doc.inner().get_node(id).unwrap().scroll_offset().y;
    let around = [stage(&doc), support::id(&doc, "lab-select-flip-box")];
    let before = around.map(|id| offset(&doc, id));
    assert!(
        before[0] > 0.0,
        "the page is scrolled, so it could move back"
    );
    let rect = doc.inner().get_client_bounding_rect(list).unwrap();
    let (x, y) = (
        (rect.x + rect.width / 2.0) as f32,
        (rect.y + rect.height / 2.0) as f32,
    );
    wheel_at(&mut doc, x, y, -4000.0);
    let end = offset(&doc, list);
    assert!(end > 0.0, "the list scrolled");
    assert_eq!(
        around.map(|id| offset(&doc, id)),
        before,
        "nothing else moved"
    );
    wheel_at(&mut doc, x, y, -120.0);
    assert_eq!(offset(&doc, list), end);
    assert_eq!(around.map(|id| offset(&doc, id)), before);
    wheel_at(&mut doc, x, y, 4000.0);
    assert_eq!(offset(&doc, list), 0.0, "back at the top");
    assert_eq!(around.map(|id| offset(&doc, id)), before);
    wheel_at(&mut doc, 700.0, 300.0, 60.0);
    assert!(
        offset(&doc, around[0]) < before[0],
        "the page scrolls elsewhere"
    );
    assert!(doc.take_error().is_none());
}

struct Offscreen {
    renderer: VelloImageRenderer,
    width: u32,
    height: u32,
    scale: f32,
}

impl Offscreen {
    fn new(scale: f32) -> Self {
        let (width, height) = ((1440.0 * scale) as u32, (900.0 * scale) as u32);
        Self {
            renderer: VelloImageRenderer::new(width, height),
            width,
            height,
            scale,
        }
    }
    fn frame(&mut self, doc: &mut NativeDocument) -> Vec<u8> {
        doc.resolve_layout(0.0);
        let mut pixels = Vec::new();
        let (scale, width, height) = (self.scale as f64, self.width, self.height);
        self.renderer.render_to_vec(
            |scene| {
                render::paint_document(scene, doc, scale, width, height);
            },
            &mut pixels,
        );
        pixels
    }
    fn resize(&mut self, doc: &mut NativeDocument, css_width: u32, css_height: u32) {
        let (width, height) = (
            (css_width as f32 * self.scale) as u32,
            (css_height as f32 * self.scale) as u32,
        );
        (self.width, self.height) = (width, height);
        self.renderer.resize(width, height);
        doc.inner_mut().set_viewport(Viewport {
            window_size: (width, height),
            hidpi_scale: self.scale,
            ..Default::default()
        });
    }
    fn save(&mut self, doc: &mut NativeDocument, dir: &str, name: &str) {
        let pixels = self.frame(doc);
        write_png(
            &format!("{dir}/{name}.png"),
            self.width,
            self.height,
            &pixels,
        );
    }
    fn save_settled(&mut self, doc: &mut NativeDocument, dir: &str, name: &str) {
        self.frame(doc);
        std::thread::sleep(Duration::from_millis(300));
        self.frame(doc);
        self.save(doc, dir, name);
    }
}

fn capture_dir() -> String {
    let dir = std::env::var("TK_CAPTURE_DIR").unwrap_or_else(|_| "/tmp/tkm-fused-poc".into());
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
fn write_png(path: &str, width: u32, height: u32, rgba: &[u8]) {
    let file = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    let mut encoder = png::Encoder::new(file, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(rgba)
        .unwrap();
    println!("{path}");
}

#[test]
#[ignore = "writes offscreen GPU captures; run explicitly"]
fn capture_views() {
    let dir = capture_dir();
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    for view in VIEWS {
        out.resize(&mut doc, 1440, 900);
        open(&mut doc, view);
        scroll_stage(&mut doc, 1e6);
        let short = doc.inner().get_node(stage(&doc)).unwrap().scroll_offset().y;
        scroll_stage(&mut doc, 0.0);
        out.resize(&mut doc, 1440, 900 + short.ceil() as u32);
        out.save_settled(&mut doc, &dir, &format!("view-{view}"));
        let pixels = out.frame(&mut doc);
        let stage = doc.inner().get_client_bounding_rect(stage(&doc)).unwrap();
        let x = (stage.x * 2.0) as u32;
        for y in [stage.y + 1.0, stage.y + stage.height - 2.0] {
            let i = (((y * 2.0) as u32 * out.width + x) * 4) as usize;
            assert!(
                pixels[i] > 27,
                "{view}: straight, visible stage edge at {y}"
            );
        }
    }
    assert!(doc.take_error().is_none());
}
#[test]
#[ignore = "writes offscreen GPU captures; run explicitly"]
fn capture_select() {
    let dir = format!("{}/select", capture_dir());
    std::fs::create_dir_all(&dir).unwrap();
    let scale = 2.0;
    let mut doc = document(scale, 900.0);
    let mut out = Offscreen::new(scale);
    open(&mut doc, "select");
    out.save_settled(&mut doc, &dir, "view-select");
    let pixels = out.frame(&mut doc);
    let (width, height) = (out.width, out.height);
    let at = |x: f64, y: f64| {
        let i = (((y * scale as f64) as u32 * width + (x * scale as f64) as u32) * 4) as usize;
        [pixels[i], pixels[i + 1], pixels[i + 2]]
    };
    let rect = |name: &str| {
        doc.inner()
            .get_client_bounding_rect(support::id(&doc, name))
            .unwrap()
    };
    let crop = |name: &str, r: [f64; 4]| {
        let [x, y, w, h] = r.map(|v| (v * scale as f64).round() as u32);
        let mut px = Vec::with_capacity((w * h * 4) as usize);
        for row in y..y + h {
            let start = ((row * width + x) * 4) as usize;
            px.extend_from_slice(&pixels[start..start + (w * 4) as usize]);
        }
        write_png(&format!("{dir}/{name}.png"), w, h, &px);
    };
    let around = |a: blitz_dom::BoundingRect, b: blitz_dom::BoundingRect| {
        let (x0, y0) = (a.x.min(b.x) - 16.0, a.y.min(b.y) - 16.0);
        let (x1, y1) = (
            (a.x + a.width).max(b.x + b.width) + 16.0,
            (a.y + a.height).max(b.y + b.height) + 16.0,
        );
        [
            x0,
            y0.max(0.0),
            x1 - x0,
            (y1.min(height as f64 / scale as f64)) - y0.max(0.0),
        ]
    };
    for (name, crop_name) in [
        ("lab-select-open", "bridge-below"),
        ("lab-select-up", "bridge-above"),
    ] {
        let (trigger, bridge) = (rect(name), rect(&format!("{name}-bridge")));
        assert_eq!(
            at(trigger.x + 12.0, trigger.y + trigger.height / 2.0),
            [0x2a; 3],
            "{name}: the open trigger keeps its dark fill"
        );
        let middle = (
            bridge.x + bridge.width / 2.0,
            bridge.y + bridge.height / 2.0,
        );
        assert_eq!(
            at(middle.0, middle.1),
            [0x2a; 3],
            "{name}: the bridge is the trigger's fill"
        );
        let beside = at(bridge.x - 4.0, middle.1);
        assert_ne!(beside, [0x2a; 3], "{name}: the gap shows beside the bridge");
        crop(crop_name, around(trigger, bridge));
    }
    let (trigger, menu) = (rect("lab-select-merged"), rect("lab-select-merged-menu"));
    let seam = (trigger.x + trigger.width / 2.0, trigger.y + trigger.height);
    assert_eq!(
        at(seam.0, seam.1),
        [0x2a; 3],
        "merged: no seam between trigger and menu"
    );
    crop(
        "merged",
        around(
            trigger,
            blitz_dom::BoundingRect {
                height: 40.0,
                width: menu.width.min(140.0),
                ..menu
            },
        ),
    );
    assert!(doc.take_error().is_none());
}

#[test]
fn an_open_select_has_one_group_for_trigger_bridge_and_menu() {
    let mut doc = document(1.0, 900.0);
    open(&mut doc, "select");
    for name in ["lab-select-open", "lab-select-up"] {
        let root = format!("{name}-fused");
        let group = support::attr(&doc, &root, "tk-group").expect("group root");
        assert_eq!(
            support::attr(&doc, &root, "surface-own").as_deref(),
            Some("false")
        );
        assert_eq!(
            support::attr(&doc, &root, "surface-join").as_deref(),
            Some("3")
        );
        assert!(doc.inner().query_selector("tk-surface").unwrap().is_none());
        for part in ["face", "bridge", "menu"] {
            let member = format!("{name}-{part}");
            assert_eq!(
                support::attr(&doc, &member, "surface-groups").as_deref(),
                Some(group.as_str())
            );
            assert_eq!(
                support::attr(&doc, &member, "surface-op").as_deref(),
                Some("add")
            );
        }
        let rect = |part: &str| {
            doc.inner()
                .get_client_bounding_rect(support::id(&doc, &format!("{name}-{part}")))
                .unwrap()
        };
        let (face, bridge, menu) = (rect("face"), rect("bridge"), rect("menu"));
        assert!((bridge.width - 0.8 * face.width.min(menu.width)).abs() < 0.01);
        assert_eq!(bridge.height, 6.0);
        let trigger = doc
            .inner()
            .get_client_bounding_rect(support::id(&doc, name))
            .unwrap();
        assert_eq!(
            (face.x, face.y, face.width, face.height),
            (trigger.x, trigger.y, trigger.width, trigger.height)
        );
    }
    let face = "lab-select-merged-face";
    assert!(
        doc.inner()
            .get_element_by_id("lab-select-merged-bridge")
            .is_none()
    );
    assert_eq!(
        support::attr(&doc, face, "surface-attach").as_deref(),
        Some("bottom")
    );
    assert!(doc.take_error().is_none());
}

#[test]
fn base_members_cut_the_named_shell_layers() {
    let mut doc = document(1.0, 900.0);
    let sidebar = support::attr(&doc, "shell-sidebar", "tk-group").unwrap();
    let stage = support::attr(&doc, "shell-stage-surface", "tk-group").unwrap();
    for name in ["lab-chat-notch", "lab-chat-composer"] {
        assert_eq!(
            support::attr(&doc, name, "surface-groups"),
            Some(format!("{sidebar} {stage}"))
        );
        assert_eq!(
            support::attr(&doc, name, "surface-op").as_deref(),
            Some("cut")
        );
    }
    assert_eq!(
        support::attr(&doc, "lab-chat-notch", "surface-slant").as_deref(),
        Some("22")
    );
    assert_eq!(
        support::attr(&doc, "lab-chat-composer", "surface-join").as_deref(),
        Some("22")
    );
    assert!(doc.take_error().is_none());
}

#[test]
fn ordinary_background_buttons_keep_their_native_clicks() {
    let mut doc = document(1.0, 900.0);
    open(&mut doc, "fixtures");
    click(&mut doc, "lab-fixture-toggle");
    assert_eq!(
        support::attr(&doc, "lab-fixture-toggle", "aria-pressed").as_deref(),
        Some("true")
    );
    click(&mut doc, "lab-fixture-toggle");
    assert_eq!(
        support::attr(&doc, "lab-fixture-toggle", "aria-pressed").as_deref(),
        Some("false")
    );
    assert!(doc.take_error().is_none());
}

#[test]
fn every_attachment_touches_a_plain_target() {
    for scale in [1.0, 2.0] {
        let mut doc = document(scale, 900.0);
        for (width, height) in [(1440, 900), (1160, 900), (1728, 1117)] {
            doc.inner_mut().set_viewport(Viewport {
                window_size: (
                    (width as f32 * scale) as u32,
                    (height as f32 * scale) as u32,
                ),
                hidpi_scale: scale,
                ..Default::default()
            });
            doc.resolve_layout(0.0);
            for view in VIEWS {
                open(&mut doc, view);
                let d = doc.inner();
                for id in d.query_selector_all("[surface-attach]").unwrap() {
                    let n = d.get_node(id).unwrap();
                    let a = |name: &str| n.attr(blitz_dom::LocalName::from(name));
                    let side = a("surface-attach").unwrap();
                    let group = a("surface-groups").unwrap();
                    let r = d.get_client_bounding_rect(id).unwrap();
                    let found = d
                        .query_selector_all("[tk-group], [surface-groups]")
                        .unwrap()
                        .into_iter()
                        .any(|target| {
                            if target == id {
                                return false;
                            }
                            let t = d.get_node(target).unwrap();
                            let attr = |name: &str| t.attr(blitz_dom::LocalName::from(name));
                            let root = attr("tk-group") == Some(group)
                                && attr("surface-own") != Some("false");
                            let member = attr("surface-groups") == Some(group)
                                && attr("surface-op") != Some("cut")
                                && attr("surface-attach").is_none();
                            if !root && !member {
                                return false;
                            }
                            let t = d.get_client_bounding_rect(target).unwrap();
                            match side {
                                "right" => {
                                    (t.x - r.x - r.width).abs() < 0.5
                                        && t.y < r.y + r.height
                                        && t.y + t.height > r.y
                                }
                                "left" => {
                                    (t.x + t.width - r.x).abs() < 0.5
                                        && t.y < r.y + r.height
                                        && t.y + t.height > r.y
                                }
                                "bottom" => {
                                    (t.y - r.y - r.height).abs() < 0.5
                                        && t.x < r.x + r.width
                                        && t.x + t.width > r.x
                                }
                                "top" => {
                                    (t.y + t.height - r.y).abs() < 0.5
                                        && t.x < r.x + r.width
                                        && t.x + t.width > r.x
                                }
                                _ => false,
                            }
                        });
                    assert!(
                        found,
                        "{view} scale {scale}: node {id:?} ({:?}) attach {side} has no touching target",
                        a("id")
                    );
                }
            }
        }
    }
}

fn pointer_at(
    doc: &mut NativeDocument,
    name: &str,
    buttons: blitz_traits::events::MouseEventButtons,
) -> blitz_traits::events::BlitzPointerEvent {
    use blitz_traits::events::*;
    use keyboard_types::Modifiers;
    doc.resolve_layout(0.0);
    let rect = doc
        .inner()
        .get_client_bounding_rect(support::id(doc, name))
        .unwrap();
    let (x, y) = (
        (rect.x + rect.width / 2.0) as f32,
        (rect.y + rect.height / 2.0) as f32,
    );
    BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords: PointerCoords {
            page_x: x,
            page_y: y,
            screen_x: x,
            screen_y: y,
            client_x: x,
            client_y: y,
        },
        button: MouseEventButton::Main,
        buttons,
        mods: Modifiers::empty(),
        details: Default::default(),
        element: Default::default(),
        active_pointers: Default::default(),
    }
}

/// Pointer down (`up` false) or up over the centre of element `name`, without
/// the other half of a click: `:active` holds between the two.
fn pointer_half(doc: &mut NativeDocument, name: &str, up: bool) {
    use blitz_traits::events::{MouseEventButtons, UiEvent};
    let buttons = if up {
        MouseEventButtons::None
    } else {
        MouseEventButtons::Primary
    };
    let event = pointer_at(doc, name, buttons);
    doc.handle_ui_event(UiEvent::PointerMove(event.clone()));
    doc.handle_ui_event(if up {
        UiEvent::PointerUp(event)
    } else {
        UiEvent::PointerDown(event)
    });
    doc.resolve_layout(0.0);
    paint(doc);
}

/// The pointer moves over the centre of element `name` (`:hover`).
fn hover(doc: &mut NativeDocument, name: &str) {
    use blitz_traits::events::{MouseEventButtons, UiEvent};
    let event = pointer_at(doc, name, MouseEventButtons::None);
    doc.handle_ui_event(UiEvent::PointerMove(event));
    doc.resolve_layout(0.0);
}

#[test]
fn idle_surfaces_request_no_frames() {
    for scale in [1.0, 2.0] {
        let mut doc = document(scale, 900.0);
        for view in VIEWS.iter().chain(&["fixtures"]) {
            open(&mut doc, view);
            for (w, h) in [(1440, 900), (1160, 780)] {
                doc.inner_mut().set_viewport(Viewport {
                    window_size: ((w as f32 * scale) as u32, (h as f32 * scale) as u32),
                    hidpi_scale: scale,
                    ..Default::default()
                });
                doc.resolve_layout(0.0);
                let redraws = std::sync::Arc::new(Redraws::default());
                doc.inner_mut().set_shell_provider(redraws.clone());
                paint(&mut doc);
                assert_eq!(
                    redraws.0.load(std::sync::atomic::Ordering::Relaxed),
                    0,
                    "{view} scale {scale} {w}x{h}"
                );
                assert!(!doc.inner().is_animating(), "{view} scale {scale} {w}x{h}");
            }
        }
        assert!(doc.take_error().is_none());
    }
}

#[test]
fn a_view_switch_lands_without_animating() {
    for scale in [1.0, 2.0] {
        let mut doc = document(scale, 900.0);
        for view in [
            "composer", "surfaces", "chat", "select", "chat", "buttons", "chat",
        ] {
            open(&mut doc, view);
            let redraws = std::sync::Arc::new(Redraws::default());
            doc.inner_mut().set_shell_provider(redraws.clone());
            paint(&mut doc);
            assert_eq!(
                redraws.0.load(std::sync::atomic::Ordering::Relaxed),
                0,
                "to {view} scale {scale}"
            );
            assert!(!doc.inner().is_animating(), "to {view} scale {scale}");
        }
        assert!(doc.take_error().is_none());
    }
}

#[test]
fn the_select_trigger_keeps_its_box_on_hover() {
    let mut doc = document(1.0, 900.0);
    open(&mut doc, "select");
    let name = "lab-select-field";
    let rect = |doc: &NativeDocument| {
        let r = doc
            .inner()
            .get_client_bounding_rect(support::id(doc, name))
            .unwrap();
        let inner = doc.inner();
        let style = inner
            .get_node(support::id(doc, name))
            .unwrap()
            .primary_styles()
            .unwrap();
        assert_eq!(format!("{:?}", style.slow_clone_translate()), "None");
        [r.x, r.y, r.width, r.height]
    };
    let before = rect(&doc);
    for open in [false, true] {
        hover(&mut doc, name);
        assert_eq!(rect(&doc), before, "hover open={open}");
        pointer_half(&mut doc, name, false);
        assert_eq!(rect(&doc), before, "press open={open}");
        pointer_half(&mut doc, name, true);
        assert_eq!(rect(&doc), before, "release open={open}");
        assert_eq!(
            support::attr(&doc, name, "aria-expanded").as_deref(),
            Some(if open { "false" } else { "true" })
        );
    }
    assert!(doc.take_error().is_none());
}

fn compare_resize(
    doc: &mut NativeDocument,
    out: &mut Offscreen,
    view: &str,
    w: u32,
    h: u32,
    fullscreen: bool,
) {
    let set_full = |doc: &mut NativeDocument| {
        let root = doc.inner().root_element().id;
        let attr = blitz_dom::QualName::new(
            None,
            blitz_dom::Namespace::from(""),
            blitz_dom::LocalName::from("data-fullscreen"),
        );
        if fullscreen {
            doc.inner_mut().mutate().set_attribute(root, attr, "");
        } else {
            doc.inner_mut().mutate().clear_attribute(root, attr);
        }
    };
    out.resize(doc, w, h);
    set_full(doc);
    let live = out.frame(doc);
    let mut fresh = document(out.scale, 900.0);
    open(&mut fresh, view);
    out.resize(&mut fresh, w, h);
    set_full(&mut fresh);
    let want = out.frame(&mut fresh);
    let differing = live
        .iter()
        .zip(&want)
        .filter(|(a, b)| a.abs_diff(**b) > 1)
        .count();
    assert_eq!(differing, 0, "{view} {w}x{h} full={fullscreen}");
    let stage = doc.inner().get_client_bounding_rect(stage(doc)).unwrap();
    let at = |x: f64, y: f64| {
        let i = (((y * out.scale as f64) as u32 * out.width + (x * out.scale as f64) as u32) * 4)
            as usize;
        [live[i], live[i + 1], live[i + 2]]
    };
    let y = stage.y + stage.height * 0.5 + 100.0;
    assert_eq!(at(stage.x + 20.0, y), [0x1b; 3], "stage drawn");
    assert_eq!(at(stage.x - 100.0, y), [0x17; 3], "sidebar drawn");
}

#[test]
#[ignore = "offscreen GPU frames; run explicitly"]
fn resize_frames_match_fresh_renders() {
    let mut out = Offscreen::new(2.0);
    for view in VIEWS {
        let mut doc = document(2.0, 900.0);
        open(&mut doc, view);
        out.resize(&mut doc, 1440, 900);
        out.frame(&mut doc);
        for w in [1400, 1300, 1160, 1320, 1440] {
            compare_resize(&mut doc, &mut out, view, w, 900, false);
        }
    }
}

#[test]
#[ignore = "offscreen GPU frames; run explicitly"]
fn full_screen_sizes_draw_every_shell_surface() {
    let mut out = Offscreen::new(2.0);
    for view in VIEWS {
        let mut doc = document(2.0, 900.0);
        open(&mut doc, view);
        out.resize(&mut doc, 1440, 900);
        out.frame(&mut doc);
        for (w, h, full) in [
            (1728, 1117, true),
            (1428, 917, false),
            (1440, 900, false),
            (1728, 1117, true),
        ] {
            compare_resize(&mut doc, &mut out, view, w, h, full);
        }
    }
}

#[test]
#[ignore = "release paint benchmark; run explicitly"]
fn release_paint_benchmark() {
    for scale in [1.0, 2.0] {
        for view in ["chat", "select", "composer", "surfaces"] {
            let mut doc = document(scale, 900.0);
            open(&mut doc, view);
            for groups in [true, false] {
                if !groups {
                    use blitz_dom::{Namespace, QualName};
                    let ids = doc
                        .inner()
                        .query_selector_all("[tk-group], [surface-groups]")
                        .unwrap();
                    for id in ids {
                        for name in ["tk-group", "surface-groups"] {
                            doc.inner_mut().mutate().clear_attribute(
                                id,
                                QualName::new(None, Namespace::from(""), name.into()),
                            );
                        }
                    }
                    doc.resolve_layout(0.0);
                }
                for _ in 0..20 {
                    paint(&mut doc);
                }
                let mut samples = Vec::new();
                for _ in 0..80 {
                    let start = std::time::Instant::now();
                    paint(&mut doc);
                    samples.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                samples.sort_by(f64::total_cmp);
                println!(
                    "REVIEW_BENCH view={view} scale={scale} groups={groups} median_ms={:.6} p10_ms={:.6} p90_ms={:.6}",
                    samples[40], samples[8], samples[72]
                );
            }
        }
    }
}

#[test]
#[ignore = "release locate benchmark; run explicitly"]
fn release_locate_benchmark() {
    use blitz_paint::{ElementPaint, ElementPainter};
    use std::cell::Cell;
    struct Timed {
        painter: render::SurfacePainter,
        elapsed: Cell<Option<Duration>>,
    }
    impl ElementPainter<anyrender::NullScenePainter> for Timed {
        fn paint_element(
            &self,
            el: &mut ElementPaint<'_, anyrender::NullScenePainter>,
            scene: &mut anyrender::NullScenePainter,
        ) {
            if self.elapsed.get().is_none() && el.node().attr("tk-group".into()).is_some() {
                let start = std::time::Instant::now();
                let _ = el.locate(el.node().id);
                self.elapsed.set(Some(start.elapsed()));
            }
            self.painter.paint_element(el, scene);
        }
    }
    for view in ["chat", "select", "composer", "surfaces", "long"] {
        let mut doc = if view == "long" {
            let mut doc = NativeDocument::new(
                "<html><body style='margin:0'><div id='app'></div></body></html>",
                r#"let pending = [
                    {op:'element',id:1,tag:'div'}, {op:'attribute',id:1,name:'style',value:'height:800px;overflow:hidden'}, {op:'insert',id:1,parent:0,before:null},
                    {op:'element',id:2,tag:'div'}, {op:'attribute',id:2,name:'tk-group',value:'long'}, {op:'attribute',id:2,name:'style',value:'width:100px;height:20px;--tk-fill:red'}, {op:'insert',id:2,parent:1,before:null}
                ];
                for (let id=3; id<4003; id++) pending.push({op:'element',id,tag:'div'}, {op:'attribute',id,name:'style',value:'height:24px'}, {op:'insert',id,parent:1,before:null});
                globalThis.__tokamak = { dispatch() { return '{"prevented":false,"stopped":false,"error":null}'; }, host() {}, drain() { const out=JSON.stringify(pending); pending=[]; return out; }, dispose() {} };"#,
            ).unwrap();
            doc.inner_mut().set_viewport(Viewport {
                window_size: (2880, 1800),
                hidpi_scale: 2.0,
                ..Default::default()
            });
            doc.resolve_layout(0.0);
            let scroll = doc.inner().query_selector("#app > div").unwrap().unwrap();
            doc.inner_mut()
                .scroll_by(scroll, 0.0, 10.0, Default::default());
            doc
        } else {
            let mut doc = document(2.0, 900.0);
            open(&mut doc, view);
            doc
        };
        let timed = Timed {
            painter: doc.surface_painter(),
            elapsed: Cell::new(None),
        };
        let mut samples = Vec::new();
        for i in 0..100 {
            timed.elapsed.set(None);
            blitz_paint::paint_scene_with(
                &mut anyrender::NullScenePainter,
                &mut doc.inner_mut(),
                2.0,
                2880,
                1800,
                0,
                0,
                &timed,
            );
            if i >= 20 {
                samples.push(
                    timed
                        .elapsed
                        .get()
                        .expect("group called locate")
                        .as_secs_f64()
                        * 1000.0,
                );
            }
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "LOCATE_BENCH view={view} scale=2 median_ms={:.6}",
            samples[40]
        );
    }
}

#[test]
fn scrolling_the_select_face_out_of_view_preserves_the_outline_and_join() {
    use anyrender::{PaintScene, Scene, recording::RenderCommand};
    use blitz_paint::{ElementPaint, ElementPainter};
    use geo::{Area, BooleanOps, Contains};
    use peniko::{
        Fill,
        kurbo::{Affine, PathEl},
    };
    use std::cell::RefCell;
    struct Outline {
        painter: render::SurfacePainter,
        root: blitz_traits::NodeId,
        region: RefCell<Option<geo::MultiPolygon<f64>>>,
    }
    impl ElementPainter<Scene> for Outline {
        fn paint_element(&self, el: &mut ElementPaint<'_, Scene>, scene: &mut Scene) {
            if el.node().id != self.root {
                self.painter.paint_element(el, scene);
                return;
            }
            let inverse = (el.transform() * Affine::scale(el.scale())).inverse();
            let mut picture = Scene::new();
            self.painter.paint_element(el, &mut picture);
            let layer = picture
                .commands
                .iter()
                .find_map(|c| match c {
                    RenderCommand::PushLayer(layer) if layer.fill == Fill::EvenOdd => Some(layer),
                    _ => None,
                })
                .expect("fused outline clip");
            let transform = inverse * layer.transform;
            let mut rings = Vec::new();
            let mut points = Vec::new();
            for element in layer.clip.elements() {
                match element {
                    PathEl::MoveTo(p) | PathEl::LineTo(p) => {
                        let p = transform * *p;
                        points.push((p.x, p.y));
                    }
                    PathEl::ClosePath => {
                        rings.push(geo::LineString::from(std::mem::take(&mut points)))
                    }
                    _ => panic!("fused contour is polygonal"),
                }
            }
            assert_eq!(rings.len(), 1);
            *self.region.borrow_mut() = Some(geo::MultiPolygon(vec![geo::Polygon::new(
                rings.remove(0),
                vec![],
            )]));
            scene.append_scene(picture, Affine::IDENTITY);
        }
    }
    let mut doc = document(1.0, 520.0);
    open(&mut doc, "select");
    let root = support::id(&doc, "lab-select-open-fused");
    let outline = Outline {
        painter: doc.surface_painter(),
        root,
        region: RefCell::new(None),
    };
    let mut regions = Vec::new();
    let mut fillets = Vec::new();
    for scroll in [213.9, 214.1] {
        scroll_stage(&mut doc, scroll);
        let bridge = doc
            .inner()
            .get_client_bounding_rect(support::id(&doc, "lab-select-open-bridge"))
            .unwrap();
        let root_box = doc.inner().get_client_bounding_rect(root).unwrap();
        let fillet = geo::Point::new(bridge.x - root_box.x - 0.5, bridge.y - root_box.y + 0.5);
        blitz_paint::paint_scene_with(
            &mut Scene::new(),
            &mut doc.inner_mut(),
            1.0,
            1440,
            520,
            0,
            0,
            &outline,
        );
        let region = outline.region.borrow_mut().take().unwrap();
        fillets.push(region.contains(&fillet));
        regions.push(region);
    }
    let difference = regions[0].xor(&regions[1]).unsigned_area();
    assert!(
        fillets.iter().all(|present| *present),
        "face-to-bridge fillets {fillets:?}; difference {difference} CSS px²"
    );
    assert!(
        difference < 0.01,
        "root-space outline changed by {difference} CSS px²"
    );
}
