//! Lab-only (`surface-demo` feature): `<tk-fps>`, a frame-rate readout as a
//! Blitz custom widget. Blitz calls `paint` on every custom widget once per
//! presented frame, so the interval between paints is the frame interval.
//! Digits are drawn as seven-segment rects straight into the Scene, so no text
//! shaping is needed.
//!
//! Rows: frames per second, ms per frame (paint to paint), ms spent in
//! `<tk-surface>` paints per frame (CPU side: geometry, culling lists, buffer
//! uploads, command encoding; the shader itself runs on the GPU later), the
//! thousands of device pixels re-rendered per frame across all surfaces, and
//! a running frame counter.
//!
//! Idle: a widget cannot paint while nothing redraws, so "idle" is shown on
//! the last frame instead. While any surface animates or runs a demo the
//! widget keeps redrawing for `LINGER` past the last such frame, then paints a
//! final frame reading `IdLE` and stops; the frame counter then stays still.
//! A one-off redraw (hover, typing) also reads `IdLE`, because it is not
//! continuous redrawing.
use super::stats::{ACTIVE_AT_MS, DIRTY_PX, PAINT_WORK_NS, epoch_ms};
use anyrender::{PaintScene, RenderContext, Scene};
use blitz_dom::node::{ComputedStyles, Widget};
use peniko::{
    Color, Fill,
    kurbo::{Affine, Rect},
};
use std::{
    collections::VecDeque,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

pub(super) const TAG: &str = "tk-fps";

/// How long after the last active surface frame the readout keeps redrawing.
const LINGER_MS: u64 = 300;
/// A surface frame older than this means "not continuously redrawing".
const ACTIVE_MS: u64 = 250;
const WINDOW: Duration = Duration::from_secs(1);

pub(super) fn widget() -> Box<dyn Widget> {
    Box::new(Fps::default())
}

struct Sample {
    at: Instant,
    /// Interval to the previous paint.
    interval: Duration,
    /// Surface paint time and pixels re-rendered since the previous paint.
    work: Duration,
    dirty: u64,
}

#[derive(Default)]
struct Fps {
    last: Option<Instant>,
    history: VecDeque<Sample>,
    work_seen: u64,
    dirty_seen: u64,
    frames: u64,
}

fn since_active_ms() -> Option<u64> {
    let at = ACTIVE_AT_MS.load(Ordering::Relaxed);
    (at != 0).then(|| epoch_ms().saturating_sub(at))
}

impl Widget for Fps {
    fn requires_redraw(&self) -> bool {
        since_active_ms().is_some_and(|ms| ms < LINGER_MS)
    }

    fn paint(
        &mut self,
        _render_ctx: &mut dyn RenderContext,
        _styles: &ComputedStyles,
        _width: u32,
        _height: u32,
        scale: f64,
    ) -> Scene {
        let now = Instant::now();
        self.frames += 1;
        let total = PAINT_WORK_NS.load(Ordering::Relaxed);
        let work = Duration::from_nanos(total.saturating_sub(self.work_seen));
        self.work_seen = total;
        let dirty_total = DIRTY_PX.load(Ordering::Relaxed);
        let dirty = dirty_total.saturating_sub(self.dirty_seen);
        self.dirty_seen = dirty_total;
        let active = since_active_ms().is_some_and(|ms| ms < ACTIVE_MS);
        if let (true, Some(last)) = (active, self.last) {
            self.history.push_back(Sample {
                at: now,
                interval: now - last,
                work,
                dirty,
            });
        }
        if !active {
            self.history.clear();
        }
        while self.history.front().is_some_and(|s| now - s.at > WINDOW) {
            self.history.pop_front();
        }
        self.last = Some(now);

        let rows: [String; 5] = if self.history.is_empty() {
            [
                "IdLE".into(),
                "----".into(),
                "----".into(),
                "----".into(),
                counter(self.frames),
            ]
        } else {
            let n = self.history.len() as f64;
            let span: f64 = self.history.iter().map(|h| h.interval.as_secs_f64()).sum();
            let surf: f64 = self.history.iter().map(|h| h.work.as_secs_f64()).sum();
            let px: u64 = self.history.iter().map(|h| h.dirty).sum();
            [
                format!("{:.0}", n / span),
                format!("{:.1}", span / n * 1e3),
                format!("{:.2}", surf / n * 1e3),
                format!("{:.0}", px as f64 / n / 1e3),
                counter(self.frames),
            ]
        };
        let colour = if self.history.is_empty() {
            Color::from_rgb8(0x6c, 0x6c, 0x70)
        } else {
            Color::from_rgb8(0xed, 0xed, 0xee)
        };
        let mut scene = Scene::new();
        for (i, row) in rows.iter().enumerate() {
            draw_text(&mut scene, row, 0.0, i as f64 * ROW, scale, colour);
        }
        scene
    }
}

fn counter(frames: u64) -> String {
    format!("{}", frames % 100_000)
}

// Seven-segment glyphs, CSS px. Segments in order a b c d e f g.
const DIGIT_W: f64 = 10.0;
const DIGIT_H: f64 = 18.0;
const STROKE: f64 = 2.2;
const ADVANCE: f64 = 14.0;
const ROW: f64 = 26.0;

fn segments(c: char) -> u8 {
    match c {
        '0' => 0b1111110,
        '1' => 0b0110000,
        '2' => 0b1101101,
        '3' => 0b1111001,
        '4' => 0b0110011,
        '5' => 0b1011011,
        '6' => 0b1011111,
        '7' => 0b1110000,
        '8' => 0b1111111,
        '9' => 0b1111011,
        '-' => 0b0000001,
        'I' => 0b0000110,
        'd' => 0b0111101,
        'L' => 0b0001110,
        'E' => 0b1001111,
        _ => 0,
    }
}

fn draw_text(scene: &mut Scene, text: &str, x0: f64, y0: f64, scale: f64, colour: Color) {
    let mut fill = |x: f64, y: f64, w: f64, h: f64| {
        let r = Rect::new(x * scale, y * scale, (x + w) * scale, (y + h) * scale);
        scene.fill(Fill::NonZero, Affine::IDENTITY, colour, None, &r);
    };
    let (t, w) = (STROKE, DIGIT_W);
    let v = (DIGIT_H - 3.0 * t) / 2.0;
    let mut x = x0;
    for c in text.chars() {
        if c == '.' {
            fill(x - 2.0, y0 + DIGIT_H - t, t, t);
            x += 4.0;
            continue;
        }
        let bits = segments(c);
        let on = |i: u8| bits & (1 << (6 - i)) != 0;
        let y = y0;
        if on(0) {
            fill(x + t, y, w - 2.0 * t, t);
        }
        if on(1) {
            fill(x + w - t, y + t, t, v);
        }
        if on(2) {
            fill(x + w - t, y + 2.0 * t + v, t, v);
        }
        if on(3) {
            fill(x + t, y + 2.0 * t + 2.0 * v, w - 2.0 * t, t);
        }
        if on(4) {
            fill(x, y + 2.0 * t + v, t, v);
        }
        if on(5) {
            fill(x, y + t, t, v);
        }
        if on(6) {
            fill(x + t, y + t + v, w - 2.0 * t, t);
        }
        x += ADVANCE;
    }
}
