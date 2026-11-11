//! Surfaces, plates and the shell in the real lab document (render/src/surface,
//! lab/src).
//!
//! The first tests are fast and headless: interaction through the production
//! document API, no GPU. The `#[ignore]`d ones paint the lab offscreen through
//! the production paint path (blitz-paint + Vello on a real wgpu device, with
//! the per-frame `surface_end_frame` hook the window uses) and are run
//! explicitly:
//! `cargo test --release -p tokamak-lab --test fused_surface -- --ignored --test-threads=1`.
//! Captures go to `$TK_CAPTURE_DIR` (default `/tmp/tkm-fused-poc`) as PNG.
//!
//! Markup that only these tests need lives in the lab's fixtures view
//! (lab/src/fixtures.tsx), which the sidebar does not list:
//! `open(doc, "fixtures")` asks for it with the `lab-test` host event, as
//! `painter` does for the plate painter of the shell regions
//! (lab/src/app.tsx).
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;
use anyrender::ImageRenderer;
use anyrender_vello::VelloImageRenderer;
use blitz_dom::Document;
use blitz_traits::shell::Viewport;
use render::NativeDocument;
use std::time::{Duration, Instant};

/// The lab's views, as the plugin sidebar lists them (lab/src/app.tsx).
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

/// The window never scrolls; the shell's stage does. Clicks happen with the
/// stage scrolled to the top, where the controls under test are visible.
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
}

/// Send the lab's test-only host event (lab/src/app.tsx, `TestRequest`).
fn lab_test(doc: &mut NativeDocument, request: serde_json::Value) {
    assert!(
        doc.host_event(doc.generation(), "lab-test", request)
            .unwrap()
    );
    doc.resolve_layout(0.0);
}

/// Open a lab view: from the sidebar, or the fixtures view (not listed).
fn open(doc: &mut NativeDocument, view: &str) {
    if view == "fixtures" {
        lab_test(doc, serde_json::json!({ "view": "fixtures" }));
    } else {
        click(doc, &format!("lab-view-{view}"));
        doc.resolve_layout(0.0);
    }
}

/// Scroll the stage so `name` sits near its top.
fn scroll_to(doc: &mut NativeDocument, name: &str) {
    scroll_stage(doc, 0.0);
    let top = doc.inner().get_client_bounding_rect(stage(doc)).unwrap().y;
    let rect = doc
        .inner()
        .get_client_bounding_rect(support::id(doc, name))
        .unwrap();
    scroll_stage(doc, rect.y - top - 16.0);
}

// ---------------------------------------------------------------- headless

/// Controls drawn above a surface stay clickable (the surface is a background
/// layer, not a hit target): the shutter in the Surfaces view's cut-out.
#[test]
fn clicks_reach_controls_above_surfaces() {
    let mut doc = document(1.0, 900.0);
    open(&mut doc, "surfaces");
    scroll_to(&mut doc, "lab-cutout");
    support::pointer(&mut doc, "lab-shutter");
    assert_eq!(support::text(&doc, "lab-shutter-presses"), "1 presses");
    assert!(doc.take_error().is_none());
}

