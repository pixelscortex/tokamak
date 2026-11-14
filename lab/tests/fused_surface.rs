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
    let surface = doc
        .inner()
        .query_selector("#lab-cutout > tk-surface[group]")
        .unwrap()
        .expect("the cut-out's surface layer");
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
    assert_ne!(hit, Some(surface), "the surface layer is not a hit target");
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
    doc.layout_surfaces();
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
        doc.layout_surfaces();
        let mut pixels = Vec::new();
        let (scale, width, height) = (self.scale as f64, self.width, self.height);
        self.renderer.render_to_vec(
            |scene| {
                blitz_paint::paint_scene(scene, &mut doc.inner_mut(), scale, width, height, 0, 0);
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
        let layer = doc
            .inner()
            .query_selector(&format!("#{root} > tk-surface:first-child"))
            .unwrap()
            .unwrap();
        assert_eq!(
            doc.inner().get_node(layer).unwrap().attr("group".into()),
            Some(group.as_str())
        );
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
