//! CPU reference evaluator, test builds only: the distance field and shading
//! of surface.wgsl, line by line in Rust, so tests can check geometry and
//! pixels (exact arcs, lighting, border, culling, partial redraw) without a
//! GPU. Not a runtime path: the product renders on the GPU only.
//!
//! Distances are CSS px, negative inside. Shapes combine in list order: `add`
//! is a union whose concave joins get a circular fillet of radius `join`
//! (exact where the two edges meet at 90 degrees), `sub` removes a shape and
//! rounds the convex corners that creates. A `sub` with a `gap` cuts the
//! shape grown by `gap` and keeps the shape itself as an island (a gap ring).
use super::gpu::{LIT_GAIN, SHADE_GAIN};
use super::shape::{Look, Poly, Shape, V2, cross2, dot2, len2, sub2};
use super::tiles::Tiles;

/// A `border-lit` border's gains (also hard-coded in surface.wgsl).
const BORDER_LIT_GAIN: f32 = 0.30;
const BORDER_SHADE_GAIN: f32 = 0.55;

/// Rounded rectangle with one radius per corner (tl, tr, br, bl).
fn rounded_box(p: V2, rect: [f32; 4], radii: [f32; 4]) -> f32 {
    let half = [rect[2] * 0.5, rect[3] * 0.5];
    let q = [p[0] - (rect[0] + half[0]), p[1] - (rect[1] + half[1])];
    let r = match (q[0] > 0.0, q[1] > 0.0) {
        (false, false) => radii[0],
        (true, false) => radii[1],
        (true, true) => radii[2],
        (false, true) => radii[3],
    }
    .min(half[0].min(half[1]));
    let d = [q[0].abs() - half[0] + r, q[1].abs() - half[1] + r];
    let outside = d[0].max(0.0).hypot(d[1].max(0.0));
    outside + d[0].max(d[1]).min(0.0) - r
}

impl Poly {
    /// Exact signed distance: the nearest straight edge or vertex arc, signed
    /// by that feature's inner side. Valid because the outline is C1 (arcs
    /// are tangent to their edges), so the nearest feature's side is the
    /// shape's side.
    fn distance(&self, p: V2) -> f32 {
        let n = self.corners.len();
        let (mut best, mut sign) = (f32::MAX, 1.0_f32);
        for i in 0..n {
            let k = &self.corners[i];
            // Edge from this corner's outgoing tangent to the next corner's
            // incoming tangent.
            let (a, b) = (k.t2, self.corners[(i + 1) % n].t1);
            let e = sub2(b, a);
            let w = sub2(p, a);
            let ee = dot2(e, e);
            if ee > 1e-12 {
                let t = (dot2(w, e) / ee).clamp(0.0, 1.0);
                let d = len2([w[0] - e[0] * t, w[1] - e[1] * t]);
                if d < best {
                    best = d;
                    let outward = [e[1] * self.orient, -e[0] * self.orient];
                    sign = if dot2(w, outward) > 0.0 { 1.0 } else { -1.0 };
                }
            }
            // The corner's arc, only where p projects onto it (inside the
            // cone spanned by the two tangent points, on the arc's side).
            if k.r > 0.0 {
                let (ca, cb, u) = (sub2(k.t1, k.c), sub2(k.t2, k.c), sub2(p, k.c));
                let span = cross2(ca, cb);
                let in_cone = cross2(ca, u) * span >= 0.0
                    && cross2(u, cb) * span >= 0.0
                    && dot2(u, [ca[0] + cb[0], ca[1] + cb[1]]) > 0.0;
                if in_cone {
                    let ru = len2(u);
                    let d = (ru - k.r).abs();
                    if d < best {
                        best = d;
                        let inside = if k.convex { ru < k.r } else { ru > k.r };
                        sign = if inside { -1.0 } else { 1.0 };
                    }
                }
            }
        }
        sign * best
    }
}

fn shape_distance(p: V2, s: &Shape) -> f32 {
    match &s.poly {
        Some(poly) => poly.distance(p),
        None => rounded_box(p, s.rect, s.radii),
    }
}

/// Union with a circular fillet of radius k where two boundaries meet.
fn union_round(a: f32, b: f32, k: f32) -> f32 {
    if k <= 0.0 {
        return a.min(b);
    }
    k.max(a.min(b)) - (k - a).max(0.0).hypot((k - b).max(0.0))
}