/// Wheel over an empty part of a surface must scroll the page. Custom-widget
/// nodes take every event they are hit by (blitz-dom forwards it to
/// `Widget::handle_event` and returns, skipping the default wheel scroll), so
/// surfaces are transparent to hit testing (`pointer-events: none`, render's
/// user-agent defaults for `tk-surface`).
#[test]
fn wheel_over_a_surface_scrolls_the_page() {
    use blitz_traits::events::*;
    use keyboard_types::Modifiers;
    let mut doc = document(1.0, 520.0); // short enough that the Surfaces page scrolls
    open(&mut doc, "surfaces");
    let surface = doc
        .inner()
        .query_selector("#lab-cutout > tk-surface[group]")
        .unwrap()
        .expect("the cut-out's surface layer");
    let rect = doc.inner().get_client_bounding_rect(surface).unwrap();
    let before = doc.inner().get_node(stage(&doc)).unwrap().scroll_offset().y;
    // Aim near the surface's bottom-left corner, with no DOM content above
    // it. The window does not scroll, so client and page coordinates are
    // the same.
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
        // Blitz scrolls by minus the wheel delta: negative scrolls down.
        delta: BlitzWheelDelta::Pixels(0.0, -120.0),
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

/// The shell schedules frames only while `is_animating()`: every view,
/// idle, requests none (nothing in the lab animates).
#[test]
fn idle_surfaces_request_no_frames() {
    let mut doc = document(1.0, 900.0);
    for view in VIEWS.iter().chain(&["fixtures"]) {
        open(&mut doc, view);
        doc.layout_surfaces();
        assert!(
            !doc.inner().is_animating(),
            "{view}: idle requests no frames"
        );
    }
    assert!(doc.take_error().is_none());
}

/// A view switch (which adds or removes the Chat title notch and composer
/// in the shell layers in the same layout pass) lands in one frame, and the
/// document asks for no further frames: no shape in the lab animates.
#[test]
fn a_view_switch_lands_without_animating() {
    let mut doc = document(1.0, 900.0);
    doc.layout_surfaces();
    assert!(!doc.inner().is_animating());
    for view in [
        "composer", "surfaces", "chat", "select", "chat", "buttons", "chat",
    ] {
        support::pointer(&mut doc, &format!("lab-view-{view}"));
        doc.resolve_layout(0.0);
        doc.layout_surfaces();
        assert!(!doc.inner().is_animating(), "to {view}: nothing animates");
    }
    assert!(doc.take_error().is_none());
}

/// The stage scroller must be a stacking context. Blitz hoists every
/// descendant with a z-index to the nearest stacking context and paints it
/// there; when that was an ancestor of the scroller, scrolled content with a
/// z-index was drawn over the top bar.
#[test]
fn the_stage_scroller_clips_content_that_has_a_z_index() {
    let mut doc = document(1.0, 900.0);
    open(&mut doc, "surfaces");
    let stage = stage(&doc);
    assert!(
        doc.inner()
            .get_node(stage)
            .unwrap()
            .is_stacking_context_root(false),
        "the stage scroller owns the paint order of its z-indexed content"
    );
    assert!(doc.take_error().is_none());
}

// ---------------------------------------------------------------- offscreen GPU

/// Offscreen frame source: the production paint path for a 1440x900 CSS
/// viewport at scale 2, like the lab window.
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

    /// Returns the pixels, the time in paint_scene plus the per-frame surface
    /// hook (scene building, including every widget's `paint`), and the total
    /// frame time (resolve, scene building, Vello GPU raster and the
    /// GPU-to-CPU readback, which a window does not do).
    fn frame(&mut self, doc: &mut NativeDocument) -> (Vec<u8>, Duration, Duration) {
        let start = Instant::now();
        // What the window does on each redraw: layout, then the surface
        // layout pass, then paint.
        doc.resolve_layout(0.0);
        doc.layout_surfaces();
        let mut pixels = Vec::new();
        let mut scene_time = Duration::ZERO;
        let (scale, width, height) = (self.scale as f64, self.width, self.height);
        self.renderer.render_to_vec(
            |scene| {
                let t = Instant::now();
                blitz_paint::paint_scene(scene, &mut doc.inner_mut(), scale, width, height, 0, 0);
                // What the window's FrameRenderer does after each paint.
                render::surface_end_frame();
                scene_time = t.elapsed();
            },
            &mut pixels,
        );
        (pixels, scene_time, start.elapsed())
    }

    /// Resize the window: viewport and render target, as the shell does on
    /// `SurfaceResized` (the next `frame` is the redraw that follows).
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

    /// Draw a frame and save it as `{dir}/{name}.png`.
    fn save(&mut self, doc: &mut NativeDocument, dir: &str, name: &str) {
        let (pixels, _, _) = self.frame(doc);
        write_png(
            &format!("{dir}/{name}.png"),
            self.width,
            self.height,
            &pixels,
        );
    }

    /// Let any shape animation (220 ms) finish, then save.
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

/// Write RGBA8 pixels, `width` x `height` device px, as a PNG.
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

/// Live resize, frame by frame: every frame drawn while the window size
/// changes must equal a from-scratch render of the lab at that size (a
/// fresh document and renderer), so no frame shows a blank surface, a
/// surface at its old size or shapes from the previous layout.
#[test]
#[ignore = "offscreen GPU frames; run explicitly"]
fn resize_frames_match_fresh_renders() {
    let dir = capture_dir();
    let scale = 2.0;
    let mut doc = document(scale, 900.0);
    let mut out = Offscreen::new(scale);
    out.frame(&mut doc);
    let mut widths: Vec<u32> = (0..=7).map(|i| 1440 - i * 20).collect();
    widths.extend((1..=8).map(|i| 1300 - i * 17 - (i == 8) as u32 * 4));
    widths.extend((1..=8).map(|i| 1160 + i * 20));
    // The fresh documents render through the same renderer: wgpu compares
    // devices by per-instance id, so a second offscreen renderer's device can
    // compare equal to the first and pick up its cached pipeline (surface
    // caches are per device; a window has exactly one).
    let mut worst = (0usize, 0u32);
    for (step, &w) in widths.iter().enumerate().skip(1) {
        out.resize(&mut doc, w, 900);
        let (work, px) = (render::surface_paint_work(), render::surface_dirty_pixels());
        let (live, scene, total) = out.frame(&mut doc);
        let work = render::surface_paint_work() - work;
        let px = render::surface_dirty_pixels() - px;
        let mut fresh_doc = document(scale, 900.0);
        fresh_doc.inner_mut().set_viewport(Viewport {
            window_size: ((w as f32 * scale) as u32, (900.0 * scale) as u32),
            hidpi_scale: scale,
            ..Default::default()
        });
        // The reference shares the renderer (and Vello's image atlas) with
        // the live document: draw until it settles too.
        let mut want = out.frame(&mut fresh_doc).0;
        for _ in 0..4 {
            want = out.frame(&mut fresh_doc).0;
        }
        drop(fresh_doc);
        // Back to the live document, as the only one again (a window never
        // has two): let Vello drop the reference's images first.
        out.resize(&mut doc, w, 900);
        for _ in 0..3 {
            out.frame(&mut doc);
        }
        let differing = live
            .chunks(4)
            .zip(want.chunks(4))
            .filter(|(a, b)| a.iter().zip(*b).any(|(x, y)| x.abs_diff(*y) > 2))
            .count();
        println!(
            "resize step {step}: {w} css px: frame {:.2} ms (with readback), scene build {:.2} ms, \
             surface paint {:.2} ms, {:.0} kpx re-rendered; {differing} px differ from a fresh render",
            total.as_secs_f64() * 1e3,
            scene.as_secs_f64() * 1e3,
            work.as_secs_f64() * 1e3,
            px as f64 / 1e3,
        );
        if differing > worst.0 {
            worst = (differing, w);
            let (width, height) = (out.width, out.height);
            for (name, px) in [("live", &live), ("fresh", &want)] {
                write_png(&format!("{dir}/resize-{name}-{w}.png"), width, height, px);
            }
        }
    }
    assert_eq!(worst.0, 0, "worst frame at {} css px", worst.1);
}

/// No continuous redraws: after a view switch settles, the document
/// requests no frames (the shell's frame counter stops) and repainting it
/// re-renders no surface pixel, in every view and the fixtures view,
/// with either painter, and after a resize.
#[test]
#[ignore = "offscreen GPU frames; run explicitly"]
fn settled_views_request_no_frames_and_render_nothing() {
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    let settle = |doc: &mut NativeDocument, out: &mut Offscreen| {
        let mut frames = 0;
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(1000) {
            out.frame(doc);
            frames += 1;
            std::thread::sleep(Duration::from_millis(8));
            if !doc.inner().is_animating() && start.elapsed() > Duration::from_millis(250) {
                break;
            }
        }
        frames
    };
    // With each painter: every plate painting itself, then the sheets.
    for mode in PAINTERS {
        painter(&mut doc, mode);
        for section in VIEWS.iter().chain(&["fixtures", "chat"]) {
            open(&mut doc, section);
            let frames = settle(&mut doc, &mut out);
            assert!(
                !doc.inner().is_animating(),
                "{mode} {section}: still requesting frames after {frames}"
            );
            let (work, px) = (render::surface_paint_work(), render::surface_dirty_pixels());
            for _ in 0..10 {
                out.frame(&mut doc);
                assert!(
                    !doc.inner().is_animating(),
                    "{mode} {section}: a repaint asked for more"
                );
            }
            let px = render::surface_dirty_pixels() - px;
            let work = render::surface_paint_work() - work;
            println!(
                "{mode} {section}: settled after {frames} frames; 10 idle repaints re-rendered {px} px, \
                 surface paint {:.3} ms in total",
                work.as_secs_f64() * 1e3
            );
            assert_eq!(
                px, 0,
                "{mode} {section}: idle repaints re-rendered surface pixels"
            );
        }
    }
    painter(&mut doc, "self");
    // The layout binding pass on an idle document (every redraw runs it).
    open(&mut doc, "chat");
    settle(&mut doc, &mut out);
    let t = Instant::now();
    for _ in 0..200 {
        doc.layout_surfaces();
    }
    println!(
        "layout binding pass, idle chat: {:.1} us",
        t.elapsed().as_secs_f64() * 1e6 / 200.0
    );
    out.resize(&mut doc, 1100, 800);
    let frames = settle(&mut doc, &mut out);
    assert!(
        !doc.inner().is_animating(),
        "after a resize: {frames} frames"
    );
    assert!(doc.take_error().is_none());
}

/// Full-screen sizes at scale 2: every shell layer (the plugin container and
/// the stage panel) is drawn, at the jump from the normal window straight to
/// full screen (with `data-fullscreen` set in the same frame), at a resize
/// into and out of it, and the result matches a from-scratch render.
#[test]
#[ignore = "offscreen GPU frames; run explicitly"]
fn full_screen_sizes_draw_every_shell_surface() {
    let scale = 2.0;
    let mut doc = document(scale, 900.0);
    let mut out = Offscreen::new(scale);
    out.frame(&mut doc);
    let set_full = |doc: &mut NativeDocument, on: bool| {
        let root = doc.inner().root_element().id;
        let name = blitz_dom::QualName::new(
            None,
            blitz_dom::Namespace::from(""),
            blitz_dom::LocalName::from("data-fullscreen"),
        );
        if on {
            doc.inner_mut().mutate().set_attribute(root, name, "");
        } else {
            doc.inner_mut().mutate().clear_attribute(root, name);
        }
    };
    // Device-pixel colour at a CSS point.
    let at = |px: &[u8], width: u32, x: f32, y: f32| {
        let i = (((y * scale) as u32 * width + (x * scale) as u32) * 4) as usize;
        [px[i], px[i + 1], px[i + 2]]
    };
    let check = |doc: &mut NativeDocument, out: &mut Offscreen, label: &str| {
        // What the window does: draw, and keep drawing while the document
        // asks for frames (a surface that registered a new texture asks for
        // a few, see gpu.rs `SETTLE_FRAMES`). The frame the window stops on
        // must show everything.
        let (mut px, _, _) = out.frame(doc);
        let mut extra = 0;
        while doc.inner().is_animating() && extra < 10 {
            px = out.frame(doc).0;
            extra += 1;
        }
        let stage = doc
            .inner()
            .get_client_bounding_rect(support::id(doc, "shell-stage"))
            .unwrap();
        let sidebar_x = stage.x as f32 - 100.0;
        let mid = (stage.y + stage.height * 0.5) as f32;
        // Empty stage area (the lane's left padding) and the sidebar's
        // empty area below its list.
        let panel = at(&px, out.width, stage.x as f32 + 20.0, mid + 100.0);
        let sidebar = at(&px, out.width, sidebar_x, mid + 100.0);
        println!("{label}: stage {panel:?}, sidebar {sidebar:?}");
        assert_eq!(panel, [0x1b; 3], "{label}: the stage panel is drawn");
        assert_eq!(sidebar, [0x17; 3], "{label}: the plugin container is drawn");
        px
    };
    for (w, h) in [(1728, 1117), (2056, 1329), (2560, 1440), (3024, 1964)] {
        // Straight from the normal window to full screen, in one frame.
        out.resize(&mut doc, 1440, 900);
        set_full(&mut doc, false);
        out.frame(&mut doc);
        out.resize(&mut doc, w, h);
        set_full(&mut doc, true);
        let live = check(&mut doc, &mut out, &format!("{w}x{h} jump"));
        let mut fresh_doc = document(scale, 900.0);
        out.resize(&mut fresh_doc, w, h);
        set_full(&mut fresh_doc, true);
        // The reference shares the renderer (and Vello's image atlas) with
        // the live document: draw until it settles too.
        let mut want = out.frame(&mut fresh_doc).0;
        for _ in 0..4 {
            want = out.frame(&mut fresh_doc).0;
        }
        drop(fresh_doc);
        // Back to the live document, as the only one again (a window never
        // has two): let Vello drop the reference's images first.
        out.resize(&mut doc, w, h);
        for _ in 0..3 {
            out.frame(&mut doc);
        }
        let differing = live
            .chunks(4)
            .zip(want.chunks(4))
            .filter(|(a, b)| a.iter().zip(*b).any(|(x, y)| x.abs_diff(*y) > 2))
            .count();
        assert_eq!(differing, 0, "{w}x{h}: differs from a fresh render");
        // Out of full screen and back, in steps.
        for (sw, sh) in [(w - 300, h - 200), (1440, 900), (w, h)] {
            out.resize(&mut doc, sw, sh);
            set_full(&mut doc, sw == w);
            check(&mut doc, &mut out, &format!("{w}x{h} step {sw}x{sh}"));
        }
    }
    assert!(doc.take_error().is_none());
}

/// Every lab view at the lab window's width (1440 CSS px at scale 2), for
/// comparing against the design file: `view-<name>.png`. The window is
/// made tall enough (900 px or more) for the whole stage to show.
#[test]
#[ignore = "writes offscreen GPU captures; run explicitly"]
fn capture_views() {
    let dir = capture_dir();
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    for view in VIEWS {
        out.resize(&mut doc, 1440, 900);
        open(&mut doc, view);
        // How far the stage scrolls at 900 px is what it is short by.
        scroll_stage(&mut doc, 1e6);
        let short = doc.inner().get_node(stage(&doc)).unwrap().scroll_offset().y;
        scroll_stage(&mut doc, 0.0);
        out.resize(&mut doc, 1440, 900 + short.ceil() as u32);
        out.save_settled(&mut doc, &dir, &format!("view-{view}"));
    }
    assert!(doc.take_error().is_none());
}

/// The select view offscreen (scale 2), with close crops of the bridge
/// below and above a field trigger and of the merged compact form, in
/// `$TK_CAPTURE_DIR/select/`. The bridge's centre is the trigger's fill
/// (no seam: one surface); beside it, in the gap, the background shows.
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
    let (pixels, _, _) = out.frame(&mut doc);
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

/// Views teleport their parts into the shell's fixed regions: switching the
/// view replaces the stage and bottom bar content, the view-specific top
/// bar parts and the title that hangs from the top bar, while the frame stays.
#[test]
fn views_teleport_into_the_shell_regions() {
    let mut doc = document(1.0, 900.0);
    let title = |doc: &NativeDocument| doc.inner().get_element_by_id("lab-chat-title").is_some();
    assert!(title(&doc), "the chat view starts open");
    assert!(doc.inner().get_element_by_id("lab-chat-composer").is_some());
    let stage = stage(&doc);
    open(&mut doc, "buttons");
    assert!(!title(&doc), "the chat title left the top bar");
    assert!(
        doc.inner().get_element_by_id("lab-chat-composer").is_none(),
        "the composer left the bottom bar"
    );
    assert!(support::text(&doc, "lab-buttons").contains("Variants and states"));
    assert_eq!(
        stage,
        self::stage(&doc),
        "the frame's stage is the same element"
    );
    // The chat view's content lives in the stage region, not where the view is.
    let lab = support::id(&doc, "lab-buttons");
    assert!(doc.inner().node_chain(lab).contains(&stage));
    open(&mut doc, "chat");
    assert!(title(&doc));
    assert!(doc.take_error().is_none());
}

// ---------------------------------------------------------------- plates (materials from classes)

/// A pointer event over the centre of element `name`, with `buttons` held.
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
    doc.layout_surfaces();
}

/// The pointer moves over the centre of element `name` (`:hover`).
fn hover(doc: &mut NativeDocument, name: &str) {
    use blitz_traits::events::{MouseEventButtons, UiEvent};
    let event = pointer_at(doc, name, MouseEventButtons::None);
    doc.handle_ui_event(UiEvent::PointerMove(event));
    doc.resolve_layout(0.0);
}

/// The visible stage: the box of the region the scroller fills.
fn stage_box(doc: &NativeDocument) -> blitz_dom::BoundingRect {
    let region = doc.inner().get_node(stage(doc)).unwrap().parent.unwrap();
    doc.inner().get_client_bounding_rect(region).unwrap()
}

