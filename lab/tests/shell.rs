//! Shell interaction and DOM contracts with offscreen GPU captures.
//! Run capture tests explicitly with `--ignored capture_ --test-threads=1`.
//! PNGs go to TK_CAPTURE_DIR (default /tmp/tkm-minimal-ui).
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;
use anyrender::ImageRenderer;
use anyrender_vello::VelloImageRenderer;
use blitz_dom::Document;
use blitz_traits::shell::Viewport;
use render::NativeDocument;
use std::time::Duration;
const VIEWS: [&str; 4] = ["chat", "composer", "select", "buttons"];

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
    blitz_paint::paint_scene(
        &mut anyrender::NullScenePainter,
        &mut doc.inner_mut(),
        (viewport.hidpi_scale * viewport.zoom) as f64,
        viewport.window_size.0,
        viewport.window_size.1,
        0,
        0,
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
fn wheel_over_content_scrolls_the_page() {
    use blitz_traits::events::*;
    use keyboard_types::Modifiers;
    let mut doc = document(1.0, 520.0); // short enough that the Buttons page scrolls
    open(&mut doc, "buttons");
    scroll_stage(&mut doc, 200.0);
    let rect = doc.inner().get_client_bounding_rect(stage(&doc)).unwrap();
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
        "ordinary content participates in hit testing"
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
    let dir = std::env::var("TK_CAPTURE_DIR").unwrap_or_else(|_| "/tmp/tkm-minimal-ui".into());
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
    let width = out.width;
    let at = |x: f64, y: f64| {
        let i = (((y * scale as f64) as u32 * width + (x * scale as f64) as u32) * 4) as usize;
        [pixels[i], pixels[i + 1], pixels[i + 2]]
    };
    let rect = |name: &str| {
        doc.inner()
            .get_client_bounding_rect(support::id(&doc, name))
            .unwrap()
    };
    for name in ["lab-select-open", "lab-select-up"] {
        let trigger = rect(name);
        assert_eq!(
            at(trigger.x + 12.0, trigger.y + trigger.height / 2.0),
            [0x2a; 3],
            "{name}: the open trigger keeps its dark fill"
        );
    }
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
fn idle_views_request_no_frames() {
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
        for view in ["composer", "chat", "select", "chat", "buttons", "chat"] {
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
        assert_eq!(format!("{:?}", style.clone_translate()), "None");
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
