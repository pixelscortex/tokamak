// `<tk-surface>` on the GPU: signed distance field and shading for one or
// many surfaces per pass (see gpu.rs). The CPU reference (reference.rs:
// `field`, `shape_distance`, `rounded_box`, `Poly::distance`, `union_round`,
// `diff_round`, `shade`) is the same maths line by line; keep the two in step,
// since the tests check the reference.
//
// Binding 0, parameters (vec4 slots, see `encode` in gpu.rs):
//   0: width px, height px, scale, shape count
//   1: bevel px, light x, light y, elevation sign (+1 raised, -1 recessed)
//   2: default join, lit gain, shade gain, default gap
//   3: fill rgba (straight alpha, sRGB-encoded values, no linearisation)
//   4: border outer edge, inner edge (CSS px from the silhouette), lit, enabled
//   5: border rgba
//   6: culling tiles across, tile size (device px), materials layer (1 = layered),
//      bevel profile and strength (strength 0..1, plus 2 when soft)
//   7 + 5i: rect x, y, w, h (CSS px; a poly's bounding box)
//   8 + 5i: corner radii tl, tr, br, bl
//   9 + 5i: op (0 add, 1 sub), join (<0 = default), gap (<0 = default), kind (0 box, 1 poly);
//           in a materials layer: bevel profile and strength (strength 0..1, plus 2 when soft), bevel (device px), elevation sign, kind
//  10 + 5i: poly: first corner slot, corner count, orientation (+1 clockwise on screen);
//           a box in a materials layer: elevation side (CSS px, negative when pressed)
//  11 + 5i: materials layer only: the shape's fill rgba
//   then poly corners, 2 slots each: (centre x, centre y, radius, convex),
//   (tangent-in x, y, tangent-out x, y).
// Binding 1, per-tile shape lists: [start, count] per tile, then indices.
// Binding 2, one record per draw instance: (params base slot, tile words
// base, target x, y). Every slot/word index above is relative to its job's
// bases, so one pass can render many surfaces (atlas slots) at once.

struct Params {
    data: array<vec4<f32>>,
};

struct Tiles {
    words: array<u32>,
};

@group(0) @binding(0) var<storage, read> u: Params;
@group(0) @binding(1) var<storage, read> tiles: Tiles;
@group(0) @binding(2) var<storage, read> jobs: array<vec4<u32>>;

var<private> PB: u32;
var<private> TB: u32;

fn P(i: u32) -> vec4<f32> {
    return u.data[PB + i];
}

fn W(i: u32) -> u32 {
    return tiles.words[TB + i];
}

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) @interpolate(flat) job: u32,
};

const HEADER: u32 = 7u;
const STRIDE: u32 = 5u;
const BORDER_LIT_GAIN: f32 = 0.30;
const BORDER_SHADE_GAIN: f32 = 0.55;

// One oversized triangle covers the whole target; no vertex buffer.
// The draw's scissor rect selects the pixels; the instance picks the job.
@vertex
fn vs(@builtin(vertex_index) i: u32, @builtin(instance_index) job: u32) -> VOut {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VOut;
    out.pos = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    out.job = job;
    return out;
}

fn rounded_box(p: vec2<f32>, rect: vec4<f32>, radii: vec4<f32>) -> f32 {
    let half = rect.zw * 0.5;
    let q = p - (rect.xy + half);
    // y grows downward: q.y <= 0 is the top half.
    let top = select(radii.x, radii.y, q.x > 0.0);
    let bottom = select(radii.w, radii.z, q.x > 0.0);
    let r = min(select(top, bottom, q.y > 0.0), min(half.x, half.y));
    let d = abs(q) - half + vec2<f32>(r);
    return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0) - r;
}

fn cross2(a: vec2<f32>, b: vec2<f32>) -> f32 {
    return a.x * b.y - a.y * b.x;
}

// Exact signed distance to a closed outline of straight edges joined by
// tangent arcs: nearest segment or arc, signed by that feature's inner side.
fn poly_distance(p: vec2<f32>, first: u32, n: u32, orient: f32) -> f32 {
    var best = 1e30;
    var sign = 1.0;
    for (var i = 0u; i < n; i = i + 1u) {
        let arc = P(first + i * 2u);
        let tan_k = P(first + i * 2u + 1u);
        let next = P(first + ((i + 1u) % n) * 2u + 1u);
        let a = tan_k.zw;
        let b = next.xy;
        let e = b - a;
        let w = p - a;
        let ee = dot(e, e);
        if (ee > 1e-12) {
            let t = clamp(dot(w, e) / ee, 0.0, 1.0);
            let d = length(w - e * t);
            if (d < best) {
                best = d;
                let outward = vec2<f32>(e.y, -e.x) * orient;
                sign = select(-1.0, 1.0, dot(w, outward) > 0.0);
            }
        }
        let r = arc.z;
        if (r > 0.0) {
            let ca = tan_k.xy - arc.xy;
            let cb = tan_k.zw - arc.xy;
            let uu = p - arc.xy;
            let span = cross2(ca, cb);
            let in_cone = cross2(ca, uu) * span >= 0.0 && cross2(uu, cb) * span >= 0.0
                && dot(uu, ca + cb) > 0.0;
            if (in_cone) {
                let ru = length(uu);
                let d = abs(ru - r);
                if (d < best) {
                    best = d;
                    let convex = arc.w > 0.5;
                    let within = ru < r;
                    let inside = (convex && within) || (!convex && !within);
                    sign = select(1.0, -1.0, inside);
                }
            }
        }
    }
    return sign * best;
}