/// The stage's materials layer: the `<tk-surface materials>` beside the
/// stage scroller (the shell writes it; views never do).
fn stage_layer(doc: &NativeDocument) -> blitz_traits::NodeId {
    let inner = doc.inner();
    let scroller = inner.get_node(stage(doc)).unwrap();
    inner
        .get_node(scroller.parent.unwrap())
        .unwrap()
        .children
        .iter()
        .copied()
        .find(|&id| {
            let element = inner.get_node(id).unwrap().element_data();
            element.is_some_and(|e| {
                &*e.name.local == "tk-surface"
                    && e.attr(blitz_dom::LocalName::from("materials")).is_some()
            })
        })
        .expect("the stage holds a materials layer")
}

/// The border box Blitz paints element `id` in (window, CSS px): its
/// rounded layout. Plates are placed by it, not by the client rect, which
/// is unrounded and can be half a pixel away.
fn painted_box(doc: &NativeDocument, id: blitz_traits::NodeId) -> [f32; 4] {
    let inner = doc.inner();
    let node = inner.get_node(id).unwrap();
    let at = node.absolute_position(0.0, 0.0);
    let scroll = node.scroll_offset();
    let size = node.final_layout().size;
    [
        at.x + scroll.x as f32,
        at.y + scroll.y as f32,
        size.width,
        size.height,
    ]
}

/// The layer's shape for element `name` (matched by its box).
fn material_shape(
    doc: &NativeDocument,
    layer: blitz_traits::NodeId,
    name: &str,
) -> render::MaterialShape {
    let origin = painted_box(doc, layer);
    let [x, y, w, h] = painted_box(doc, support::id(doc, name));
    let want = [x - origin[0], y - origin[1], w, h];
    doc.surface_shapes(layer)
        .into_iter()
        .find(|s| s.rect.iter().zip(&want).all(|(a, b)| (a - b).abs() < 0.01))
        .unwrap_or_else(|| panic!("{name}: no shape at {want:?}"))
}

/// The layer's shapes that lie inside element `name`'s box, in paint order.
fn shapes_within(
    doc: &NativeDocument,
    layer: blitz_traits::NodeId,
    name: &str,
) -> Vec<render::MaterialShape> {
    let origin = painted_box(doc, layer);
    let [x, y, w, h] = painted_box(doc, support::id(doc, name));
    let (x, y) = (x - origin[0], y - origin[1]);
    doc.surface_shapes(layer)
        .into_iter()
        .filter(|s| {
            let [sx, sy, sw, sh] = s.rect;
            sx >= x - 0.01 && sy >= y - 0.01 && sx + sw <= x + w + 0.01 && sy + sh <= y + h + 0.01
        })
        .collect()
}

