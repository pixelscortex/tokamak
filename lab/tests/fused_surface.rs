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

/// Animation is switched off in the lab for now: no shape asks for it, so a
/// view switch (which moves the rail tab and adds or removes the Chat title
/// notch and composer in the same layout pass) lands in one frame and the
/// document asks for no further frames.
#[test]
fn a_view_switch_moves_the_rail_tab_without_animating() {
    let mut doc = document(1.0, 900.0);
    doc.layout_surfaces();
    assert!(!doc.inner().is_animating());
    for section in ["components", "surfaces", "chat", "stress", "chat"] {
        support::pointer(&mut doc, &format!("lab-rail-{section}"));
        doc.inner_mut().resolve(0.0);
        doc.layout_surfaces();
        assert!(
            !doc.inner().is_animating(),
            "to {section}: nothing animates"
        );
    }
    assert!(doc.take_error().is_none());
}

/// The stage scroller must be a stacking context. Blitz hoists every
/// descendant with a z-index to the nearest stacking context and paints it
/// there; when that was an ancestor of the scroller, scrolled content (the
/// "Shutter" label of the Surfaces view) was drawn over the top bar.
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

/// The keycap case of the Surfaces view, for judging the lighting.
#[test]
#[ignore = "writes offscreen GPU captures; run explicitly"]
fn capture_keycaps() {
    let dir = capture_dir();
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    open(&mut doc, "surfaces");
    out.save_settled(&mut doc, &dir, "r9-keycaps");
    assert!(doc.take_error().is_none());
}