// Circular fillet of radius k where two boundaries meet (exact at 90 deg).
fn union_round(a: f32, b: f32, k: f32) -> f32 {
    if (k <= 0.0) {
        return min(a, b);
    }
    let w = max(vec2<f32>(k - a, k - b), vec2<f32>(0.0));
    return max(k, min(a, b)) - length(w);
}

// a minus b, with the new convex corners of the result rounded by k.
fn diff_round(a: f32, b: f32, k: f32) -> f32 {
    let nb = -b;
    if (k <= 0.0) {
        return max(a, nb);
    }
    let w = max(vec2<f32>(k + a, k + nb), vec2<f32>(0.0));
    return min(-k, max(a, nb)) + length(w);
}

// Field over this tile's shape list (ascending, so CSG order holds).
fn field(p: vec2<f32>, start: u32, count: u32) -> f32 {
    let default_join = P(2).x;
    let default_gap = P(2).w;
    var d = 1e6;
    for (var k = 0u; k < count; k = k + 1u) {
        let i = W(start + k);
        let base = HEADER + i * STRIDE;
        let rect = P(base);
        let info = P(base + 2u);
        let kj = select(default_join, info.y, info.y >= 0.0);
        var s = 0.0;
        if (info.w > 0.5) {
            let poly = P(base + 3u);
            s = poly_distance(p, u32(poly.x), u32(poly.y), poly.z);
        } else {
            s = rounded_box(p, rect, P(base + 1u));
        }
        if (info.x < 0.5) {
            d = union_round(d, s, kj);
        } else {
            let gap = select(default_gap, info.z, info.z >= 0.0);
            d = diff_round(d, s - gap, kj);
            if (gap > 0.0) {
                // The cut shape stays as an island inside its gap ring.
                d = min(d, s);
            }
        }
    }
    return d;
}

// One shape's own signed distance (materials layer).
fn shape_at(p: vec2<f32>, base: u32) -> f32 {
    if (P(base + 2u).w > 0.5) {
        let poly = P(base + 3u);
        return poly_distance(p, u32(poly.x), u32(poly.y), poly.z);
    }
    return rounded_box(p, P(base), P(base + 1u));
}

// The face of an elevated plate: its box without the strip of `side` CSS px
// that shows the plate's side (under the face, or above it when pressed).
fn face_at(p: vec2<f32>, base: u32, side: f32) -> f32 {
    var rect = P(base);
    let h = min(abs(side), rect.w * 0.5);
    rect.w = rect.w - h;
    if (side < 0.0) {
        rect.y = rect.y + h;
    }
    return rounded_box(p, rect, P(base + 1u));
}