fn hex(c: [f32; 4]) -> String {
    let [r, g, b, _] = c.map(|v| (v * 255.0).round() as u8);
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// The two plate painters of the shell regions (render/SURFACES.md,
/// "Plates"): each plate painting itself (how the lab opens), or each
/// region's sheet drawing its plates.
const PAINTERS: [&str; 2] = ["self", "sheet"];

/// Switch every shell region to a painter (`<Shell plates>`, through the
/// lab's test-only host event; the stage keeps its scroll position).
fn painter(doc: &mut NativeDocument, mode: &str) {
    lab_test(doc, serde_json::json!({ "plates": mode }));
    doc.layout_surfaces();
    let stage_region = doc.inner().get_node(stage(doc)).unwrap().parent.unwrap();
    let value = doc
        .inner()
        .get_node(stage_region)
        .unwrap()
        .attr(blitz_dom::LocalName::from("tk-region"))
        .map(str::to_owned);
    assert_eq!(
        value.as_deref(),
        Some(if mode == "sheet" { "sheet" } else { "true" }),
        "the stage region follows the switch"
    );
}

/// True if element `id` carries a widget (a self-painting plate does).
fn carries_widget(doc: &NativeDocument, id: blitz_traits::NodeId) -> bool {
    doc.inner()
        .get_node(id)
        .and_then(|n| n.element_data())
        .is_some_and(|e| e.custom_widget_data().is_some())
}

/// The plate of element `name`, whoever draws it: its own shape (in its own
/// border box) if it paints itself, else its shape in the stage's layer.
fn plate_shape(doc: &NativeDocument, name: &str) -> render::MaterialShape {
    doc.own_plate_shape(support::id(doc, name))
        .unwrap_or_else(|| material_shape(doc, stage_layer(doc), name))
}

/// The elements matching `selector` that paint their own plate.
fn own_plates(doc: &NativeDocument, selector: &str) -> Vec<blitz_traits::NodeId> {
    doc.inner()
        .query_selector_all(selector)
        .unwrap()
        .into_iter()
        .filter(|&id| doc.own_plate_shape(id).is_some())
        .collect()
}

/// Scroll element `id` to offset `y` (any scroll container).
fn scroll_node(doc: &mut NativeDocument, id: blitz_traits::NodeId, y: f64) {
    let current = doc.inner().get_node(id).unwrap().scroll_offset().y;
    doc.inner_mut()
        .scroll_by(id, 0.0, y - current, Default::default());
    doc.resolve_layout(0.0);
    doc.layout_surfaces();
    assert_eq!(doc.inner().get_node(id).unwrap().scroll_offset().y, y);
}

/// Keycaps from CSS, with either painter: every `material-*` element of the
/// keycap case is a plate with its computed fill, bevel, elevation and
/// `border-radius` (from `rounded-*`, no attribute). Self-painting, each
/// carries its own widget and the stage's layer draws none of them; with
/// the sheet, the stage's layer draws them all, outer elements first.
/// Pressed states defined only in CSS change the plate: `active:` while the
/// pointer is down, `aria-pressed:` when a click toggles it,
/// `active:bevel-1` the bevel alone; and the document settles (requests no
/// frames) after each change.
#[test]
fn plates_follow_computed_style_and_pressed_states() {
    for mode in PAINTERS {
        let mut doc = document(1.0, 900.0);
        open(&mut doc, "surfaces");
        painter(&mut doc, mode);
        scroll_to(&mut doc, "lab-keycaps");
        doc.layout_surfaces();
        let layer = stage_layer(&doc);
        let shapes = shapes_within(&doc, layer, "lab-keycaps");
        let own = own_plates(&doc, "#lab-keycaps [tk-plate]");
        let tray = if mode == "sheet" {
            // 4 trays (one per row, two in the shortcut row), then their
            // 3 + 4 + 4 caps.
            assert_eq!(shapes.len(), 4 + 11, "{shapes:#?}");
            assert!(own.is_empty(), "{own:?}");
            // Outer elements first: the (recessed) trays paint below the
            // caps they hold.
            assert!(
                shapes[..4].iter().all(|s| s.recessed),
                "trays first: {shapes:#?}"
            );
            shapes[0].clone()
        } else {
            // The same 15; the stage's layer draws none of them.
            assert_eq!(own.len(), 4 + 11);
            assert!(shapes.is_empty(), "{mode}: {shapes:#?}");
            assert!(own.iter().all(|&id| carries_widget(&doc, id)));
            let deny = support::id(&doc, "lab-key-deny");
            let tray = doc.inner().get_node(deny).unwrap().parent.unwrap();
            doc.own_plate_shape(tray).unwrap()
        };
        assert_eq!(tray.radii, [10.0; 4], "rounded-[10px] from computed style");
        assert_eq!(hex(tray.fill.unwrap()), "#080808");
        assert_eq!((tray.bevel, tray.recessed), (Some(1.0), true));

        // The build marked the caps (static `material-*` classes).
        for cap in ["lab-key-deny", "lab-key-always", "lab-key-once"] {
            assert!(support::attr(&doc, cap, "tk-plate").is_some(), "{cap}");
            assert_eq!(
                carries_widget(&doc, support::id(&doc, cap)),
                mode == "self",
                "{mode}: {cap}"
            );
        }
        let deny = plate_shape(&doc, "lab-key-deny");
        assert_eq!(deny.radii, [7.0; 4]);
        assert_eq!(hex(deny.fill.unwrap()), "#2a2a2a");
        assert_eq!((deny.bevel, deny.recessed), (Some(1.5), false));
        if mode == "self" {
            let size = doc
                .inner()
                .get_client_bounding_rect(support::id(&doc, "lab-key-deny"))
                .unwrap();
            assert_eq!(
                deny.rect,
                [0.0, 0.0, size.width as f32, size.height as f32],
                "its own border box"
            );
        }
        assert!(!doc.inner().is_animating());

        // `active:material-key-pressed`, CSS only (no JS state): down, up.
        pointer_half(&mut doc, "lab-key-deny", false);
        let down = plate_shape(&doc, "lab-key-deny");
        assert_eq!(hex(down.fill.unwrap()), "#252525", "pressed while :active");
        // Pressed does not invert: the band gets thinner and stays raised.
        assert_eq!((down.bevel, down.recessed), (Some(1.0), false));
        assert!(
            !doc.inner().is_animating(),
            "a state change needs one frame"
        );
        pointer_half(&mut doc, "lab-key-deny", true);
        assert_eq!(plate_shape(&doc, "lab-key-deny"), deny, "released");

        // `active:bevel-[0.75]`: only the bevel changes.
        pointer_half(&mut doc, "lab-key-once", false);
        let once = plate_shape(&doc, "lab-key-once");
        assert_eq!((once.bevel, once.recessed), (Some(0.75), false));
        assert_eq!(hex(once.fill.unwrap()), "#e8e8ea");
        pointer_half(&mut doc, "lab-key-once", true);
        assert_eq!(plate_shape(&doc, "lab-key-once").bevel, Some(1.5));

        // `aria-pressed:material-key-pressed`: a click toggles the attribute.
        pointer_half(&mut doc, "lab-key-always", false);
        pointer_half(&mut doc, "lab-key-always", true);
        assert_eq!(
            support::attr(&doc, "lab-key-always", "aria-pressed").as_deref(),
            Some("true"),
            "{mode}: the click reached the button"
        );
        let toggled = plate_shape(&doc, "lab-key-always");
        assert_eq!((toggled.bevel, toggled.recessed), (Some(1.0), false));
        assert!(!doc.inner().is_animating());
        // Shortcut keys and tiles are buttons too: a key sinks while held,
        // and a click selects a tile (the selected one stays down).
        pointer_half(&mut doc, "lab-key-cmd", false);
        assert_eq!(plate_shape(&doc, "lab-key-cmd").bevel, Some(1.0));
        pointer_half(&mut doc, "lab-key-cmd", true);
        assert_eq!(plate_shape(&doc, "lab-key-cmd").bevel, Some(1.5));
        assert_eq!(plate_shape(&doc, "lab-key-tile-chat").bevel, Some(1.0));
        pointer_half(&mut doc, "lab-key-tile-code", false);
        pointer_half(&mut doc, "lab-key-tile-code", true);
        assert_eq!(plate_shape(&doc, "lab-key-tile-code").bevel, Some(1.0));
        assert!(!plate_shape(&doc, "lab-key-tile-chat").recessed);
        assert!(!doc.inner().is_animating());
        assert!(doc.take_error().is_none());
    }
}

/// A self-painting plate is a widget on the `<button>` itself, and the
/// button stays a real button: same box and same text layout as with the
/// sheet; pointer down focuses it as it does a button without a widget; a
/// click reaches its JS handler; Enter clicks it when focused; a wheel over
/// it scrolls the stage; and scrolling leaves its shape alone (it is in the
/// button's own box). Switching the painter takes the widget off again.
#[test]
fn a_self_painting_button_is_still_a_real_button() {
    let mut doc = document(1.0, 520.0); // short enough that the Surfaces page scrolls
    open(&mut doc, "surfaces");
    scroll_to(&mut doc, "lab-keycaps");
    doc.layout_surfaces();
    let deny = support::id(&doc, "lab-key-deny");
    let always = support::id(&doc, "lab-key-always");
    // The button's box, and its text: a flex button lays its text out in an
    // anonymous block (its one layout child).
    let layout = |doc: &NativeDocument, id: blitz_traits::NodeId| {
        let inner = doc.inner();
        let node = inner.get_node(id).unwrap();
        let size = node.final_layout().size;
        let block = node.layout_children.borrow().as_ref().unwrap()[0];
        let block = inner.get_node(block).unwrap();
        let text = block
            .element_data()
            .unwrap()
            .inline_layout_data
            .as_ref()
            .unwrap();
        let place = block.final_layout();
        (
            (size.width, size.height),
            text.text.trim().to_string(),
            text.layout.width(),
            (place.location.x, place.location.y, place.size.height),
        )
    };
    assert!(carries_widget(&doc, deny), "the button carries its plate");
    let own = layout(&doc, deny);
    assert_eq!(own.1, "Deny");
    assert!(own.2 > 10.0 && own.3.0 + own.2 < own.0.0, "text inside");

    // Pointer down: `:active` presses the plate and the button takes focus.
    pointer_half(&mut doc, "lab-key-deny", false);
    let focus_own = doc.inner().get_focussed_node_id() == Some(deny);
    assert_eq!(
        plate_shape(&doc, "lab-key-deny").bevel,
        Some(1.0),
        ":active presses the plate"
    );
    pointer_half(&mut doc, "lab-key-deny", true);
    // A click reaches the JS handler, and Enter clicks the focused button.
    pointer_half(&mut doc, "lab-key-always", false);
    pointer_half(&mut doc, "lab-key-always", true);
    assert_eq!(
        support::attr(&doc, "lab-key-always", "aria-pressed").as_deref(),
        Some("true"),
        "click reached the button"
    );
    doc.inner_mut().set_focus_to(always);
    support::key(&mut doc, "Enter", false, false);
    support::key(&mut doc, "Enter", true, false);
    doc.resolve_layout(0.0);
    doc.layout_surfaces();
    assert_eq!(
        support::attr(&doc, "lab-key-always", "aria-pressed").as_deref(),
        Some("false"),
        "Enter clicked the focused button"
    );
    assert!(!plate_shape(&doc, "lab-key-always").recessed);

    // A wheel over the plate scrolls the stage (up: the keycaps are near
    // the end of the page); the plate's shape does not change with
    // scrolling.
    let before = plate_shape(&doc, "lab-key-deny");
    {
        use blitz_traits::events::*;
        let offset = doc.inner().get_node(stage(&doc)).unwrap().scroll_offset().y;
        let event = pointer_at(&mut doc, "lab-key-deny", MouseEventButtons::None);
        doc.handle_ui_event(UiEvent::PointerMove(event.clone()));
        doc.handle_ui_event(UiEvent::Wheel(BlitzWheelEvent {
            delta: BlitzWheelDelta::Pixels(0.0, 40.0),
            coords: event.coords,
            buttons: MouseEventButtons::None,
            mods: keyboard_types::Modifiers::empty(),
            element: Default::default(),
        }));
        let now = doc.inner().get_node(stage(&doc)).unwrap().scroll_offset().y;
        assert_ne!(now, offset, "the stage scrolled");
    }
    doc.resolve_layout(0.0);
    doc.layout_surfaces();
    assert_eq!(plate_shape(&doc, "lab-key-deny"), before);
    assert!(!doc.inner().is_animating(), "settled: no frames requested");

    // The sheet: no widget, same layout, same focus behaviour.
    painter(&mut doc, "sheet");
    assert!(!carries_widget(&doc, deny), "the sheet draws it now");
    assert_eq!(layout(&doc, deny), own, "same box and text either way");
    pointer_half(&mut doc, "lab-key-deny", false);
    assert_eq!(
        doc.inner().get_focussed_node_id() == Some(deny),
        focus_own,
        "focus as a button without a widget"
    );
    pointer_half(&mut doc, "lab-key-deny", true);
    // And back: the widget is attached again.
    painter(&mut doc, "self");
    assert!(carries_widget(&doc, deny));
    assert_eq!(plate_shape(&doc, "lab-key-deny"), before);
    assert!(doc.take_error().is_none());
}

/// Plates on elements that cannot carry a widget (a text field, whose
/// element holds the text editor, and an inline highlight, which has no box
/// of its own), inside a card. Self-painting, the card draws them as its
/// guests, over its own fill (the stage's layer would be under the card);
/// with the sheet, the stage's layer draws all three, the card first. The
/// field stays a text field either way.
#[test]
fn a_field_on_a_card_keeps_its_plate() {
    for mode in PAINTERS {
        let mut doc = document(1.0, 900.0);
        open(&mut doc, "surfaces");
        painter(&mut doc, mode);
        scroll_to(&mut doc, "lab-field-case");
        doc.layout_surfaces();
        let (card, field, inline) = (
            support::id(&doc, "lab-field-card"),
            support::id(&doc, "lab-field"),
            support::id(&doc, "lab-field-inline"),
        );
        for id in [card, field, inline] {
            let node = doc.inner();
            let element = node.get_node(id).unwrap().element_data().unwrap();
            assert!(
                element
                    .attr(blitz_dom::LocalName::from("tk-plate"))
                    .is_some()
            );
        }
        assert!(!carries_widget(&doc, field) && !carries_widget(&doc, inline));
        assert!(
            doc.inner()
                .get_node(field)
                .unwrap()
                .element_data()
                .unwrap()
                .text_input_data()
                .is_some(),
            "{mode}: still a text field"
        );
        let layer = stage_layer(&doc);
        let in_layer = shapes_within(&doc, layer, "lab-field-case");
        let (well, mark) = if mode == "self" {
            assert!(carries_widget(&doc, card));
            assert!(in_layer.is_empty(), "{in_layer:#?}");
            assert_eq!(
                hex(doc.own_plate_shape(card).unwrap().fill.unwrap()),
                "#252525"
            );
            let (host, well) = doc.hosted_plate_shape(field).expect("drawn by the card");
            assert_eq!(host, card);
            // In the card's border box.
            let (at, of) = (painted_box(&doc, field), painted_box(&doc, card));
            assert_eq!(well.rect, [at[0] - of[0], at[1] - of[1], at[2], at[3]]);
            let (host, mark) = doc.hosted_plate_shape(inline).expect("drawn by the card");
            assert_eq!(host, card);
            (well, mark)
        } else {
            assert!(!carries_widget(&doc, card));
            assert_eq!(in_layer.len(), 3, "{in_layer:#?}");
            assert_eq!(hex(in_layer[0].fill.unwrap()), "#252525", "the card, first");
            assert!(doc.hosted_plate_shape(field).is_none());
            (in_layer[1].clone(), in_layer[2].clone())
        };
        assert_eq!(hex(well.fill.unwrap()), "#151515", "material-well");
        assert_eq!(
            (well.bevel, well.recessed, well.radii),
            (Some(1.0), true, [6.0; 4])
        );
        assert!(near(mark.fill.unwrap(), "#155dfc"), "blue-600: {mark:?}");
        assert!(!doc.inner().is_animating());
        assert!(doc.take_error().is_none());
    }
}

/// A plate leaves the document and comes back (a view switch and back):
/// Blitz drops a widget with its element, so the layout pass attaches a new
/// one when the element returns, and stops tracking plates that are gone.
/// A plate scrolled out of the window keeps its widget but is handed no
/// shape (Blitz calls every widget's paint on every frame, in view or not),
/// and gets it back when it scrolls in. (A short window, so the stage
/// scrolls far enough.)
#[test]
fn self_painting_plates_survive_leaving_and_returning() {
    let mut doc = document(1.0, 520.0);
    open(&mut doc, "surfaces");
    scroll_to(&mut doc, "lab-keycaps");
    doc.layout_surfaces();
    let count = doc.own_plate_count();
    assert!(count > 10, "the Surfaces view's plates in view: {count}");
    {
        let deny = support::id(&doc, "lab-key-deny");
        let shape = doc.own_plate_shape(deny).unwrap();
        let offset = doc.inner().get_node(stage(&doc)).unwrap().scroll_offset().y;
        let rect = doc.inner().get_client_bounding_rect(deny).unwrap();
        scroll_stage(&mut doc, offset + rect.y + rect.height + 40.0);
        doc.layout_surfaces();
        let rect = doc.inner().get_client_bounding_rect(deny).unwrap();
        assert!(rect.y + rect.height < 0.0, "scrolled out: {rect:?}");
        assert!(carries_widget(&doc, deny));
        assert!(doc.own_plate_shape(deny).is_none(), "nothing to draw");
        assert!(doc.own_plate_count() < count);
        scroll_stage(&mut doc, offset);
        doc.layout_surfaces();
        assert_eq!(doc.own_plate_shape(deny), Some(shape));
        assert_eq!(doc.own_plate_count(), count);
    }
    open(&mut doc, "chat");
    doc.layout_surfaces();
    let elsewhere = doc.own_plate_count();
    assert!(elsewhere < count, "{elsewhere} of {count} left");
    open(&mut doc, "surfaces");
    scroll_to(&mut doc, "lab-keycaps");
    doc.layout_surfaces();
    assert_eq!(doc.own_plate_count(), count);
    for name in ["lab-key-deny", "lab-key-tile-chat", "lab-field-card"] {
        assert!(carries_widget(&doc, support::id(&doc, name)), "{name}");
        assert!(doc.own_plate_shape(support::id(&doc, name)).is_some());
    }
    assert!(!doc.inner().is_animating());
    assert!(doc.take_error().is_none());
}

/// With the sheet as the painter, the stage's materials layer stays over
/// the visible stage while its content scrolls: a plate is drawn where it is
/// on screen, reaches past the stage's top edge while it scrolls out (its
/// texture ends at the stage edge, which clips it) and is dropped once it is
/// out of view. (A self-painting plate is drawn in its own box and clipped
/// by Blitz with its element: `scrolled_plates_are_clipped_at_the_stage_edge`.)
#[test]
fn stage_plates_follow_scrolling_and_leave_at_the_stage_edge() {
    // A short window, so the stage scrolls the cap past its top edge.
    let mut doc = document(1.0, 520.0);
    open(&mut doc, "surfaces");
    painter(&mut doc, "sheet");
    scroll_to(&mut doc, "lab-keycaps");
    doc.layout_surfaces();
    let layer = stage_layer(&doc);
    let rect = |doc: &NativeDocument, id| doc.inner().get_client_bounding_rect(id).unwrap();
    // (The scroller's own client rect moves with its scroll offset in
    // Blitz; the region it fills does not.)
    let (visible, cover) = (stage_box(&doc), rect(&doc, layer));
    assert_eq!(
        (cover.x, cover.y, cover.width, cover.height),
        (visible.x, visible.y, visible.width, visible.height),
        "the layer covers the visible stage, not the scrolled content"
    );
    let offset = |doc: &NativeDocument| doc.inner().get_node(stage(doc)).unwrap().scroll_offset().y;
    // The cap 100 px below the stage's top edge.
    let cap = support::id(&doc, "lab-key-deny");
    let y = offset(&doc) + rect(&doc, cap).y - cover.y - 100.0;
    scroll_stage(&mut doc, y);
    doc.layout_surfaces();
    let before = material_shape(&doc, layer, "lab-key-deny");
    assert_eq!(before.rect[1], 100.0);
    let y = offset(&doc) + 50.0;
    scroll_stage(&mut doc, y);
    doc.layout_surfaces();
    let after = material_shape(&doc, layer, "lab-key-deny");
    assert_eq!(
        after.rect[1],
        before.rect[1] - 50.0,
        "drawn where it is now"
    );
    assert_eq!(after.rect[0], before.rect[0]);

    // Half out over the top edge: still drawn, reaching above the layer.
    let top = rect(&doc, cap).y - cover.y;
    let y = offset(&doc) + top + 10.0;
    scroll_stage(&mut doc, y);
    doc.layout_surfaces();
    let edge = material_shape(&doc, layer, "lab-key-deny");
    assert!(
        edge.rect[1] < 0.0 && edge.rect[1] + edge.rect[3] > 0.0,
        "{edge:?}"
    );
    // Out of view: no shape above the layer any more.
    let y = offset(&doc) + 200.0;
    scroll_stage(&mut doc, y);
    doc.layout_surfaces();
    let shapes = doc.surface_shapes(layer);
    assert!(
        shapes.iter().all(|s| s.rect[1] + s.rect[3] > 0.0),
        "{shapes:#?}"
    );
    assert!(!doc.inner().is_animating());
    assert!(doc.take_error().is_none());
}

/// As pixels, with either painter: with a cap scrolled half over the
/// stage's top edge, nothing of it shows above the edge (the top bar is
/// identical to a frame with no plate near it) and its lower half shows
/// below the edge.
#[test]
#[ignore = "offscreen GPU frames; run explicitly"]
fn scrolled_plates_are_clipped_at_the_stage_edge() {
    let scale = 2.0;
    // One document and one renderer for both painters (the surfaces' GPU
    // state is per thread and device). A short window, so the stage
    // scrolls the cap past its top edge.
    let mut doc = document(scale, 900.0);
    let mut out = Offscreen::new(scale);
    out.resize(&mut doc, 1440, 520);
    open(&mut doc, "surfaces");
    for mode in PAINTERS {
        painter(&mut doc, mode);
        scroll_stage(&mut doc, 0.0);
        let at = |px: &[u8], width: u32, x: f64, y: f64| {
            let i = (((y * scale as f64) as u32 * width + (x * scale as f64) as u32) * 4) as usize;
            [px[i], px[i + 1], px[i + 2]]
        };
        let settled = |doc: &mut NativeDocument, out: &mut Offscreen| {
            let mut px = out.frame(doc).0;
            for _ in 0..10 {
                if !doc.inner().is_animating() {
                    break;
                }
                px = out.frame(doc).0;
            }
            px
        };
        let scroller = stage_box(&doc);
        // Reference: scrolled to the top, no plate near the stage's top edge.
        let reference = settled(&mut doc, &mut out);
        let cap = support::id(&doc, "lab-key-deny");
        let r = doc.inner().get_client_bounding_rect(cap).unwrap();
        scroll_stage(&mut doc, r.y - scroller.y + r.height / 2.0);
        let r = doc.inner().get_client_bounding_rect(cap).unwrap();
        assert!(r.y < scroller.y && r.y + r.height > scroller.y + 4.0);
        let px = settled(&mut doc, &mut out);
        // Everything above the stage (the top bar) is unchanged, device row
        // by row.
        let row = (out.width * 4) as usize;
        let above = (scroller.y * scale as f64) as usize;
        assert!(
            px[..above * row] == reference[..above * row],
            "{mode}: a scrolled plate showed above the stage edge"
        );
        // Below the edge, inside the cap: its face (#2a2a2a), not the panel.
        let face = at(&px, out.width, r.x + 6.0, scroller.y + 4.0);
        assert_eq!(face, [0x2a; 3], "{mode}: the cap's visible half is drawn");
        assert!(doc.take_error().is_none());
    }
}

/// A `Sheet` is a region of its own, with its own painter. The menu (the
/// default): the sheet and its selected item paint themselves, a hovered
/// item gets its `hover:` material, and neither its layer nor the stage's
/// draws any of them. A `plates="sheet"` one (the z-index comparison cell):
/// its own layer draws it and its plates, outer first, then in document
/// order, whatever the shell regions use; none of them carries a widget.
#[test]
fn a_sheet_is_a_region_with_its_own_painter() {
    for mode in PAINTERS {
        let mut doc = document(1.0, 900.0);
        open(&mut doc, "fixtures");
        painter(&mut doc, mode);
        scroll_to(&mut doc, "lab-sheet-menu");
        doc.layout_surfaces();
        let layer_of = |doc: &NativeDocument, name: &str| {
            doc.inner()
                .query_selector(&format!("#{name} > tk-surface[materials]"))
                .unwrap()
                .expect("the sheet holds a layer")
        };
        let in_stage_layer = |doc: &NativeDocument, name: &str| {
            let stage = stage_layer(doc);
            let origin = doc.inner().get_client_bounding_rect(stage).unwrap();
            let at = doc
                .inner()
                .get_client_bounding_rect(support::id(doc, name))
                .unwrap();
            doc.surface_shapes(stage).iter().any(|s| {
                (f64::from(s.rect[0]) + origin.x - at.x).abs() < 0.5
                    && (f64::from(s.rect[1]) + origin.y - at.y).abs() < 0.5
            })
        };
        // The menu: self-painting.
        let menu = support::id(&doc, "lab-sheet-menu");
        assert_eq!(
            hex(doc.own_plate_shape(menu).unwrap().fill.unwrap()),
            "#252525"
        );
        assert_eq!(
            hex(plate_shape(&doc, "lab-sheet-item-0").fill.unwrap()),
            "#2a2a2a"
        );
        let last = support::id(&doc, "lab-sheet-item-2");
        assert!(doc.own_plate_shape(last).is_none(), "no fill until hovered");
        assert!(
            doc.surface_shapes(layer_of(&doc, "lab-sheet-menu"))
                .is_empty()
        );
        assert!(!in_stage_layer(&doc, "lab-sheet-menu"), "{mode}");
        hover(&mut doc, "lab-sheet-item-2");
        doc.layout_surfaces();
        assert_eq!(
            hex(doc.own_plate_shape(last).unwrap().fill.unwrap()),
            "#2a2a2a",
            "hover:material-chip"
        );

        // The `plates="sheet"` cell: its own layer draws everything in it.
        scroll_to(&mut doc, "lab-mode-z-sheet");
        doc.layout_surfaces();
        let layer = layer_of(&doc, "lab-mode-z-sheet");
        let shapes = doc.surface_shapes(layer);
        assert_eq!(shapes.len(), 3, "the cell and its two plates: {shapes:#?}");
        assert_eq!(shapes[0].rect[..2], [0.0, 0.0], "the cell itself, first");
        assert_eq!(hex(shapes[0].fill.unwrap()), "#080808");
        assert_eq!(
            shapes[1],
            material_shape(&doc, layer, "lab-mode-z-sheet-front")
        );
        assert_eq!(
            shapes[2],
            material_shape(&doc, layer, "lab-mode-z-sheet-back")
        );
        for name in [
            "lab-mode-z-sheet",
            "lab-mode-z-sheet-front",
            "lab-mode-z-sheet-back",
        ] {
            assert!(!carries_widget(&doc, support::id(&doc, name)), "{name}");
            assert!(!in_stage_layer(&doc, name), "{mode}: {name}");
        }
        // Its neighbour paints itself: nothing in its layer.
        assert!(
            doc.surface_shapes(layer_of(&doc, "lab-mode-z-self"))
                .is_empty()
        );
        for name in [
            "lab-mode-z-self",
            "lab-mode-z-self-front",
            "lab-mode-z-self-back",
        ] {
            assert!(carries_widget(&doc, support::id(&doc, name)), "{name}");
        }
        assert!(!doc.inner().is_animating());
        assert!(doc.take_error().is_none());
    }
}

/// True if `c` is within 2/255 of `#rrggbb` per channel.
fn near(c: [f32; 4], want: &str) -> bool {
    let w = u32::from_str_radix(want.trim_start_matches('#'), 16).unwrap();
    let w = [(w >> 16) & 255, (w >> 8) & 255, w & 255].map(|v| v as f32 / 255.0);
    c.iter().zip(w).all(|(a, b)| (a - b).abs() <= 2.0 / 255.0)
}

/// The ordering case: a cap inside a box with a plain `bg-[#3a2420]`. The
/// box is a plate too (the build marked it), flat (no `bevel-*`), and Blitz
/// paints no background for it. With the sheet it is drawn first in the
/// same layer, so the caps it holds paint over it; self-painting, the box
/// and each cap draw themselves, the box first because it is the parent
/// (pixels: `the_ordering_case_draws_the_cap_on_the_box`).
#[test]
fn a_plain_background_is_a_plate_under_the_plates_it_holds() {
    for mode in PAINTERS {
        let mut doc = document(1.0, 900.0);
        open(&mut doc, "fixtures");
        painter(&mut doc, mode);
        scroll_to(&mut doc, "lab-plates-order");
        doc.layout_surfaces();
        let layer = stage_layer(&doc);
        assert!(support::attr(&doc, "lab-plates-order", "tk-plate").is_some());
        let shapes = shapes_within(&doc, layer, "lab-plates-order");
        let own = own_plates(&doc, "#lab-plates-order, #lab-plates-order [tk-plate]");
        if mode == "sheet" {
            assert_eq!(shapes.len(), 3, "the box and its two caps: {shapes:#?}");
            assert_eq!(
                shapes[0],
                plate_shape(&doc, "lab-plates-order"),
                "the box, first"
            );
            assert_eq!(shapes[1], plate_shape(&doc, "lab-order-deny"));
        } else {
            assert!(shapes.is_empty(), "{shapes:#?}");
            assert_eq!(own.len(), 3, "the box and its two caps");
        }
        let bx = plate_shape(&doc, "lab-plates-order");
        assert_eq!(hex(bx.fill.unwrap()), "#3a2420");
        assert_eq!(
            (bx.bevel, bx.recessed, bx.radii),
            (Some(0.0), false, [12.0; 4])
        );
        assert_eq!(
            hex(plate_shape(&doc, "lab-order-deny").fill.unwrap()),
            "#2a2a2a"
        );
        assert!(!doc.inner().is_animating());
        assert!(doc.take_error().is_none());
    }
}

/// `bg-* bevel-* rounded-*` buttons are plates in their own colour: theme
/// colours (oklch in Tailwind's palette) and an opacity form (`bg-white/10`,
/// alpha kept), the bevel from `bevel-2`, the radius from `rounded-md`.
/// `hover:`, `active:` and `aria-pressed:` variants change colour and
/// elevation through CSS alone, and the document settles after each.
#[test]
fn background_buttons_are_plates_with_css_states() {
    for mode in PAINTERS {
        let mut doc = document(1.0, 900.0);
        open(&mut doc, "fixtures");
        painter(&mut doc, mode);
        scroll_to(&mut doc, "lab-bg-row");
        doc.layout_surfaces();
        for name in ["blue", "green", "rose", "ghost"] {
            let id = format!("lab-bg-{name}");
            assert!(support::attr(&doc, &id, "tk-plate").is_some(), "{id}");
            assert_eq!(
                carries_widget(&doc, support::id(&doc, &id)),
                mode == "self",
                "{mode}: {id}"
            );
        }
        let shape = |doc: &NativeDocument, name: &str| plate_shape(doc, &format!("lab-bg-{name}"));
        let blue = shape(&doc, "blue");
        assert!(near(blue.fill.unwrap(), "#155dfc"), "blue-600: {blue:?}");
        assert_eq!(
            (blue.bevel, blue.recessed, blue.radii),
            (Some(1.5), false, [8.0; 4])
        );
        assert!(near(shape(&doc, "green").fill.unwrap(), "#009966"));
        assert!(near(shape(&doc, "rose").fill.unwrap(), "#ec003f"));
        let ghost = shape(&doc, "ghost").fill.unwrap();
        assert!(
            near(ghost, "#ffffff") && (ghost[3] - 0.1).abs() < 0.01,
            "white/10: {ghost:?}"
        );

        hover(&mut doc, "lab-bg-blue");
        doc.layout_surfaces();
        assert!(
            near(shape(&doc, "blue").fill.unwrap(), "#2b7fff"),
            "{mode}: hover: blue-500"
        );
        pointer_half(&mut doc, "lab-bg-blue", false);
        let down = shape(&doc, "blue");
        assert!(near(down.fill.unwrap(), "#1447e6"), "active: blue-700");
        // Pressed does not invert: a thinner band, still raised.
        assert_eq!((down.bevel, down.recessed), (Some(0.75), false), "active");
        assert!(
            !doc.inner().is_animating(),
            "a state change needs one frame"
        );
        pointer_half(&mut doc, "lab-bg-blue", true);
        // Clicked: it stays down (aria-pressed) until another one is picked.
        assert_eq!(
            shape(&doc, "blue").bevel,
            Some(0.75),
            "{mode}: the click arrived"
        );
        pointer_half(&mut doc, "lab-bg-green", false);
        pointer_half(&mut doc, "lab-bg-green", true);
        assert_eq!(shape(&doc, "green").bevel, Some(0.75));
        assert_eq!(shape(&doc, "blue").bevel, Some(1.5));
        assert!(near(shape(&doc, "blue").fill.unwrap(), "#155dfc"));
        assert!(!doc.inner().is_animating());
        assert!(doc.take_error().is_none());
    }
}

/// The ordering case as pixels, with either painter: the cap shows on the
/// coloured box. Before backgrounds became plates, Blitz painted the box
/// over the stage's layer and only the cap's label was left.
#[test]
#[ignore = "offscreen GPU frames; run explicitly"]
fn the_ordering_case_draws_the_cap_on_the_box() {
    let scale = 2.0;
    let mut doc = document(scale, 900.0);
    let mut out = Offscreen::new(scale);
    open(&mut doc, "fixtures");
    for mode in PAINTERS {
        painter(&mut doc, mode);
        scroll_to(&mut doc, "lab-plates-order");
        out.frame(&mut doc);
        let px = out.frame(&mut doc).0;
        let at = |x: f64, y: f64| {
            let i =
                (((y * scale as f64) as u32 * out.width + (x * scale as f64) as u32) * 4) as usize;
            [px[i], px[i + 1], px[i + 2]]
        };
        let rect = |name: &str| {
            doc.inner()
                .get_client_bounding_rect(support::id(&doc, name))
                .unwrap()
        };
        let (bx, cap) = (rect("lab-plates-order"), rect("lab-order-deny"));
        assert_eq!(
            at(bx.x + 4.0, bx.y + bx.height / 2.0),
            [0x3a, 0x24, 0x20],
            "{mode}: the box"
        );
        // Inside the cap, left of its label and clear of its bevel band.
        assert_eq!(
            at(cap.x + 6.0, cap.y + cap.height / 2.0),
            [0x2a; 3],
            "{mode}: the cap's face, on the box"
        );
        assert!(doc.take_error().is_none());
    }
}

// ---------------------------------------------------------------- the select's fused menu

/// The `<tk-surface>` of the `Surface` element `name`.
fn surface_of(doc: &NativeDocument, name: &str) -> blitz_traits::NodeId {
    let inner = doc.inner();
    let root = inner.get_node(support::id(doc, name)).unwrap();
    root.children
        .iter()
        .copied()
        .find(|&id| {
            inner.get_node(id).unwrap().element_data().is_some_and(|e| {
                &*e.name.local == "tk-surface"
                    && e.attr(blitz_dom::LocalName::from("group")).is_some()
            })
        })
        .expect("a Surface holds its tk-surface")
}

/// True if element `id` is moved by a CSS `translate` (`sink-*`, `pressed`).
fn translated(doc: &NativeDocument, id: blitz_traits::NodeId) -> bool {
    let inner = doc.inner();
    let style = inner.get_node(id).unwrap().primary_styles().unwrap();
    format!("{:?}", style.clone_translate()) != "None"
}

/// Element `name`'s painted box relative to `origin`'s.
fn local_box(doc: &NativeDocument, origin: blitz_traits::NodeId, name: &str) -> [f32; 4] {
    let o = painted_box(doc, origin);
    let [x, y, w, h] = painted_box(doc, support::id(doc, name));
    [x - o[0], y - o[1], w, h]
}

fn near_box(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(&b).all(|(x, y)| (x - y).abs() < 0.01)
}

/// Closed, the field trigger is a flat plate that never moves: on hover
/// its fill lifts a step (the plate keeps its shape, nothing is
/// translated), pressed it darkens in place. Open, hover and press change
/// nothing: the trigger's own plate is off (the fused surface draws it).
#[test]
fn the_select_trigger_keeps_its_box_on_hover() {
    let mut doc = document(1.0, 900.0);
    open(&mut doc, "select");
    doc.layout_surfaces();
    let trigger = "lab-select-field";
    let id = support::id(&doc, trigger);
    let before = (painted_box(&doc, id), plate_shape(&doc, trigger));
    hover(&mut doc, trigger);
    doc.layout_surfaces();
    let after = (painted_box(&doc, id), plate_shape(&doc, trigger));
    assert_eq!(before.0, after.0, "the box stays");
    assert_eq!(
        before.1.rect, after.1.rect,
        "the plate keeps its shape (no dip)"
    );
    assert_ne!(before.1.fill, after.1.fill, "the fill lifts a step");
    assert_eq!(hex(after.1.fill.unwrap()), "#313131", "lift");
    assert!(!translated(&doc, id), "nothing moves on hover");
    // Pressed (closed): a flat plate, it darkens and stays where it is.
    pointer_half(&mut doc, trigger, false);
    doc.layout_surfaces();
    assert!(!translated(&doc, id), "nothing moves while pressed");
    assert_eq!(
        painted_box(&doc, id),
        before.0,
        "the box stays while pressed"
    );
    pointer_half(&mut doc, trigger, true);
    // Now open: no plate of its own (the fused surface draws the trigger);
    // hover and press move nothing.
    assert_eq!(
        support::attr(&doc, trigger, "aria-expanded").as_deref(),
        Some("true")
    );
    doc.layout_surfaces();
    assert!(
        doc.own_plate_shape(id)
            .is_none_or(|s| s.fill.is_none_or(|f| f[3] == 0.0)),
        "no plate of its own while open"
    );
    let open_box = painted_box(&doc, id);
    hover(&mut doc, trigger);
    pointer_half(&mut doc, trigger, false);
    assert_eq!(painted_box(&doc, id), open_box);
    assert!(!translated(&doc, id), "no press while open");
    pointer_half(&mut doc, trigger, true);
    assert!(doc.take_error().is_none());
}

/// Open, trigger, bridge and menu are one fused group (one `<tk-surface>`
/// with three union shapes): the menu 6 px from the trigger, the bridge
/// filling the gap, 80% as wide as the narrower plate, centred on the
/// trigger, joined with 3 px fillets. Below and above alike.
#[test]
fn an_open_select_is_one_fused_group() {
    let mut doc = document(1.0, 900.0);
    open(&mut doc, "select");
    doc.layout_surfaces();
    for (name, below) in [("lab-select-open", true), ("lab-select-up", false)] {
        let surface = surface_of(&doc, &format!("{name}-fused"));
        let shapes = doc.surface_shapes(surface);
        assert_eq!(shapes.len(), 3, "{name}: trigger, bridge and menu");
        let face = local_box(&doc, surface, &format!("{name}-face"));
        let bridge = local_box(&doc, surface, &format!("{name}-bridge"));
        let menu = local_box(&doc, surface, &format!("{name}-menu"));
        let trigger = local_box(&doc, surface, name);
        assert!(
            near_box(face, trigger),
            "{name}: the face is the trigger's box: {face:?} {trigger:?}"
        );
        for (what, b) in [("face", face), ("bridge", bridge), ("menu", menu)] {
            assert!(
                shapes.iter().any(|s| near_box(s.rect, b)),
                "{name}: {what} {b:?} in {shapes:?}"
            );
        }
        let narrower = trigger[2].min(menu[2]);
        assert!(
            (bridge[2] - 0.8 * narrower).abs() < 0.01,
            "{name}: 80% wide: {bridge:?}"
        );
        let centre = |b: [f32; 4]| b[0] + b[2] / 2.0;
        assert!(
            (centre(bridge) - centre(trigger)).abs() < 0.01,
            "{name}: centred"
        );
        assert_eq!(bridge[3], 6.0, "{name}: spans the gap");
        if below {
            assert_eq!(bridge[1], trigger[1] + trigger[3]);
            assert_eq!(menu[1], bridge[1] + 6.0);
        } else {
            assert_eq!(bridge[1] + 6.0, trigger[1]);
            assert_eq!(menu[1] + menu[3], bridge[1]);
        }
        // One material (the surface's: chip), joined with 3 px fillets.
        assert_eq!(
            support::attr(&doc, &format!("{name}-fused"), "id")
                .map(|_| {
                    let inner = doc.inner();
                    let node = inner.get_node(surface).unwrap();
                    node.attr(blitz_dom::LocalName::from("fill"))
                        .map(str::to_owned)
                })
                .flatten()
                .as_deref(),
            Some("var(--color-chip)"),
            "{name}: chip"
        );
        let join = support::attr(&doc, &format!("{name}-fused"), "id").map(|_| {
            let inner = doc.inner();
            let node = inner.get_node(surface).unwrap();
            node.attr(blitz_dom::LocalName::from("join"))
                .map(str::to_owned)
        });
        assert_eq!(join.flatten().as_deref(), Some("3"), "{name}: 3 px fillets");
    }
    assert!(doc.take_error().is_none());
}

/// Under a 64 px bridge there is none: the menu sits directly on the
/// trigger, which is attached to it by that edge (one exact outline: two
/// shapes, no bridge). The compact priority select in the lab, and the
/// command form's selects in the composer; the model picker in the
/// composer is wide enough for a bridge.
#[test]
fn a_narrow_select_merges_onto_its_menu() {
    let mut doc = document(1.0, 900.0);
    open(&mut doc, "select");
    doc.layout_surfaces();
    // Whichever side it opened on (room decides).
    let check_merged = |doc: &NativeDocument, name: &str| {
        let surface = surface_of(doc, &format!("{name}-fused"));
        let trigger = local_box(doc, surface, name);
        let menu = local_box(doc, surface, &format!("{name}-menu"));
        let below = menu[1] > trigger[1];
        assert!(
            0.8 * trigger[2].min(menu[2]) < 64.0,
            "{name}: narrow: {trigger:?}"
        );
        assert!(
            doc.inner()
                .get_element_by_id(&format!("{name}-bridge"))
                .is_none(),
            "{name}: no bridge"
        );
        assert_eq!(
            doc.surface_shapes(surface).len(),
            2,
            "{name}: trigger and menu"
        );
        if below {
            assert_eq!(menu[1], trigger[1] + trigger[3], "{name}: on the trigger");
        } else {
            assert_eq!(menu[1] + menu[3], trigger[1], "{name}: on the trigger");
        }
        let attach = support::attr(doc, &format!("{name}-face"), "surface-attach");
        assert_eq!(
            attach.as_deref(),
            Some(if below { "bottom" } else { "top" })
        );
    };
    check_merged(&doc, "lab-select-merged");
    // The composer: the command form's selects merge.
    open(&mut doc, "composer");
    scroll_to(&mut doc, "lab-state-form");
    let field = doc
        .inner()
        .query_selector("#lab-form-form button[aria-haspopup]")
        .unwrap()
        .expect("a form select");
    let name = doc
        .inner()
        .get_node(field)
        .unwrap()
        .attr(blitz_dom::LocalName::from("id"))
        .unwrap()
        .to_owned();
    support::pointer(&mut doc, &name);
    doc.resolve_layout(0.0);
    doc.layout_surfaces();
    check_merged(&doc, &name);
    // The model picker: bridged, opening upward.
    scroll_to(&mut doc, "lab-state-idle");
    support::pointer(&mut doc, "lab-idle-model");
    doc.resolve_layout(0.0);
    doc.layout_surfaces();
    let surface = surface_of(&doc, "lab-idle-model-fused");
    let trigger = local_box(&doc, surface, "lab-idle-model");
    let bridge = local_box(&doc, surface, "lab-idle-model-bridge");
    assert!(bridge[2] >= 64.0, "wide enough for a bridge: {bridge:?}");
    assert!(
        bridge[1] + 6.0 == trigger[1] || bridge[1] == trigger[1] + trigger[3],
        "against the trigger: {bridge:?} {trigger:?}"
    );
    assert_eq!(doc.surface_shapes(surface).len(), 3);
    assert!(doc.take_error().is_none());
}

// ---------------------------------------------------------------- the two painters, as pixels

/// One offscreen frame, read in CSS px.
struct Shot {
    px: Vec<u8>,
    width: u32,
    scale: f64,
}

impl Shot {
    fn take(out: &mut Offscreen, doc: &mut NativeDocument) -> Shot {
        // Twice: the first frame after a change renders the plates, and a
        // new own texture asks for settle frames.
        out.frame(doc);
        let mut px = out.frame(doc).0;
        for _ in 0..10 {
            if !doc.inner().is_animating() {
                break;
            }
            px = out.frame(doc).0;
        }
        Shot {
            px,
            width: out.width,
            scale: out.scale as f64,
        }
    }

    /// The pixel at (x, y) CSS px in the window.
    fn at(&self, x: f64, y: f64) -> [u8; 3] {
        let i = (((y * self.scale) as u32 * self.width + (x * self.scale) as u32) * 4) as usize;
        [self.px[i], self.px[i + 1], self.px[i + 2]]
    }

    /// Save the CSS px rect (x, y, w, h) as a PNG.
    fn save_png(&self, rect: [f64; 4], path: &str) {
        let [x, y, w, h] = rect.map(|v| (v * self.scale).round() as u32);
        let mut data = Vec::with_capacity((w * h * 4) as usize);
        for row in y..y + h {
            let start = ((row * self.width + x) * 4) as usize;
            data.extend_from_slice(&self.px[start..start + (w * 4) as usize]);
        }
        write_png(path, w, h, &data);
    }
}

/// True if two colours differ by at most `by` per channel.
fn close(a: [u8; 3], b: [u8; 3], by: u8) -> bool {
    a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= by)
}