/// The same bug, as pixels: the Surfaces view scrolled until the "Shutter"
/// label sits above the stage's top edge. Nothing may show in the top bar.
#[test]
#[ignore = "writes offscreen GPU captures; run explicitly"]
fn capture_scrolled_stage_clip() {
    let dir = capture_dir();
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    open(&mut doc, "surfaces");
    let label = support::id(&doc, "lab-fused-presses");
    let rect = doc.inner().get_client_bounding_rect(label).unwrap();
    scroll_stage(&mut doc, rect.y - 30.0);
    out.save_settled(&mut doc, &dir, "r8-stage-clip");
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
    // With each painter: every plate painting itself, then the sheets.
    for mode in PAINTERS {
        painter(&mut doc, mode);
        for section in ["chat", "components", "surfaces", "stress", "chat"] {
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

/// The rail tab, attached to the plugin container: on the first item its
/// top edge runs straight into the container's top edge; mid-animation; and
/// on the second item, where both fillets and the container's corner are
/// back. Crops of the rail into the capture directory.
#[test]
#[ignore = "writes offscreen GPU captures; run explicitly"]
fn capture_rail_tab() {
    let dir = capture_dir();
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    open(&mut doc, "chat");
    out.save_settled(&mut doc, &dir, "r7-tab-item0");
    click(&mut doc, "lab-rail-components");
    std::thread::sleep(Duration::from_millis(70));
    out.save(&mut doc, &dir, "r7-tab-mid");
    out.save_settled(&mut doc, &dir, "r7-tab-item1");
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

// ---------------------------------------------------------------- plates (materials from classes)

/// A pointer event over the centre of element `name`, with `buttons` held.
fn pointer_at(
    doc: &mut NativeDocument,
    name: &str,
    buttons: blitz_traits::events::MouseEventButtons,
) -> blitz_traits::events::BlitzPointerEvent {
    use blitz_traits::events::*;
    use keyboard_types::Modifiers;
    doc.inner_mut().resolve(0.0);
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
    doc.inner_mut().resolve(0.0);
    doc.layout_surfaces();
}

/// The pointer moves over the centre of element `name` (`:hover`).
fn hover(doc: &mut NativeDocument, name: &str) {
    use blitz_traits::events::{MouseEventButtons, UiEvent};
    let event = pointer_at(doc, name, MouseEventButtons::None);
    doc.handle_ui_event(UiEvent::PointerMove(event));
    doc.inner_mut().resolve(0.0);
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

/// Switch every shell region to a painter with the top bar's "Plates"
/// switch (the stage keeps its scroll position).
fn painter(doc: &mut NativeDocument, mode: &str) {
    let sheet = support::attr(doc, "lab-plates-mode", "aria-pressed").as_deref() == Some("true");
    if sheet != (mode == "sheet") {
        support::pointer(doc, "lab-plates-mode");
    }
    doc.inner_mut().resolve(0.0);
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
            // 4 trays (one per row, two in the shortcut row) and the
            // coloured box, then 3 + 4 + 4 caps, the box's 2 and 4
            // background buttons. The menu is a region of its own.
            assert_eq!(shapes.len(), 5 + 17, "{shapes:#?}");
            assert_eq!(own.len(), 2, "only the menu and its selected item");
            // Outer elements first: the trays and the box paint below what
            // they hold (the box is flat, the trays recessed).
            assert!(
                shapes[..5]
                    .iter()
                    .all(|s| s.recessed || hex(s.fill.unwrap()) == "#3a2420"),
                "trays and box first: {shapes:#?}"
            );
            shapes[0].clone()
        } else {
            // The same 22, plus the menu and its selected item; the stage's
            // layer draws none of them.
            assert_eq!(own.len(), 5 + 17 + 2);
            assert!(shapes.is_empty(), "{mode}: {shapes:#?}");
            assert!(own.iter().all(|&id| carries_widget(&doc, id)));
            let deny = support::id(&doc, "lab-key-deny");
            let tray = doc.inner().get_node(deny).unwrap().parent.unwrap();
            doc.own_plate_shape(tray).unwrap()
        };
        assert_eq!(tray.radii, [10.0; 4], "rounded-[10px] from computed style");
        assert_eq!(hex(tray.fill.unwrap()), "#080808");
        assert_eq!((tray.bevel, tray.recessed), (Some(1.5), true));

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
        assert_eq!((deny.bevel, deny.recessed), (Some(2.5), false));
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
        assert_eq!((down.bevel, down.recessed), (Some(2.0), true));
        assert!(
            !doc.inner().is_animating(),
            "a state change needs one frame"
        );
        pointer_half(&mut doc, "lab-key-deny", true);
        assert_eq!(plate_shape(&doc, "lab-key-deny"), deny, "released");

        // `active:bevel-1`: only the bevel changes.
        pointer_half(&mut doc, "lab-key-once", false);
        let once = plate_shape(&doc, "lab-key-once");
        assert_eq!((once.bevel, once.recessed), (Some(1.0), false));
        assert_eq!(hex(once.fill.unwrap()), "#e8e8ea");
        pointer_half(&mut doc, "lab-key-once", true);
        assert_eq!(plate_shape(&doc, "lab-key-once").bevel, Some(2.5));

        // `aria-pressed:material-key-pressed`: a click toggles the attribute.
        pointer_half(&mut doc, "lab-key-always", false);
        pointer_half(&mut doc, "lab-key-always", true);
        assert_eq!(
            support::attr(&doc, "lab-key-always", "aria-pressed").as_deref(),
            Some("true"),
            "{mode}: the click reached the button"
        );
        let toggled = plate_shape(&doc, "lab-key-always");
        assert_eq!((toggled.bevel, toggled.recessed), (Some(2.0), true));
        assert!(!doc.inner().is_animating());
        // Shortcut keys and tiles are buttons too: a key sinks while held,
        // and a click selects a tile (the selected one stays down).
        pointer_half(&mut doc, "lab-key-cmd", false);
        assert!(plate_shape(&doc, "lab-key-cmd").recessed);
        pointer_half(&mut doc, "lab-key-cmd", true);
        assert!(!plate_shape(&doc, "lab-key-cmd").recessed);
        assert!(plate_shape(&doc, "lab-key-tile-chat").recessed);
        pointer_half(&mut doc, "lab-key-tile-code", false);
        pointer_half(&mut doc, "lab-key-tile-code", true);
        assert!(plate_shape(&doc, "lab-key-tile-code").recessed);
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
    let mut doc = document(1.0, 900.0);
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
    let focus_own = doc.inner().get_focussed_node_id();
    assert!(plate_shape(&doc, "lab-key-deny").recessed, ":active");
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
    doc.inner_mut().resolve(0.0);
    doc.layout_surfaces();
    assert_eq!(
        support::attr(&doc, "lab-key-always", "aria-pressed").as_deref(),
        Some("false"),
        "Enter clicked the focused button"
    );
    assert!(!plate_shape(&doc, "lab-key-always").recessed);

    // A wheel over the plate scrolls the stage; the plate's shape does not
    // change with scrolling.
    let before = plate_shape(&doc, "lab-key-deny");
    {
        use blitz_traits::events::*;
        let offset = doc.inner().get_node(stage(&doc)).unwrap().scroll_offset().y;
        let event = pointer_at(&mut doc, "lab-key-deny", MouseEventButtons::None);
        doc.handle_ui_event(UiEvent::PointerMove(event.clone()));
        doc.handle_ui_event(UiEvent::Wheel(BlitzWheelEvent {
            delta: BlitzWheelDelta::Pixels(0.0, -40.0),
            coords: event.coords,
            buttons: MouseEventButtons::None,
            mods: keyboard_types::Modifiers::empty(),
            element: Default::default(),
        }));
        let now = doc.inner().get_node(stage(&doc)).unwrap().scroll_offset().y;
        assert_ne!(now, offset, "the stage scrolled");
    }
    doc.inner_mut().resolve(0.0);
    doc.layout_surfaces();
    assert_eq!(plate_shape(&doc, "lab-key-deny"), before);
    assert!(!doc.inner().is_animating(), "settled: no frames requested");

    // The sheet: no widget, same layout, same focus behaviour.
    painter(&mut doc, "sheet");
    assert!(!carries_widget(&doc, deny), "the sheet draws it now");
    assert_eq!(layout(&doc, deny), own, "same box and text either way");
    pointer_half(&mut doc, "lab-key-deny", false);
    assert_eq!(
        doc.inner().get_focussed_node_id(),
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

/// A plate leaves the document and comes back (a view switch and back):
/// Blitz drops a widget with its element, so the layout pass attaches a new
/// one when the element returns, and stops tracking plates that are gone.
#[test]
fn self_painting_plates_survive_leaving_and_returning() {
    let mut doc = document(1.0, 900.0);
    open(&mut doc, "surfaces");
    doc.layout_surfaces();
    let count = doc.own_plate_count();
    assert!(count > 20, "the Surfaces view's plates: {count}");
    // The top bar's switch is a plate in every view.
    open(&mut doc, "components");
    doc.layout_surfaces();
    let elsewhere = doc.own_plate_count();
    assert!(elsewhere < count, "{elsewhere} of {count} left");
    open(&mut doc, "surfaces");
    doc.layout_surfaces();
    assert_eq!(doc.own_plate_count(), count);
    for name in ["lab-key-deny", "lab-bg-blue", "lab-plates-order"] {
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
    let mut doc = document(1.0, 900.0);
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
    // state is per thread and device).
    let mut doc = document(scale, 900.0);
    let mut out = Offscreen::new(scale);
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
        open(&mut doc, "surfaces");
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

/// Open the Stress view's 300-keycap grid (variant C).
fn open_keycap_grid(doc: &mut NativeDocument) {
    open(doc, "stress");
    click(doc, "lab-fused-stress-keys");
}

/// The layout pass with the 300-keycap grid on screen and nothing changing,
/// with either painter: every redraw runs it, so this is the static cost of
/// change detection (who draws each plate, one computed-style pointer
/// compare and one box read per plate).
#[test]
fn keycap_grid_binding_pass_cost() {
    for mode in PAINTERS {
        let mut doc = document(1.0, 900.0);
        open_keycap_grid(&mut doc);
        painter(&mut doc, mode);
        for i in [0, 299] {
            let cap = format!("lab-grid-cap-{i}");
            assert!(support::attr(&doc, &cap, "tk-plate").is_some(), "{cap}");
        }
        scroll_to(&mut doc, "lab-keycap-grid");
        doc.layout_surfaces();
        let layer = stage_layer(&doc);
        let grid = doc
            .inner()
            .get_client_bounding_rect(support::id(&doc, "lab-keycap-grid"))
            .unwrap();
        let origin = doc.inner().get_client_bounding_rect(layer).unwrap();
        let in_layer = doc
            .surface_shapes(layer)
            .iter()
            .filter(|s| f64::from(s.rect[1]) + origin.y >= grid.y - 0.5)
            .count();
        let own = own_plates(&doc, "#lab-keycap-grid, #lab-keycap-grid [tk-plate]").len();
        let want = if mode == "sheet" { (301, 0) } else { (0, 301) };
        assert_eq!((in_layer, own), want, "{mode}: tray + 300 caps");
        let t = Instant::now();
        for _ in 0..200 {
            doc.layout_surfaces();
        }
        println!(
            "binding pass, stress view with the 300-keycap grid, static, {mode}: {:.1} us",
            t.elapsed().as_secs_f64() * 1e6 / 200.0
        );
        assert!(!doc.inner().is_animating());
        assert!(doc.take_error().is_none());
    }
}

/// The keycap case at rest, and with caps pressed through CSS state (Deny
/// held down, Always allow toggled, the CODE tile selected); then the
/// Stress view's 300-keycap grid.
#[test]
#[ignore = "writes offscreen GPU captures; run explicitly"]
fn capture_keycap_states() {
    let dir = capture_dir();
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    open(&mut doc, "surfaces");
    scroll_to(&mut doc, "lab-keycaps");
    out.save_settled(&mut doc, &dir, "keycaps-rest");
    pointer_half(&mut doc, "lab-key-always", false);
    pointer_half(&mut doc, "lab-key-always", true);
    pointer_half(&mut doc, "lab-key-tile-code", false);
    pointer_half(&mut doc, "lab-key-tile-code", true);
    pointer_half(&mut doc, "lab-key-deny", false);
    out.save_settled(&mut doc, &dir, "keycaps-pressed");
    pointer_half(&mut doc, "lab-key-deny", true);
    open_keycap_grid(&mut doc);
    scroll_to(&mut doc, "lab-keycap-grid");
    out.save_settled(&mut doc, &dir, "keycap-grid");
    assert!(doc.take_error().is_none());
}

/// 300 keycap plates on screen (Stress view, variant C) against the same
/// view without them (variant A, stopped), with each painter (the caps
/// painting themselves, then the stage's sheet drawing them). Static: the
/// document must settle, request no frames and re-render no pixel over 100
/// repaints. One cap changing state: a click toggles its pressed material,
/// then the next frame is timed (40 toggles). Prints means; --nocapture.
#[test]
#[ignore = "GPU benchmark; run explicitly"]
fn keycap_grid_bench() {
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    open(&mut doc, "stress");
    let mean = |v: &[Duration]| v.iter().sum::<Duration>().as_secs_f64() * 1e3 / v.len() as f64;
    for (painter_mode, mode) in [
        ("self", "one"),
        ("self", "keys"),
        ("sheet", "one"),
        ("sheet", "keys"),
        ("self", "one"),
        ("self", "keys"),
        ("sheet", "one"),
        ("sheet", "keys"),
    ] {
        painter(&mut doc, painter_mode);
        click(&mut doc, &format!("lab-fused-stress-{mode}"));
        scroll_to(&mut doc, "lab-fused-stress");
        for _ in 0..10 {
            out.frame(&mut doc);
        }
        std::thread::sleep(Duration::from_millis(300));
        for _ in 0..5 {
            out.frame(&mut doc);
        }
        assert!(
            !doc.inner().is_animating(),
            "{painter_mode} {mode}: static requests no frames"
        );
        let (layers, sheet, own) = plate_count(&doc);
        let (mut totals, mut scenes, mut binds, mut work, mut dirty) =
            (vec![], vec![], vec![], vec![], vec![]);
        for _ in 0..100 {
            let (w, px) = (render::surface_paint_work(), render::surface_dirty_pixels());
            let t = Instant::now();
            doc.layout_surfaces();
            binds.push(t.elapsed());
            let (_, scene, total) = out.frame(&mut doc);
            totals.push(total);
            scenes.push(scene);
            work.push(render::surface_paint_work() - w);
            dirty.push(render::surface_dirty_pixels() - px);
        }
        println!(
            "{painter_mode} {mode} static ({sheet} sheet plates in {layers} layers, {own} \
             self-painting): frame {:.2} ms, scene build {:.3} ms, surface paint {:.3} ms, \
             binding pass {:.1} us, dirty {} px total",
            mean(&totals),
            mean(&scenes),
            mean(&work),
            mean(&binds) * 1e3,
            dirty.iter().sum::<u64>(),
        );
        assert_eq!(
            dirty.iter().sum::<u64>(),
            0,
            "{painter_mode} {mode}: static re-renders nothing"
        );
        if mode == "one" {
            continue;
        }
        let (mut totals, mut scenes, mut work, mut dirty, mut handle) =
            (vec![], vec![], vec![], vec![], vec![]);
        for i in 0..40 {
            let cap = format!("lab-grid-cap-{}", 120 + i % 2);
            let t = Instant::now();
            // The click (JS handler, signal, attribute mutation) and the
            // restyle and relayout it causes.
            pointer_half(&mut doc, &cap, false);
            pointer_half(&mut doc, &cap, true);
            handle.push(t.elapsed());
            let (w, px) = (render::surface_paint_work(), render::surface_dirty_pixels());
            let (_, scene, total) = out.frame(&mut doc);
            totals.push(total);
            scenes.push(scene);
            work.push(render::surface_paint_work() - w);
            dirty.push(render::surface_dirty_pixels() - px);
            // Let any settle frames run out before the next toggle.
            for _ in 0..4 {
                out.frame(&mut doc);
            }
        }
        println!(
            "{painter_mode} {mode} one cap toggled: frame {:.2} ms (worst {:.2}), scene build \
             {:.3} ms, surface paint {:.3} ms, dirty {:.1} kpx/frame; click+restyle+bind {:.2} ms",
            mean(&totals),
            totals.iter().max().unwrap().as_secs_f64() * 1e3,
            mean(&scenes),
            mean(&work),
            dirty.iter().sum::<u64>() as f64 / dirty.len() as f64 / 1e3,
            mean(&handle),
        );
    }
    assert!(doc.take_error().is_none());
}

/// Plates in the document: (materials layers, plates those layers draw,
/// plates that paint themselves).
fn plate_count(doc: &NativeDocument) -> (usize, usize, usize) {
    let layers = doc
        .inner()
        .query_selector_all("tk-surface[materials]")
        .unwrap();
    let plates = layers.iter().map(|&l| doc.surface_shapes(l).len()).sum();
    (layers.len(), plates, doc.own_plate_count())
}

/// Every lab view as it opens (the Stress view stopped on variant A), with
/// each painter: the number of plates it draws and its static frame cost,
/// forced repaints with nothing changing. Each view must settle, request no
/// frames and re-render no pixel. Prints means; --nocapture.
#[test]
#[ignore = "GPU benchmark; run explicitly"]
fn lab_views_bench() {
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    let mean = |v: &[Duration]| v.iter().sum::<Duration>().as_secs_f64() * 1e3 / v.len() as f64;
    for mode in ["self", "sheet", "self", "sheet"] {
        painter(&mut doc, mode);
        for view in ["chat", "components", "surfaces", "stress"] {
            open(&mut doc, view);
            for _ in 0..10 {
                out.frame(&mut doc);
            }
            std::thread::sleep(Duration::from_millis(300));
            for _ in 0..5 {
                out.frame(&mut doc);
            }
            assert!(
                !doc.inner().is_animating(),
                "{mode} {view}: static requests no frames"
            );
            let (layers, sheet, own) = plate_count(&doc);
            let (mut totals, mut scenes, mut binds, mut work, mut dirty) =
                (vec![], vec![], vec![], vec![], vec![]);
            for _ in 0..100 {
                let (w, px) = (render::surface_paint_work(), render::surface_dirty_pixels());
                let t = Instant::now();
                doc.layout_surfaces();
                binds.push(t.elapsed());
                let (_, scene, total) = out.frame(&mut doc);
                totals.push(total);
                scenes.push(scene);
                work.push(render::surface_paint_work() - w);
                dirty.push(render::surface_dirty_pixels() - px);
            }
            println!(
                "{mode} view {view}: {layers} layers drawing {sheet} plates, {own} \
                 self-painting; static frame {:.2} ms, scene build {:.3} ms, surface paint \
                 {:.3} ms, binding pass {:.1} us, dirty {} px total",
                mean(&totals),
                mean(&scenes),
                mean(&work),
                mean(&binds) * 1e3,
                dirty.iter().sum::<u64>(),
            );
            assert_eq!(
                dirty.iter().sum::<u64>(),
                0,
                "{mode} {view}: static re-renders nothing"
            );
        }
    }
    assert!(doc.take_error().is_none());
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
        open(&mut doc, "surfaces");
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
        open(&mut doc, "surfaces");
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
            (Some(2.0), false, [8.0; 4])
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
        assert!(down.recessed, "active:recessed");
        assert!(
            !doc.inner().is_animating(),
            "a state change needs one frame"
        );
        pointer_half(&mut doc, "lab-bg-blue", true);
        // Clicked: it stays down (aria-pressed) until another one is picked.
        assert!(shape(&doc, "blue").recessed, "{mode}: the click arrived");
        pointer_half(&mut doc, "lab-bg-green", false);
        pointer_half(&mut doc, "lab-bg-green", true);
        assert!(shape(&doc, "green").recessed && !shape(&doc, "blue").recessed);
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
    open(&mut doc, "surfaces");
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

/// Captures for review (raw RGBA, see `capture_dir`): the keycap case at
/// rest, with the ordering row and the background buttons; then the
/// background buttons pressed (Run held down, Merge toggled down).
#[test]
#[ignore = "writes offscreen GPU captures; run explicitly"]
fn capture_plate_backgrounds() {
    let dir = capture_dir();
    let mut doc = document(2.0, 900.0);
    let mut out = Offscreen::new(2.0);
    open(&mut doc, "surfaces");
    scroll_to(&mut doc, "lab-keycaps");
    for name in ["lab-keycaps", "lab-bg-row"] {
        let r = doc
            .inner()
            .get_client_bounding_rect(support::id(&doc, name))
            .unwrap();
        println!("{name} css rect {} {} {} {}", r.x, r.y, r.width, r.height);
    }
    out.save_settled(&mut doc, &dir, "plates-keycaps-rest");
    pointer_half(&mut doc, "lab-bg-green", false);
    pointer_half(&mut doc, "lab-bg-green", true);
    pointer_half(&mut doc, "lab-bg-blue", false);
    out.save_settled(&mut doc, &dir, "plates-backgrounds-pressed");
    pointer_half(&mut doc, "lab-bg-blue", true);
    assert!(doc.take_error().is_none());
}
