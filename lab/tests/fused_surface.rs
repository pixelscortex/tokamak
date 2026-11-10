//! `<tk-surface>` in the real lab document (render/src/surface,
//! lab/src/fused.tsx).
//!
//! The first tests are fast and headless: interaction through the production
//! document API, no GPU. The `#[ignore]`d ones paint the lab offscreen through
//! the production paint path (blitz-paint + Vello on a real wgpu device, with
//! the per-frame `surface_end_frame` hook the window uses) and are run
//! explicitly:
//! `cargo test --release -p tokamak-lab --test fused_surface -- --ignored --nocapture`.
//! Captures go to `$TK_CAPTURE_DIR` (default `/tmp/tkm-fused-poc`) as raw RGBA.
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;
use anyrender::ImageRenderer;
use anyrender_vello::VelloImageRenderer;
use blitz_dom::Document;
use blitz_traits::shell::Viewport;
use render::NativeDocument;
use std::time::{Duration, Instant};

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
    doc.inner_mut().resolve(0.0);
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
    doc.inner_mut().resolve(0.0);
}

fn click(doc: &mut NativeDocument, name: &str) {
    scroll_stage(doc, 0.0);
    support::pointer(doc, name);
}

/// Open a lab section from the rail.
fn open(doc: &mut NativeDocument, section: &str) {
    click(doc, &format!("lab-rail-{section}"));
    doc.inner_mut().resolve(0.0);
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
/// layer, not a hit target), and a rail click retargets the tab geometry.
#[test]
fn clicks_reach_controls_above_surfaces_and_move_the_rail_tab() {
    let mut doc = document(1.0, 900.0);
    open(&mut doc, "surfaces");
    let before = support::attr(&doc, "lab-fused-rail-surface", "shapes").unwrap();
    support::pointer(&mut doc, "lab-fused-rail-3");
    assert_eq!(
        support::attr(&doc, "lab-fused-rail-3", "aria-pressed").as_deref(),
        Some("true")
    );
    let after = support::attr(&doc, "lab-fused-rail-surface", "shapes").unwrap();
    assert_ne!(before, after, "the tab geometry follows the selection");
    support::pointer(&mut doc, "lab-fused-shutter");
    assert_eq!(support::text(&doc, "lab-fused-presses"), "1 presses");
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
    let mut doc = document(1.0, 900.0);
    open(&mut doc, "surfaces");
    let surface = support::id(&doc, "lab-fused-cutout-surface");
    let rect = doc.inner().get_client_bounding_rect(surface).unwrap();
    let before = doc.inner().get_node(stage(&doc)).unwrap().scroll_offset().y;
    // Aim at the surface's top-left corner: base colour (outside the plate)
    // with no DOM content above it. The window does not scroll, so client
    // and page coordinates are the same.
    let (x, client_y) = ((rect.x + 8.0) as f32, (rect.y + 8.0) as f32);
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

/// The shell schedules frames only while `is_animating()`: the idle lab must
/// request none, a running stress demo must request them, and Stop must
/// return the document to no redraws.
#[test]
fn idle_and_stopped_surfaces_request_no_frames() {
    let mut doc = document(1.0, 900.0);
    doc.layout_surfaces();
    assert!(!doc.inner().is_animating(), "idle lab requests no frames");
    open(&mut doc, "stress");
    for variant in ["one", "many"] {
        click(&mut doc, &format!("lab-fused-stress-{variant}"));
        click(&mut doc, "lab-fused-stress-toggle");
        assert!(
            doc.inner().is_animating(),
            "{variant}: running requests frames"
        );
        click(&mut doc, "lab-fused-stress-toggle");
        // The readout lingers 300 ms after the last active frame (none here).
        std::thread::sleep(Duration::from_millis(350));
        assert!(
            !doc.inner().is_animating(),
            "{variant}: stopped requests none"
        );
    }
    assert!(doc.take_error().is_none());
}

/// Switching to or from Chat takes its title notch and composer out of (or
/// puts them into) the shell layers in the same layout pass as the rail tab
/// moves. The tab must still animate between its own two boxes: matched by
/// identity, not by position in the layer's shape list (which changes
/// length here). The pending animation is what makes the document ask for
/// frames.
#[test]
fn the_rail_tab_animates_when_a_view_switch_adds_and_removes_shell_shapes() {
    let mut doc = document(1.0, 900.0);
    doc.layout_surfaces();
    assert!(!doc.inner().is_animating());
    for section in ["components", "surfaces", "chat", "stress", "chat"] {
        support::pointer(&mut doc, &format!("lab-rail-{section}"));
        doc.inner_mut().resolve(0.0);
        doc.layout_surfaces();
        assert!(doc.inner().is_animating(), "to {section}: the tab animates");
    }
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
        doc.inner_mut().resolve(0.0);
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

    fn save(&mut self, doc: &mut NativeDocument, dir: &str, name: &str) {
        let (pixels, _, _) = self.frame(doc);
        let path = format!("{dir}/{name}-{}x{}.rgba", self.width, self.height);
        std::fs::write(&path, pixels).unwrap();
        println!("{path}");
    }

    /// Let a 220 ms shape animation finish, then save.
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

/// Every lab case, plus the rail tab mid-move and the stress test running
/// and stopped.
#[test]
#[ignore = "writes offscreen GPU captures; run explicitly"]
fn capture_cases() {
    let dir = capture_dir();
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    open(&mut doc, "surfaces");
    scroll_to(&mut doc, "lab-fused-rail");
    out.save(&mut doc, &dir, "00-rail-panel-cutout");
    click(&mut doc, "lab-fused-rail-2");
    scroll_to(&mut doc, "lab-fused-rail");
    std::thread::sleep(Duration::from_millis(60));
    out.save(&mut doc, &dir, "01-rail-tab-moving");
    out.save_settled(&mut doc, &dir, "02-rail-tab-settled");
    scroll_to(&mut doc, "lab-fused-border");
    out.save(&mut doc, &dir, "10-border-1.5-inside");
    click(&mut doc, "lab-fused-border-width-3");
    click(&mut doc, "lab-fused-border-align-outside");
    scroll_to(&mut doc, "lab-fused-border");
    out.save(&mut doc, &dir, "11-border-3-outside");
    scroll_to(&mut doc, "lab-fused-notch");
    out.save(&mut doc, &dir, "12-notch-0-45");
    click(&mut doc, "lab-fused-notch-left-30");
    click(&mut doc, "lab-fused-notch-right-60");
    click(&mut doc, "lab-fused-notch-join-24");
    scroll_to(&mut doc, "lab-fused-notch");
    out.save_settled(&mut doc, &dir, "13-notch-30-60-join24");
    open(&mut doc, "stress");
    click(&mut doc, "lab-fused-stress-100");
    click(&mut doc, "lab-fused-stress-toggle");
    scroll_to(&mut doc, "lab-fused-stress");
    for _ in 0..30 {
        out.frame(&mut doc);
    }
    out.save(&mut doc, &dir, "14-stress-A-100-running");
    click(&mut doc, "lab-fused-stress-many");
    click(&mut doc, "lab-fused-stress-200");
    scroll_to(&mut doc, "lab-fused-stress");
    for _ in 0..30 {
        out.frame(&mut doc);
    }
    out.save(&mut doc, &dir, "15-stress-B-200-running");
    click(&mut doc, "lab-fused-stress-toggle");
    scroll_to(&mut doc, "lab-fused-stress");
    for _ in 0..3 {
        out.frame(&mut doc);
    }
    out.save(&mut doc, &dir, "16-stress-stopped-idle");
    assert!(doc.take_error().is_none());
}

/// Notch at 15/30/45/60 degrees (right side; left side vertical), for judging
/// the joins by eye. `TK_CAPTURE_TAG` names the set.
#[test]
#[ignore = "writes offscreen GPU captures; run explicitly"]
fn capture_notch_angles() {
    let dir = capture_dir();
    let tag = std::env::var("TK_CAPTURE_TAG").unwrap_or_else(|_| "now".into());
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    open(&mut doc, "surfaces");
    click(&mut doc, "lab-fused-notch-left-0");
    for angle in [15, 30, 45, 60] {
        click(&mut doc, &format!("lab-fused-notch-right-{angle}"));
        scroll_to(&mut doc, "lab-fused-notch-panel");
        out.save_settled(&mut doc, &dir, &format!("notch-{tag}-{angle}"));
    }
}

/// Stress configurations (SURFACES.md "Measured cost"): 20 warm-up frames,
/// then 100 frames back to back. Prints means; run with --nocapture.
/// `TK_BENCH_FILTER` limits the run to labels containing that text.
#[test]
#[ignore = "GPU benchmark; run explicitly"]
fn stress_bench() {
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    let filter = std::env::var("TK_BENCH_FILTER").unwrap_or_default();
    open(&mut doc, "stress");
    let mean = |v: &[Duration]| v.iter().sum::<Duration>().as_secs_f64() * 1e3 / v.len() as f64;
    // (variant button, total, moving button, probe)
    let mut configs = vec![];
    for variant in ["one", "many"] {
        for n in [16, 50, 100, 200] {
            configs.push((variant, n, "all", false));
        }
        configs.push((variant, 1000, "10", false));
        configs.push((variant, 1000, "100", false));
        configs.push((variant, 200, "5", false));
        configs.push((variant, 1000, "0", true));
    }
    // Page baseline: stress area stopped (readback and the rest of the page).
    click(&mut doc, "lab-fused-stress-16");
    scroll_to(&mut doc, "lab-fused-stress");
    let base: Vec<_> = (0..60).map(|_| out.frame(&mut doc).2).collect();
    println!(
        "bench baseline (stopped, A 16): frame {:.2} ms",
        mean(&base[20..])
    );
    for (variant, n, moving, probe) in configs {
        let label = format!(
            "{} n={n} moving={moving}{}",
            if variant == "one" { "A" } else { "B" },
            if probe { " +probe" } else { "" }
        );
        if !label.contains(&filter) {
            continue;
        }
        click(&mut doc, &format!("lab-fused-stress-{variant}"));
        click(&mut doc, &format!("lab-fused-stress-{n}"));
        click(&mut doc, &format!("lab-fused-stress-moving-{moving}"));
        if probe {
            click(&mut doc, "lab-fused-stress-probe");
        }
        click(&mut doc, "lab-fused-stress-toggle");
        scroll_to(&mut doc, "lab-fused-stress");
        let (mut scenes, mut totals, mut work, mut dirty) = (vec![], vec![], vec![], vec![]);
        for i in 0..120 {
            let before = render::surface_paint_work();
            let px = render::surface_dirty_pixels();
            let (_, scene, total) = out.frame(&mut doc);
            if i >= 20 {
                scenes.push(scene);
                totals.push(total);
                work.push(render::surface_paint_work() - before);
                dirty.push(render::surface_dirty_pixels() - px);
            }
        }
        click(&mut doc, "lab-fused-stress-toggle");
        if probe {
            click(&mut doc, "lab-fused-stress-probe");
        }
        let worst = totals.iter().max().unwrap().as_secs_f64() * 1e3;
        println!(
            "bench {label}: frame {:.2} ms (worst {worst:.2}), scene build {:.2} ms, \
             surface paint {:.2} ms, dirty {:.0} kpx/frame",
            mean(&totals),
            mean(&scenes),
            mean(&work),
            dirty.iter().sum::<u64>() as f64 / dirty.len() as f64 / 1e3,
        );
    }
    assert!(doc.take_error().is_none());
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
            std::fs::write(format!("{dir}/resize-live-{w}.rgba"), &live).unwrap();
            std::fs::write(format!("{dir}/resize-fresh-{w}.rgba"), &want).unwrap();
        }
    }
    assert_eq!(worst.0, 0, "worst frame at {} css px", worst.1);
}

/// Round 6 captures: Chat at 1440 / 1100 / 900 px and at the minimum window
/// size, the shell hairline flat (`border-lit` 0) for comparison, and the
/// rail tab in flight (frames ~16 ms apart) to look for crawl.
#[test]
#[ignore = "writes offscreen GPU captures; run explicitly"]
fn capture_round6() {
    let dir = capture_dir();
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    open(&mut doc, "chat");
    out.save_settled(&mut doc, &dir, "r6-chat-1440");
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../app.config.json")).unwrap();
    let min = (
        config["minWidth"].as_u64().unwrap() as u32,
        config["minHeight"].as_u64().unwrap() as u32,
    );
    for (w, h) in [(1100, 900), (900, 900), min] {
        out.resize(&mut doc, w, h);
        out.save_settled(&mut doc, &dir, &format!("r6-chat-{w}x{h}"));
    }
    out.resize(&mut doc, 1440, 900);
    for group in ["shell-sidebar", "shell-stage"] {
        let node = doc
            .inner()
            .query_selector(&format!("tk-surface[group={group}]"))
            .unwrap()
            .unwrap();
        let name = blitz_dom::QualName::new(
            None,
            blitz_dom::Namespace::from(""),
            blitz_dom::LocalName::from("border-lit"),
        );
        doc.inner_mut().mutate().set_attribute(node, name, "0");
    }
    out.save_settled(&mut doc, &dir, "r6-chat-flat");
    for group in ["shell-sidebar", "shell-stage"] {
        let node = doc
            .inner()
            .query_selector(&format!("tk-surface[group={group}]"))
            .unwrap()
            .unwrap();
        let name = blitz_dom::QualName::new(
            None,
            blitz_dom::Namespace::from(""),
            blitz_dom::LocalName::from("border-lit"),
        );
        doc.inner_mut().mutate().set_attribute(node, name, "0.25");
    }
    out.save_settled(&mut doc, &dir, "r6-chat-lit");
    click(&mut doc, "lab-rail-surfaces");
    for i in 0..8 {
        std::thread::sleep(Duration::from_millis(16));
        out.save(&mut doc, &dir, &format!("r6-tab-frame{i}"));
    }
    assert!(doc.take_error().is_none());
}

/// No continuous redraws: after a section switch settles (the tab's 220 ms
/// animation, plus the stress section's frame readout, which keeps drawing
/// 300 ms past the last active frame), the document
/// requests no frames (the shell's frame counter stops) and repainting it
/// re-renders no surface pixel, in every section, including after the rail
/// tab's animation and a resize.
#[test]
#[ignore = "offscreen GPU frames; run explicitly"]
fn settled_sections_request_no_frames_and_render_nothing() {
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
    for section in ["chat", "components", "surfaces", "stress", "chat"] {
        open(&mut doc, section);
        let frames = settle(&mut doc, &mut out);
        assert!(
            !doc.inner().is_animating(),
            "{section}: still requesting frames after {frames}"
        );
        let (work, px) = (render::surface_paint_work(), render::surface_dirty_pixels());
        for _ in 0..10 {
            out.frame(&mut doc);
            assert!(
                !doc.inner().is_animating(),
                "{section}: a repaint asked for more"
            );
        }
        let px = render::surface_dirty_pixels() - px;
        let work = render::surface_paint_work() - work;
        println!(
            "{section}: settled after {frames} frames; 10 idle repaints re-rendered {px} px, \
             surface paint {:.3} ms in total",
            work.as_secs_f64() * 1e3
        );
        assert_eq!(px, 0, "{section}: idle repaints re-rendered surface pixels");
    }
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
        assert_eq!(sidebar, [0x12; 3], "{label}: the plugin container is drawn");
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

/// Every rail section at the lab window's size (1440x900 at scale 2), for
/// comparing against the design file.
#[test]
#[ignore = "writes offscreen GPU captures; run explicitly"]
fn capture_sections() {
    let dir = capture_dir();
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    for section in ["chat", "components", "surfaces", "stress"] {
        open(&mut doc, section);
        out.save_settled(&mut doc, &dir, &format!("section-{section}"));
    }
    assert!(doc.take_error().is_none());
}

/// Views teleport their parts into the shell's fixed regions: switching the
/// rail section replaces the sidebar and stage content, the view-specific top
/// bar parts and the title that hangs from the top bar, while the frame stays.
#[test]
fn sections_teleport_into_the_shell_regions() {
    let mut doc = document(1.0, 900.0);
    let title = |doc: &NativeDocument| doc.inner().get_element_by_id("lab-chat-title").is_some();
    assert!(title(&doc), "the chat view starts open");
    assert!(doc.inner().get_element_by_id("lab-chat-composer").is_some());
    let stage = stage(&doc);
    open(&mut doc, "components");
    assert!(!title(&doc), "the chat title left the top bar");
    assert!(support::text(&doc, "lab").contains("Component lab"));
    assert_eq!(
        stage,
        self::stage(&doc),
        "the frame's stage is the same element"
    );
    // The chat view's content lives in the stage region, not where the view is.
    let lab = support::id(&doc, "lab");
    assert!(doc.inner().node_chain(lab).contains(&stage));
    open(&mut doc, "chat");
    assert!(title(&doc));
    assert!(doc.take_error().is_none());
}