/// The four differences between the two plate painters, as pixels, on the
/// fixtures' comparison rows (lab/src/fixtures.tsx, `Painters`): every row
/// holds the same elements twice, in a `plates="sheet"` cell and in a
/// self-painting one. Each row's capture (both cells) is saved as a PNG in
/// the capture directory.
///
/// a. A z-indexed bar over a scrolling list: self-painting, its background
///    hides the list; the sheet draws it under the list.
/// b. A parent with `opacity: 0.5`, and a parent moved and scaled by a CSS
///    transform: a self-painting plate fades and moves with its parent; the
///    sheet draws it opaque at its layout box.
/// c. A plate inside a nested `overflow: auto` box, scrolled half out: a
///    self-painting plate is clipped at the box's edge; the sheet's is not.
/// d. Two overlapping sibling plates, the first with `z-index: 10`:
///    self-painting, the first is on top; the sheet paints them in document
///    order.
#[test]
#[ignore = "offscreen GPU frames; run explicitly"]
fn the_two_painters_differ_where_documented() {
    let scale = 2.0;
    let dir = capture_dir();
    let mut doc = document(scale, 900.0);
    let mut out = Offscreen::new(scale);
    open(&mut doc, "fixtures");
    scroll_to(&mut doc, "lab-painters");
    doc.layout_surfaces();
    let rect = |doc: &NativeDocument, name: &str| {
        doc.inner()
            .get_client_bounding_rect(support::id(doc, name))
            .unwrap()
    };
    // Both cells of a row, with a margin, as one image.
    let row = |doc: &NativeDocument, case: &str| {
        let (a, b) = (
            rect(doc, &format!("lab-mode-{case}-sheet")),
            rect(doc, &format!("lab-mode-{case}-self")),
        );
        [
            a.x - 8.0,
            a.y - 8.0,
            b.x + b.width - a.x + 16.0,
            a.height + 16.0,
        ]
    };
    // Colours (sRGB): Tailwind's blue-600, rose-600, rose-700, emerald-500
    // and the cells' `bg-base`.
    const BLUE: [u8; 3] = [0x15, 0x5d, 0xfc];
    const ROSE: [u8; 3] = [0xec, 0x00, 0x3f];
    const BAR: [u8; 3] = [0xc7, 0x00, 0x36];
    const GREEN: [u8; 3] = [0x00, 0xbc, 0x7d];
    const BASE: [u8; 3] = [0x08; 3];

    // c needs its boxes scrolled: 12 px of the plate start above the box's
    // top edge, 8 px more make it half out.
    for mode in ["sheet", "self"] {
        let scroller = support::id(&doc, &format!("lab-mode-clip-{mode}-scroll"));
        scroll_node(&mut doc, scroller, 8.0);
    }
    let shot = Shot::take(&mut out, &mut doc);
    assert!(!doc.inner().is_animating(), "settled");

    // a. Covering: a point of the bar over a green stripe of the list.
    for (mode, want, what) in [
        ("self", BAR, "the bar hides the stripe under it"),
        (
            "sheet",
            GREEN,
            "the stripe shows over the bar (the sheet's limit)",
        ),
    ] {
        let bar = rect(&doc, &format!("lab-mode-cover-{mode}-bar"));
        // The first stripe is 20 to 30 px below the list's top; clear of
        // the bar's label and its bevel band.
        let got = shot.at(bar.x + bar.width - 40.0, bar.y + 25.0);
        assert!(close(got, want, 2), "covering, {mode}: {what}: {got:?}");
        // Above the first stripe both show the bar's own colour (clear of
        // the bevel band at the bar's top and bottom edges).
        let got = shot.at(bar.x + bar.width - 40.0, bar.y + 14.0);
        assert!(
            close(got, BAR, 2),
            "covering, {mode}: the bar's fill: {got:?}"
        );
    }
    shot.save_png(
        row(&doc, "cover"),
        &format!("{dir}/painters-a-covering.png"),
    );

    // b. Opacity: the plate's face, clear of its label and bevel.
    for (mode, want, what) in [
        (
            "self",
            [BLUE[0] / 2 + 4, BLUE[1] / 2 + 4, BLUE[2] / 2 + 4],
            "half the plate over the cell",
        ),
        ("sheet", BLUE, "opaque (the sheet's limit)"),
    ] {
        let p = rect(&doc, &format!("lab-mode-fx-{mode}-faded"));
        let got = shot.at(p.x + 8.0, p.y + p.height / 2.0);
        assert!(close(got, want, 3), "opacity, {mode}: {what}: {got:?}");
    }
    // b. Transform: the parent moves by (24, 32) and scales by 1.25 about
    // its centre, so the 80 x 40 plate covers x 14..114, y 27..77 from its
    // layout box's corner.
    for (mode, at_layout, at_moved, what) in [
        ("self", BASE, BLUE, "drawn where the transform puts it"),
        (
            "sheet",
            BLUE,
            BASE,
            "drawn at its layout box (the sheet's limit)",
        ),
    ] {
        let cell = rect(&doc, &format!("lab-mode-fx-{mode}"));
        // The layout box starts 120, 12 px into the cell.
        let (x, y) = (cell.x + 120.0, cell.y + 12.0);
        let (layout, moved) = (shot.at(x + 6.0, y + 8.0), shot.at(x + 104.0, y + 66.0));
        assert!(
            close(layout, at_layout, 3) && close(moved, at_moved, 3),
            "transform, {mode}: {what}: layout box {layout:?}, moved box {moved:?}"
        );
    }
    shot.save_png(
        row(&doc, "fx"),
        &format!("{dir}/painters-b-opacity-transform.png"),
    );

    // c. Nested scroll: the plate is 40 px tall and 20 px of it are above
    // the box's top edge (its border is 1 px).
    for (mode, above, what) in [
        ("self", BASE, "clipped at the box's edge"),
        ("sheet", BLUE, "drawn over the edge (the sheet's limit)"),
    ] {
        let (scroller, plate) = (
            rect(&doc, &format!("lab-mode-clip-{mode}-scroll")),
            rect(&doc, &format!("lab-mode-clip-{mode}-plate")),
        );
        // Blitz moves a scroller's own client rect by its scroll offset
        // (8 px here); its top edge on screen has not moved.
        let top = scroller.y + 8.0;
        assert_eq!(plate.y - top, -19.0, "{mode}: half out");
        let x = plate.x + 8.0;
        let got = shot.at(x, top - 8.0);
        assert!(
            close(got, above, 3),
            "nested scroll, {mode}: {what}: {got:?}"
        );
        // The box is a plate too (`bg-well`): its own fill stays put while
        // its content scrolls.
        let well = shot.at(scroller.x + scroller.width - 12.0, top + 4.0);
        assert!(
            close(well, [0x15; 3], 2),
            "nested scroll, {mode}: the box's own fill: {well:?}"
        );
        let got = shot.at(x, top + 8.0);
        assert!(
            close(got, BLUE, 3),
            "nested scroll, {mode}: the visible half: {got:?}"
        );
    }
    shot.save_png(
        row(&doc, "clip"),
        &format!("{dir}/painters-c-nested-scroll.png"),
    );

    // d. z-index: a point both plates cover.
    for (mode, want, what) in [
        ("self", ROSE, "the z-index 10 plate is on top"),
        ("sheet", BLUE, "document order (the sheet's limit)"),
    ] {
        let (front, back) = (
            rect(&doc, &format!("lab-mode-z-{mode}-front")),
            rect(&doc, &format!("lab-mode-z-{mode}-back")),
        );
        let got = shot.at(back.x + 12.0, front.y + front.height - 10.0);
        assert!(close(got, want, 3), "z-index, {mode}: {what}: {got:?}");
        // Where only one of them is, that one shows.
        assert!(close(shot.at(front.x + 8.0, front.y + 12.0), ROSE, 3));
        assert!(close(
            shot.at(back.x + back.width - 8.0, back.y + back.height - 12.0),
            BLUE,
            3
        ));
    }
    shot.save_png(row(&doc, "z"), &format!("{dir}/painters-d-z-index.png"));

    // All four rows in one image.
    let (first, last) = (row(&doc, "cover"), row(&doc, "z"));
    shot.save_png(
        [first[0], first[1], first[2], last[1] + last[3] - first[1]],
        &format!("{dir}/painters-all.png"),
    );
    // Static: nothing asks for frames, and repaints re-render nothing.
    let dirty = render::surface_dirty_pixels();
    for _ in 0..10 {
        out.frame(&mut doc);
    }
    assert!(!doc.inner().is_animating());
    assert_eq!(render::surface_dirty_pixels(), dirty, "static: 0 px");
    assert!(doc.take_error().is_none());
}

