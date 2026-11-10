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
//   6: culling tiles across, tile size (device px)
//   7 + 4i: rect x, y, w, h (CSS px; a poly's bounding box)
//   8 + 4i: corner radii tl, tr, br, bl
//   9 + 4i: op (0 add, 1 sub), join (<0 = default), gap (<0 = default), kind (0 box, 1 poly)
//  10 + 4i: poly: first corner slot, corner count, orientation (+1 clockwise on screen)
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
const STRIDE: u32 = 4u;
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
    let pos = in.pos.xy - vec2<f32>(f32(job.z), f32(job.w));
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
    let in_border = a_border > 0.0 && border.z > 0.5;
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
                c = tone(c, facing * (1.0 - t) * (1.0 - t), P(2).y, P(2).z);
            }
            if (in_border) {
                b = tone(b, facing, BORDER_LIT_GAIN, BORDER_SHADE_GAIN);
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
