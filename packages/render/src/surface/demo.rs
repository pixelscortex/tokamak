//! Lab-only stress demo (`surface-demo` feature): motion generated and
//! advanced inside the widget, so the lab measures rendering cost and not the
//! JS-to-host wire. Not product code; the product build does not contain it.
//!
//! Attributes: `demo="bounce"` makes `count` rounded squares that bounce in
//! the box and fuse where they touch, of which only the first `moving` move
//! (default all); `demo="orbit"` moves one square on a small circle (phase
//! from `seed`). Motion advances only while `running` is present and not
//! `false`, and a demo with nothing to move requests no frames.
use super::shape::Shape;
use std::time::Instant;

const SQUARE: f32 = 26.0;
const MAX_COUNT: usize = 1024;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Bounce,
    Orbit,
}

/// One moving square of the bounce demo, CSS px and px/s.
#[derive(Clone, Copy)]
struct Body {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
}

/// The demo attributes and state of one surface.
pub(super) struct Driver {
    kind: Option<Kind>,
    count: usize,
    moving: usize,
    seed: u32,
    running: bool,
    bodies: Vec<Body>,
    /// Box and settings the bodies were generated for.
    built: Option<(f32, f32, usize, u32)>,
    phase: f32,
    last: Option<Instant>,
}

impl Default for Driver {
    fn default() -> Self {
        Self {
            kind: None,
            count: 16,
            moving: usize::MAX,
            seed: 1,
            running: false,
            bodies: Vec::new(),
            built: None,
            phase: 0.0,
            last: None,
        }
    }
}

impl Driver {
    /// Applies a demo attribute; false for names it does not own.
    pub fn set(&mut self, name: &str, value: Option<&str>) -> bool {
        let number = |fallback: f32| {
            value
                .and_then(|v| v.trim().parse::<f32>().ok())
                .filter(|v| v.is_finite())
                .unwrap_or(fallback)
        };
        match name {
            "demo" => {
                self.kind = match value {
                    Some("bounce") => Some(Kind::Bounce),
                    Some("orbit") => Some(Kind::Orbit),
                    _ => None,
                };
                self.built = None;
            }
            "count" => self.count = (number(16.0).max(1.0) as usize).min(MAX_COUNT),
            "seed" => self.seed = number(1.0).max(0.0) as u32,
            "moving" => {
                self.moving = match value {
                    None | Some("all") => usize::MAX,
                    Some(_) => number(0.0).max(0.0) as usize,
                }
            }
            "running" => {
                self.running = value.is_some_and(|v| v != "false");
                self.last = None;
            }
            _ => return false,
        }
        true
    }

    pub fn moves(&self) -> bool {
        match self.kind {
            Some(Kind::Orbit) => self.running,
            Some(Kind::Bounce) => self.running && self.moving > 0,
            None => false,
        }
    }

    /// The demo's shapes for this paint, or None to keep `shown` as it is
    /// (unchanged shapes keep the surface cached).
    pub fn shapes(
        &mut self,
        width: u32,
        height: u32,
        scale: f64,
        shown: &[Shape],
    ) -> Option<Vec<Shape>> {
        let kind = self.kind?;
        let (w, h) = (width as f32 / scale as f32, height as f32 / scale as f32);
        let key = (w, h, self.count, self.seed);
        let rebuilt = self.built != Some(key);
        if rebuilt {
            self.spawn(w, h);
            self.built = Some(key);
        }
        if !rebuilt && !self.moves() && !shown.is_empty() {
            return None;
        }
        let dt = match (self.moves(), self.last) {
            (true, Some(last)) => last.elapsed().as_secs_f32().min(0.05),
            _ => 0.0,
        };
        self.last = self.moves().then(Instant::now);
        let next = match kind {
            Kind::Bounce => {
                let (mx, my) = ((w - SQUARE).max(0.0), (h - SQUARE).max(0.0));
                for b in self.bodies.iter_mut().take(self.moving) {
                    b.x += b.vx * dt;
                    b.y += b.vy * dt;
                    if b.x < 0.0 || b.x > mx {
                        b.vx = -b.vx;
                        b.x = b.x.clamp(0.0, mx);
                    }
                    if b.y < 0.0 || b.y > my {
                        b.vy = -b.vy;
                        b.y = b.y.clamp(0.0, my);
                    }
                }
                self.bodies
                    .iter()
                    .map(|b| Shape::rect(false, [b.x, b.y, SQUARE, SQUARE], [7.0; 4]))
                    .collect()
            }
            Kind::Orbit => {
                self.phase += dt * 2.4;
                let a = self.phase + self.seed as f32 * 0.7;
                let side = (w.min(h) * 0.6).max(1.0);
                let reach = (w.min(h) - side) * 0.5 * 0.8;
                vec![Shape::rect(
                    false,
                    [
                        (w - side) * 0.5 + a.cos() * reach,
                        (h - side) * 0.5 + a.sin() * reach,
                        side,
                        side,
                    ],
                    [side * 0.25; 4],
                )]
            }
        };
        (next != shown).then_some(next)
    }

    /// Small deterministic generator so every run starts identically.
    fn spawn(&mut self, w: f32, h: f32) {
        let mut state = self.seed.wrapping_mul(2_654_435_761).max(1);
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as f32 / u32::MAX as f32
        };
        self.bodies = (0..self.count)
            .map(|_| {
                let angle = next() * std::f32::consts::TAU;
                let speed = 40.0 + next() * 90.0;
                Body {
                    x: next() * (w - SQUARE).max(0.0),
                    y: next() * (h - SQUARE).max(0.0),
                    vx: angle.cos() * speed,
                    vy: angle.sin() * speed,
                }
            })
            .collect();
    }
}