/// Where the sheet has no limit, both painters draw the same picture: the
/// keycap rows (trays, caps, tiles) and the fixtures' plain backgrounds (a
/// flat coloured box with caps, background buttons) are compared pixel by
/// pixel between the two. Both place a plate at the box Blitz paints its
/// element in, so a cap after text of fractional width is not half a pixel
/// off in either.
#[test]
#[ignore = "offscreen GPU frames; run explicitly"]
fn both_painters_draw_the_same_keycaps() {
    let scale = 2.0;
    let dir = capture_dir();
    let mut doc = document(scale, 900.0);
    let mut out = Offscreen::new(scale);
    let mut compare = |doc: &mut NativeDocument, name: &str, file: &str| {
        let mut shots = Vec::new();
        for mode in PAINTERS {
            painter(doc, mode);
            scroll_to(doc, name);
            shots.push(Shot::take(&mut out, doc));
        }
        painter(doc, "self");
        let r = doc
            .inner()
            .get_client_bounding_rect(support::id(doc, name))
            .unwrap();
        let rect = [r.x - 8.0, r.y - 8.0, r.width + 16.0, r.height + 16.0];
        for (shot, mode) in shots.iter().zip(PAINTERS) {
            shot.save_png(rect, &format!("{dir}/{file}-{mode}.png"));
        }
        // Device pixels of the case that differ, and by how much at most.
        let [x, y, w, h] = rect.map(|v| (v * scale as f64).round() as u32);
        let (mut differ, mut worst) = (0u32, 0u8);
        for row in y..y + h {
            for col in x..x + w {
                let i = ((row * out.width + col) * 4) as usize;
                let d = (0..3)
                    .map(|c| shots[0].px[i + c].abs_diff(shots[1].px[i + c]))
                    .max()
                    .unwrap();
                differ += u32::from(d > 0);
                worst = worst.max(d);
            }
        }
        println!(
            "{name}: {differ} of {} px differ, by at most {worst}/255",
            w * h
        );
        (differ, worst)
    };
    // Bevelled plates match to 1/255.
    open(&mut doc, "surfaces");
    let (differ, worst) = compare(&mut doc, "lab-keycaps", "keycaps");
    assert!(worst <= 1, "keycap rows: {differ} px, {worst}");
    // Up to 7/255 on the corner pixels of the flat coloured box: a
    // self-painting plate without a bevel is a vector fill, anti-aliased by
    // Vello instead of our shader.
    open(&mut doc, "fixtures");
    let (differ, worst) = compare(&mut doc, "lab-fixture-plates", "plain-backgrounds");
    assert!(worst <= 8, "plain backgrounds: {differ} px, {worst}");
    assert!(doc.take_error().is_none());
}

