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
        window_size: ((1160.0 * scale) as u32, (height * scale) as u32),
        hidpi_scale: scale,
        ..Default::default()
    });
    doc.inner_mut().resolve(0.0);
    doc
}

/// Clicks use page = client coordinates, so they happen at scroll 0.
fn click(doc: &mut NativeDocument, name: &str) {
    doc.inner_mut()
        .set_viewport_scroll(blitz_dom::Point { x: 0.0, y: 0.0 });
    support::pointer(doc, name);
}

fn scroll_to(doc: &mut NativeDocument, name: &str) {
    doc.inner_mut()
        .set_viewport_scroll(blitz_dom::Point { x: 0.0, y: 0.0 });
    doc.inner_mut().resolve(0.0);
    let rect = doc
        .inner()
        .get_client_bounding_rect(support::id(doc, name))
        .unwrap();
    doc.inner_mut().set_viewport_scroll(blitz_dom::Point {
        x: 0.0,
        y: rect.y - 16.0,
    });
    doc.inner_mut().resolve(0.0);
}

// ---------------------------------------------------------------- headless

/// Controls drawn above a surface stay clickable (the surface is a background
/// layer, not a hit target), and a rail click retargets the tab geometry.
#[test]
fn clicks_reach_controls_above_surfaces_and_move_the_rail_tab() {
    let mut doc = document(1.0, 900.0);
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
    let surface = support::id(&doc, "lab-fused-cutout-surface");
    let rect = doc.inner().get_client_bounding_rect(surface).unwrap();
    // Bring the surface into view, then aim at its top-left corner, which is
    // base colour (outside the plate) with no DOM content above it.
    doc.inner_mut().set_viewport_scroll(blitz_dom::Point {
        x: 0.0,
        y: rect.y - 100.0,
    });
    doc.inner_mut().resolve(0.0);
    let before = doc.inner().viewport_scroll().y;
    // Client coordinates are viewport-relative; page = client + scroll.
    let (x, client_y) = ((rect.x + 8.0) as f32, 108.0_f32);
    let page_y = client_y + before as f32;
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
    assert_ne!(doc.inner().viewport_scroll().y, before, "page scrolled");
}

/// The shell schedules frames only while `is_animating()`: the idle lab must
/// request none, a running stress demo must request them, and Stop must
/// return the document to no redraws.
#[test]
fn idle_and_stopped_surfaces_request_no_frames() {
    let mut doc = document(1.0, 900.0);
    assert!(!doc.inner().is_animating(), "idle lab requests no frames");
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

// ---------------------------------------------------------------- offscreen GPU

/// Offscreen frame source: the production paint path for a 1160x900 CSS
/// viewport at scale 2, like the lab window.
struct Offscreen {
    renderer: VelloImageRenderer,
    width: u32,
    height: u32,
    scale: f32,
}

impl Offscreen {
    fn new(scale: f32) -> Self {
        let (width, height) = ((1160.0 * scale) as u32, (900.0 * scale) as u32);
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
        doc.inner_mut().resolve(0.0);
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