/// a minus b, with the new convex corners of the result rounded by k.
fn diff_round(a: f32, b: f32, k: f32) -> f32 {
    let nb = -b;
    if k <= 0.0 {
        return a.max(nb);
    }
    (-k).min(a.max(nb)) + (k + a).max(0.0).hypot((k + nb).max(0.0))
}

/// Field over the listed shapes. `list` holds ascending indices (a tile's
/// culled list, or every shape), so the CSG order of the attribute holds.
pub(super) fn field(shapes: &[Shape], list: &[u32], look: &Look, p: V2) -> f32 {
    let mut d = 1e6_f32;
    for &i in list {
        let s = &shapes[i as usize];
        let k = look.join_of(s);
        let sd = shape_distance(p, s);
        if !s.sub {
            d = union_round(d, sd, k);
        } else {
            let gap = look.gap_of(s);
            d = diff_round(d, sd - gap, k);
            if gap > 0.0 {
                d = d.min(sd); // the cut shape stays as an island
            }
        }
    }
    d
}

/// Straight-alpha RGBA for one device pixel centre at `p` (CSS px), using
/// the shapes in `list`. Mirrors `fs` in surface.wgsl.
pub(super) fn shade(shapes: &[Shape], list: &[u32], look: &Look, p: V2, scale: f32) -> [u8; 4] {
    let dc = field(shapes, list, look, p);
    let (outer, inner) = look.border_edges();
    // Coverage of the whole painted area and of the fill inside the border.
    let a_total = (0.5 - (dc - outer) * scale).clamp(0.0, 1.0);
    if a_total <= 0.0 {
        return [0; 4];
    }
    let d_fill = (dc - inner) * scale;
    let a_fill = (0.5 - d_fill).clamp(0.0, 1.0);
    let a_border = (a_total - a_fill).max(0.0);
    let mut c = [look.fill[0], look.fill[1], look.fill[2]];
    let border = look.border_rgba();
    let mut b = [border[0], border[1], border[2]];
    let bevel = look.bevel * scale;
    let in_bevel = bevel > 0.0 && d_fill > -bevel - 1.0;
    let in_border = a_border > 0.0 && look.border_lit > 0.0;
    if in_bevel || in_border {
        let e = 0.5 / scale;
        let gx = field(shapes, list, look, [p[0] + e, p[1]]) - dc;
        let gy = field(shapes, list, look, [p[0], p[1] + e]) - dc;
        let len = gx.hypot(gy);
        if len > 1e-6 {
            let l = look.light();
            let facing = (gx * l[0] + gy * l[1]) / len * look.sign();
            let tone = |v: &mut f32, s: f32, lit: f32, shade: f32| {
                *v = if s > 0.0 {
                    *v + (1.0 - *v) * lit * s
                } else {
                    *v * (1.0 + shade * s)
                }
            };
            if in_bevel {
                let t = (-d_fill / bevel).clamp(0.0, 1.0);
                let s = facing * (1.0 - t) * (1.0 - t);
                c.iter_mut().for_each(|v| tone(v, s, LIT_GAIN, SHADE_GAIN));
            }
            if in_border {
                b.iter_mut().for_each(|v| {
                    tone(
                        v,
                        facing * look.border_lit,
                        BORDER_LIT_GAIN,
                        BORDER_SHADE_GAIN,
                    )
                });
            }
        }
    }
    let (fa, ba) = (a_fill * look.fill[3], a_border * border[3]);
    let alpha = fa + ba;
    if alpha <= 0.0 {
        return [0; 4];
    }
    let mix = |f: f32, g: f32| (f * fa + g * ba) / alpha;
    let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    [
        byte(mix(c[0], b[0])),
        byte(mix(c[1], b[1])),
        byte(mix(c[2], b[2])),
        byte(alpha),
    ]
}

/// Whole target at device resolution, each pixel using its tile's culled
/// shape list, exactly as the shader does.
pub(super) fn raster(
    shapes: &[Shape],
    look: &Look,
    width: u32,
    height: u32,
    scale: f32,
) -> Vec<u8> {
    let tiles = Tiles::build(shapes, look, width, height, scale);
    let mut buf = vec![0u8; width as usize * height as usize * 4];
    for y in 0..height {
        for x in 0..width {
            let p = [(x as f32 + 0.5) / scale, (y as f32 + 0.5) / scale];
            let px = shade(shapes, tiles.list(x, y), look, p, scale);
            let i = (y as usize * width as usize + x as usize) * 4;
            buf[i..i + 4].copy_from_slice(&px);
        }
    }
    buf
}
