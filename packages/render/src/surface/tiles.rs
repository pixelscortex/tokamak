//! What each pixel must evaluate, and what must be re-rendered when shapes
//! move. Both rest on one bound, `influence`: how far from its own outline a
//! shape can change a visible pixel.
//!
//! - Culling: the target is cut into 32 px tiles; each tile lists only the
//!   shapes whose influence reaches it. A pixel's cost is its neighbours, not
//!   the whole shape list (1000 squares in one surface cost what ~10 do).
//! - Partial re-render: when some shapes change, only the union of each
//!   changed shape's old and new influence is re-rendered; everything else in
//!   the cached target is kept.
//!
//! A shape farther away than its influence can still change the field's
//! value deep inside another shape, but never a painted pixel: deep interior
//! is flat fill either way. `tests.rs` checks culled == unculled pixel by
//! pixel, and that pixels outside a dirty rect do not change.
use super::shape::{Look, Shape};

/// Culling tile edge, device px. The shader reads it from the parameters.
pub(super) const CULL_TILE: u32 = 32;
/// More dirty rects than this are merged into their bounding box.
const MAX_DIRTY_RECTS: usize = 32;
/// Dirty area above this share of the target re-renders the whole target.
const FULL_RENDER_SHARE: f32 = 0.6;

/// How far (CSS px) beyond its own outline any shape can change a visible
/// pixel, before its own join and gap: the painted band outside the outline
/// (outside border), the bevel and border depth inside it, plus anti-aliasing
/// and the gradient sample.
fn reach(look: &Look) -> f32 {
    let (outer, inner) = look.border_edges();
    outer.max(0.0) + (-inner).max(0.0) + look.bevel.max(0.0) + 2.0
}

/// Padded bounds (x0, y0, x1, y1) of a shape's influence, CSS px.
pub(super) fn influence(look: &Look, s: &Shape) -> [f32; 4] {
    let gap = if s.sub { look.gap_of(s) } else { 0.0 };
    let pad = look.join_of(s) + gap + reach(look);
    let [x, y, w, h] = s.rect;
    [x - pad, y - pad, x + w + pad, y + h + pad]
}

/// Per-tile shape lists (CSR): `ranges[t] = [start, count]` into `indices`,
/// indices ascending within each tile.
pub(super) struct Tiles {
    pub nx: u32,
    pub ranges: Vec<[u32; 2]>,
    pub indices: Vec<u32>,
}

impl Tiles {
    pub fn build(shapes: &[Shape], look: &Look, width: u32, height: u32, scale: f32) -> Tiles {
        let nx = width.div_ceil(CULL_TILE).max(1);
        let ny = height.div_ceil(CULL_TILE).max(1);
        let span = |s: &Shape| {
            let [x0, y0, x1, y1] = influence(look, s);
            let t = CULL_TILE as f32;
            let tx0 = (x0 * scale / t).floor().max(0.0) as u32;
            let ty0 = (y0 * scale / t).floor().max(0.0) as u32;
            let tx1 = (x1 * scale / t).floor().min(nx as f32 - 1.0);
            let ty1 = (y1 * scale / t).floor().min(ny as f32 - 1.0);
            (tx1 >= 0.0 && ty1 >= 0.0 && tx0 < nx && ty0 < ny)
                .then_some((tx0, ty0, tx1 as u32, ty1 as u32))
                .filter(|(a, b, c, d)| a <= c && b <= d)
        };
        // Two passes: count per tile, then fill, so no per-tile allocations.
        let mut counts = vec![0u32; (nx * ny) as usize];
        for s in shapes {
            if let Some((x0, y0, x1, y1)) = span(s) {
                for ty in y0..=y1 {
                    for tx in x0..=x1 {
                        counts[(ty * nx + tx) as usize] += 1;
                    }
                }
            }
        }
        let mut ranges = Vec::with_capacity(counts.len());
        let mut start = 0;
        for c in &counts {
            ranges.push([start, 0]);
            start += c;
        }
        let mut indices = vec![0u32; start as usize];
        for (i, s) in shapes.iter().enumerate() {
            if let Some((x0, y0, x1, y1)) = span(s) {
                for ty in y0..=y1 {
                    for tx in x0..=x1 {
                        let r = &mut ranges[(ty * nx + tx) as usize];
                        indices[(r[0] + r[1]) as usize] = i as u32;
                        r[1] += 1;
                    }
                }
            }
        }
        Tiles {
            nx,
            ranges,
            indices,
        }
    }

    /// The shape list for device pixel (x, y).
    #[cfg(test)]
    pub fn list(&self, x: u32, y: u32) -> &[u32] {
        let tx = (x / CULL_TILE).min(self.nx - 1);
        let ny = self.ranges.len() as u32 / self.nx;
        let ty = (y / CULL_TILE).min(ny - 1);
        let [start, count] = self.ranges[(ty * self.nx + tx) as usize];
        &self.indices[start as usize..(start + count) as usize]
    }
}

/// Device-px rects (x, y, w, h) that must be re-rendered to go from `old` to
/// `new` under the same look and size, or None if a full render is required
/// (shape count or op changed) or cheaper (most of the target is dirty).
pub(super) fn dirty_rects(
    old: &[Shape],
    new: &[Shape],
    look: &Look,
    width: u32,
    height: u32,
    scale: f32,
) -> Option<Vec<[u32; 4]>> {
    if old.len() != new.len() {
        return None;
    }
    let mut rects: Vec<[f32; 4]> = Vec::new();
    for (a, b) in old.iter().zip(new) {
        if a == b {
            continue;
        }
        if a.sub != b.sub {
            return None;
        }
        let (ia, ib) = (influence(look, a), influence(look, b));
        rects.push([
            (ia[0].min(ib[0]) * scale).floor().max(0.0),
            (ia[1].min(ib[1]) * scale).floor().max(0.0),
            (ia[2].max(ib[2]) * scale).ceil().min(width as f32),
            (ia[3].max(ib[3]) * scale).ceil().min(height as f32),
        ]);
    }
    rects.retain(|r| r[2] > r[0] && r[3] > r[1]);
    // Merge overlapping rects until stable (overlaps would render twice).
    let overlaps =
        |a: &[f32; 4], b: &[f32; 4]| a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
    let mut merged = true;
    while merged {
        merged = false;
        'outer: for i in 0..rects.len() {
            for j in i + 1..rects.len() {
                if overlaps(&rects[i], &rects[j]) {
                    let b = rects.swap_remove(j);
                    let a = &mut rects[i];
                    *a = [
                        a[0].min(b[0]),
                        a[1].min(b[1]),
                        a[2].max(b[2]),
                        a[3].max(b[3]),
                    ];
                    merged = true;
                    break 'outer;
                }
            }
        }
    }
    if rects.len() > MAX_DIRTY_RECTS {
        let all = rects.iter().fold([f32::MAX, f32::MAX, 0.0, 0.0], |u, r| {
            [
                u[0].min(r[0]),
                u[1].min(r[1]),
                u[2].max(r[2]),
                u[3].max(r[3]),
            ]
        });
        rects = vec![all];
    }
    let area: f32 = rects.iter().map(|r| (r[2] - r[0]) * (r[3] - r[1])).sum();
    if area > FULL_RENDER_SHARE * (width * height) as f32 {
        return None;
    }
    Some(
        rects
            .iter()
            .map(|r| {
                [
                    r[0] as u32,
                    r[1] as u32,
                    (r[2] - r[0]) as u32,
                    (r[3] - r[1]) as u32,
                ]
            })
            .collect(),
    )
}