// Materials layer: no CSG. Each shape of the tile, in order, is shaded with
// its own fill, bevel and elevation, then painted over what is below it
// (premultiplied "over"). A tray and the caps in it are one layer.
fn layered(p: vec2<f32>, start: u32, count: u32, scale: f32) -> vec4<f32> {
    var acc = vec4<f32>(0.0);
    let light = P(1).yz;
    for (var k = 0u; k < count; k = k + 1u) {
        let base = HEADER + W(start + k) * STRIDE;
        let s = shape_at(p, base);
        let d = s * scale;
        let a = clamp(0.5 - d, 0.0, 1.0);
        if (a <= 0.0) {
            continue;
        }
        let info = P(base + 2u);
        let fill = P(base + 4u);
        var c = fill.rgb;
        let bevel = info.y;
        // Elevation: the bevel belongs to the face; outside the face, inside
        // the outline, is the plate's side.
        let side = select(0.0, P(base + 3u).x, info.w < 0.5);
        var sf = s;
        if (side != 0.0) {
            sf = face_at(p, base, side);
        }
        let df = sf * scale;
        if (bevel > 0.0 && df > -bevel - 1.0) {
            let e = 0.5 / scale;
            var g = vec2<f32>(0.0);
            if (side != 0.0) {
                g = vec2<f32>(
                    face_at(p + vec2<f32>(e, 0.0), base, side) - sf,
                    face_at(p + vec2<f32>(0.0, e), base, side) - sf,
                );
            } else {
                g = vec2<f32>(
                    shape_at(p + vec2<f32>(e, 0.0), base) - s,
                    shape_at(p + vec2<f32>(0.0, e), base) - s,
                );
            }
            let len = length(g);
            if (len > 1e-6) {
                let facing = dot(g / len, light) * info.z;
                let t = clamp(-df / bevel, 0.0, 1.0);
                c = tone(c, facing * profile(t, bevel, info.x), P(2).y, P(2).z);
            }
        }
        if (side != 0.0) {
            // A faint line all round the face, then the side strip in a
            // darker tone of the fill (darker still when pressed: a hole).
            let face = clamp(0.5 - df, 0.0, 1.0);
            let hair = clamp(df + scale, 0.0, 1.0);
            c = c + (vec3<f32>(1.0) - c) * (0.09 * hair);
            let dark = select(0.58, 0.40, side < 0.0);
            c = mix(fill.rgb * dark, c, face);
        }
        let fa = a * fill.a;
        acc = vec4<f32>(c * fa, fa) + acc * (1.0 - fa);
    }
    if (acc.a <= 0.0) {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(acc.rgb / acc.a, acc.a);
}

// How strongly the bevel shows at `t` (0 at the outline, 1 at the inner end
// of a band `bevel` device px wide). `slot` packs the strength (0..1, the
// sine of the edge's tilt) and the profile (plus 2 when soft). Sharp: full
// strength across the band, ending within one device pixel. Soft: fading
// inward.
fn profile(t: f32, bevel: f32, slot: f32) -> f32 {
    if (slot >= 2.0) {
        return (slot - 2.0) * (1.0 - t) * (1.0 - t);
    }
    return slot * clamp((1.0 - t) * bevel, 0.0, 1.0);
}

fn tone(c: vec3<f32>, s: f32, lit: f32, shade: f32) -> vec3<f32> {
    if (s > 0.0) {
        return c + (vec3<f32>(1.0) - c) * (lit * s);
    }
    return c * (1.0 + shade * s);
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
    let job = jobs[in.job];
    PB = job.x;
    TB = job.y;
    // The job's origin in the target, signed: an atlas slot's offset, or
    // minus an own tile's position in the surface.
    let pos = in.pos.xy - vec2<f32>(f32(bitcast<i32>(job.z)), f32(bitcast<i32>(job.w)));
    let scale = P(0).z;
    let tiling = P(6);
    let tx = u32(pos.x / tiling.y);
    let ty = u32(pos.y / tiling.y);
    let tile = (ty * u32(tiling.x) + tx) * 2u;
    let start = W(tile);
    let count = W(tile + 1u);
    if (count == 0u) {
        return vec4<f32>(0.0);
    }
    let p = pos.xy / scale;
    if (tiling.z > 0.5) {
        return layered(p, start, count, scale);
    }
    let dc = field(p, start, count);
    let border = P(4);
    let a_total = clamp(0.5 - (dc - border.x) * scale, 0.0, 1.0);
    if (a_total <= 0.0) {
        return vec4<f32>(0.0);
    }
    let d_fill = (dc - border.y) * scale;
    let a_fill = clamp(0.5 - d_fill, 0.0, 1.0);
    let a_border = max(a_total - a_fill, 0.0);
    var c = P(3).rgb;
    var b = P(5).rgb;
    let bevel = P(1).x;
    let in_bevel = bevel > 0.0 && d_fill > -bevel - 1.0;
    let in_border = a_border > 0.0 && border.z > 0.0;
    if (in_bevel || in_border) {
        let e = 0.5 / scale;
        let g = vec2<f32>(
            field(p + vec2<f32>(e, 0.0), start, count) - dc,
            field(p + vec2<f32>(0.0, e), start, count) - dc,
        );
        let len = length(g);
        if (len > 1e-6) {
            let facing = dot(g / len, P(1).yz) * P(1).w;
            if (in_bevel) {
                let t = clamp(-d_fill / bevel, 0.0, 1.0);
                c = tone(c, facing * profile(t, bevel, P(6).w), P(2).y, P(2).z);
            }
            if (in_border) {
                // `border-lit` scales the swing: 0 flat, 1 fully lit.
                b = tone(b, facing * border.z, BORDER_LIT_GAIN, BORDER_SHADE_GAIN);
            }
        }
    }
    let fa = a_fill * P(3).a;
    let ba = a_border * P(5).a;
    let alpha = fa + ba;
    if (alpha <= 0.0) {
        return vec4<f32>(0.0);
    }
    return vec4<f32>((c * fa + b * ba) / alpha, alpha);
}