/// The field on a card, as pixels, with either painter: the field's well
/// and the inline highlight show on the card (before the card drew them as
/// its guests, a self-painting card covered them).
#[test]
#[ignore = "offscreen GPU frames; run explicitly"]
fn a_field_on_a_card_shows_its_well() {
    let scale = 2.0;
    let dir = capture_dir();
    let mut doc = document(scale, 900.0);
    let mut out = Offscreen::new(scale);
    open(&mut doc, "surfaces");
    for mode in PAINTERS {
        painter(&mut doc, mode);
        scroll_to(&mut doc, "lab-field-case");
        let shot = Shot::take(&mut out, &mut doc);
        let rect = |name: &str| {
            doc.inner()
                .get_client_bounding_rect(support::id(&doc, name))
                .unwrap()
        };
        let (card, field, inline) = (
            rect("lab-field-card"),
            rect("lab-field"),
            rect("lab-field-inline"),
        );
        shot.save_png(
            [
                card.x - 8.0,
                card.y - 8.0,
                card.width + 16.0,
                card.height + 16.0,
            ],
            &format!("{dir}/field-on-card-{mode}.png"),
        );
        // The card's face, between its edge and the field.
        let got = shot.at(card.x + 4.0, card.y + card.height / 2.0);
        assert!(close(got, [0x25; 3], 2), "{mode}: the card: {got:?}");
        // The field's well, right of its text and clear of its bevel.
        let got = shot.at(field.x + field.width - 8.0, field.y + field.height / 2.0);
        assert!(
            close(got, [0x15; 3], 2),
            "{mode}: the field's well: {got:?}"
        );
        // The highlight, above its glyphs (its line box is 20 px tall).
        let got = shot.at(inline.x + inline.width / 2.0, inline.y + 2.0);
        assert!(
            close(got, [0x15, 0x5d, 0xfc], 3),
            "{mode}: the inline highlight: {got:?}"
        );
    }
    assert!(doc.take_error().is_none());
}
