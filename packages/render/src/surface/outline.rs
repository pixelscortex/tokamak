//! Rounded geometry builders and ordered boolean outlines.
use super::{Placed, Side};
use geo::{Area, BooleanOps, Buffer, Coord, LineString, MultiPolygon, Polygon, Simplify};
use peniko::kurbo::{Arc as CurveArc, BezPath, PathEl};
use std::sync::Arc;
pub(super) type V2 = [f32; 2];

pub(super) fn sub2(a: V2, b: V2) -> V2 {
    [a[0] - b[0], a[1] - b[1]]
}
pub(super) fn dot2(a: V2, b: V2) -> f32 {
    a[0] * b[0] + a[1] * b[1]
}
pub(super) fn cross2(a: V2, b: V2) -> f32 {
    a[0] * b[1] - a[1] * b[0]
}
pub(super) fn len2(a: V2) -> f32 {
    a[0].hypot(a[1])
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Corner {
    pub c: V2,
    pub r: f32,
    pub convex: bool,
    pub t1: V2,
    pub t2: V2,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Poly {
    pub points: Vec<[f32; 3]>,
    pub corners: Vec<Corner>,
    pub orient: f32,
}

const MIN_ARC: f32 = 0.01;

impl Poly {
    pub fn new(points: Vec<[f32; 3]>) -> Option<Poly> {
        let n = points.len();
        if n < 3 {
            return None;
        }
        let at = |i: usize| [points[i % n][0], points[i % n][1]];
        let area2: f32 = (0..n).map(|i| cross2(at(i), at(i + 1))).sum();
        if area2.abs() < 1e-6 {
            return None;
        }
        let orient = area2.signum();
        let tangents: Vec<_> = (0..n)
            .map(|i| {
                let (p, v, nx) = (at(i + n - 1), at(i), at(i + 1));
                let (a, b) = (sub2(p, v), sub2(nx, v));
                let half = (dot2(a, b) / (len2(a) * len2(b))).clamp(-1.0, 1.0).acos() * 0.5;
                points[i][2].max(MIN_ARC) / half.tan()
            })
            .collect();
        let factor = (0..n).fold(1.0f32, |f, i| {
            f.min(len2(sub2(at(i + 1), at(i))) / (tangents[i] + tangents[(i + 1) % n]))
        });
        let corners = (0..n)
            .map(|i| {
                let (p, v, nx) = (at(i + n - 1), at(i), at(i + 1));
                let (l1, l2) = (len2(sub2(p, v)), len2(sub2(nx, v)));
                let flat = Corner {
                    c: v,
                    r: 0.0,
                    convex: true,
                    t1: v,
                    t2: v,
                };
                if l1 < 1e-6 || l2 < 1e-6 {
                    return flat;
                }
                let e1 = [(p[0] - v[0]) / l1, (p[1] - v[1]) / l1];
                let e2 = [(nx[0] - v[0]) / l2, (nx[1] - v[1]) / l2];
                let half = dot2(e1, e2).clamp(-1.0, 1.0).acos() * 0.5;
                if half > std::f32::consts::FRAC_PI_2 - 1e-4 {
                    return flat; // collinear: no corner to round
                }
                let r = points[i][2].max(MIN_ARC) * factor;
                let t = r / half.tan();
                let bis = [e1[0] + e2[0], e1[1] + e2[1]];
                let bl = len2(bis);
                let reach = r / half.sin();
                Corner {
                    c: [v[0] + bis[0] / bl * reach, v[1] + bis[1] / bl * reach],
                    r,
                    convex: cross2(sub2(v, p), sub2(nx, v)) * orient > 0.0,
                    t1: [v[0] + e1[0] * t, v[1] + e1[1] * t],
                    t2: [v[0] + e2[0] * t, v[1] + e2[1] * t],
                }
            })
            .collect();
        Some(Poly {
            points,
            corners,
            orient,
        })
    }

    pub fn bounds(&self) -> [f32; 4] {
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for p in &self.points {
            x0 = x0.min(p[0]);
            y0 = y0.min(p[1]);
            x1 = x1.max(p[0]);
            y1 = y1.max(p[1]);
        }
        [x0, y0, x1 - x0, y1 - y0]
    }

    pub fn lerp(a: &Poly, b: &Poly, t: f32) -> Option<Poly> {
        if a.points.len() != b.points.len() {
            return None;
        }
        Poly::new(
            a.points
                .iter()
                .zip(&b.points)
                .map(|(p, q)| std::array::from_fn(|i| p[i] + (q[i] - p[i]) * t))
                .collect(),
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Shape {
    pub sub: bool,
    pub rect: [f32; 4],
    pub radii: [f32; 4],
    pub join: f32,
    pub poly: Option<Arc<Poly>>,
}

impl Shape {
    pub fn rect(sub: bool, rect: [f32; 4], radii: [f32; 4]) -> Shape {
        Shape {
            sub,
            rect,
            radii: normalized_radii(rect, radii),
            join: 0.0,
            poly: None,
        }
    }

    pub fn from_poly(sub: bool, poly: Poly) -> Shape {
        Shape {
            rect: poly.bounds(),
            poly: Some(Arc::new(poly)),
            ..Shape::rect(sub, [0.0; 4], [0.0; 4])
        }
    }

    pub fn lerp(a: &Shape, b: &Shape, t: f32) -> Shape {
        let mix = |x: f32, y: f32| x + (y - x) * t;
        let mix4 = |x: [f32; 4], y: [f32; 4]| std::array::from_fn(|i| mix(x[i], y[i]));
        let poly = match (&a.poly, &b.poly) {
            (Some(pa), Some(pb)) => Poly::lerp(pa, pb, t).map(Arc::new).or(b.poly.clone()),
            _ => b.poly.clone(),
        };
        Shape {
            sub: b.sub,
            rect: match &poly {
                Some(p) => p.bounds(),
                None => mix4(a.rect, b.rect),
            },
            radii: mix4(a.radii, b.radii),
            join: mix(a.join, b.join),
            poly,
        }
    }
}

pub(super) fn resolve_attached(list: &mut [Placed]) {
    let targets: Vec<Shape> = list
        .iter()
        .filter(|((sub, attached, ..), s, ..)| !sub && !attached && s.poly.is_none())
        .map(|(_, s, ..)| s.clone())
        .collect();
    for (_, shape, _, attach) in list.iter_mut() {
        let Some(a) = attach else { continue };
        let [x, y, w, h] = a.rect;
        let target = targets.iter().find(|t| {
            let [tx, ty, tw, th] = t.rect;
            let along_y = ty < y + h && ty + th > y;
            let along_x = tx < x + w && tx + tw > x;
            match a.side {
                Side::Right => (tx - (x + w)).abs() < 0.5 && along_y,
                Side::Left => (tx + tw - x).abs() < 0.5 && along_y,
                Side::Bottom => (ty - (y + h)).abs() < 0.5 && along_x,
                Side::Top => (ty + th - y).abs() < 0.5 && along_x,
            }
        });
        if let Some(outline) =
            target.and_then(|t| attached(a.side, a.rect, a.radii, a.join, t.rect, t.radii))
        {
            *shape = outline;
        }
    }
}

pub(super) fn attached(
    side: Side,
    rect: [f32; 4],
    radii: [f32; 4],
    join: f32,
    target: [f32; 4],
    target_radii: [f32; 4],
) -> Option<Shape> {
    let radii = normalized_radii(rect, radii);
    let target_radii = normalized_radii(target, target_radii);
    let points = match side {
        Side::Left | Side::Right => attached_points(side, rect, radii, join, target, target_radii),
        Side::Top | Side::Bottom => {
            let t = |r: [f32; 4]| [r[1], r[0], r[3], r[2]];
            let corners = |r: [f32; 4]| [r[0], r[3], r[2], r[1]];
            let along = if side == Side::Bottom {
                Side::Right
            } else {
                Side::Left
            };
            let mut points = attached_points(
                along,
                t(rect),
                corners(radii),
                join,
                t(target),
                corners(target_radii),
            );
            for p in &mut points {
                p.swap(0, 1);
            }
            points
        }
    };
    Some(Shape::from_poly(false, Poly::new(points)?))
}

fn attached_points(
    side: Side,
    rect: [f32; 4],
    radii: [f32; 4],
    join: f32,
    target: [f32; 4],
    target_radii: [f32; 4],
) -> Vec<[f32; 3]> {
    let mirror = side == Side::Left;
    let flip = |r: [f32; 4]| {
        if mirror {
            [-r[0] - r[2], r[1], r[2], r[3]]
        } else {
            r
        }
    };
    let [x, y, w, h] = flip(rect);
    let [_, ty, tw, th] = flip(target);
    let (tl, bl) = if mirror {
        (radii[1], radii[2])
    } else {
        (radii[0], radii[3])
    };
    let (ct, cb) = if mirror {
        (target_radii[1], target_radii[2])
    } else {
        (target_radii[0], target_radii[3])
    };
    let edge = x + w;
    let (top, bottom) = (ty, ty + th);
    let room = |d: f32, corner: f32| {
        let full = 2.0 * join.max(corner);
        if full <= 0.0 {
            1.0
        } else {
            (d.max(0.0) / full).min(1.0)
        }
    };
    let st = room(y - top, ct);
    let sb = room(bottom - (y + h), cb);
    let strip = edge + (2.0 * join.max(ct).max(cb) + 2.0).min(tw);
    let yt = top.max(y - 2.0 * join.max(ct)).min(y);
    let yb = bottom.min(y + h + 2.0 * join.max(cb)).max(y + h);
    let mut points = vec![
        [x, y, tl],
        [edge, y, join * st],
        [edge, yt, ct * st],
        [strip, yt, 0.0],
        [strip, yb, 0.0],
        [edge, yb, cb * sb],
        [edge, y + h, join * sb],
        [x, y + h, bl],
    ];
    if mirror {
        for p in &mut points {
            p[0] = -p[0];
        }
    }
    points
}

pub(super) fn slanted(
    sub: bool,
    rect: [f32; 4],
    radii: [f32; 4],
    join: f32,
    slant: [f32; 2],
) -> Option<Shape> {
    let radii = normalized_radii(rect, radii);
    let [x, y, w, h] = rect;
    let [tl, tr] = slant.map(|a| a.to_radians().tan());
    let ext = join * 3.0 + 4.0;
    let points = if tl + tr >= 0.0 {
        let (jl, jr) = (x - h * tl, x + w + h * tr);
        vec![
            [jl - ext, y - ext, 0.0],
            [jr + ext, y - ext, 0.0],
            [jr + ext, y, 0.0],
            [jr, y, join],
            [x + w, y + h, radii[2]],
            [x, y + h, radii[3]],
            [jl, y, join],
            [jl - ext, y, 0.0],
        ]
    } else {
        let (jl, jr) = (x + h * tl, x + w - h * tr);
        let b = y + h;
        vec![
            [jl - ext, b, 0.0],
            [jl, b, join],
            [x, y, radii[0]],
            [x + w, y, radii[1]],
            [jr, b, join],
            [jr + ext, b, 0.0],
            [jr + ext, b + ext, 0.0],
            [jl - ext, b + ext, 0.0],
        ]
    };
    Some(Shape::from_poly(sub, Poly::new(points)?))
}
fn normalized_radii([_, _, w, h]: [f32; 4], r: [f32; 4]) -> [f32; 4] {
    let [w, h] = [w as f64, h as f64];
    let r = r.map(f64::from);
    let f = [
        (w, r[0] + r[1]),
        (h, r[1] + r[2]),
        (w, r[2] + r[3]),
        (h, r[3] + r[0]),
    ]
    .into_iter()
    .fold(
        1.0f64,
        |f, (side, sum)| if sum > 0.0 { f.min(side / sum) } else { f },
    );
    r.map(|r| (r.max(0.0) * f) as f32)
}

pub(super) fn polygon(s: &Shape) -> MultiPolygon<f64> {
    let curve = if let Some(poly) = &s.poly {
        let mut p = BezPath::new();
        for (i, c) in poly.corners.iter().enumerate() {
            let t1 = (c.t1[0] as f64, c.t1[1] as f64);
            if i == 0 {
                p.move_to(t1);
            } else {
                p.line_to(t1);
            }
            let a = (c.t1[1] - c.c[1]).atan2(c.t1[0] - c.c[0]) as f64;
            let b = (c.t2[1] - c.c[1]).atan2(c.t2[0] - c.c[0]) as f64;
            let mut sweep = (b - a).rem_euclid(std::f64::consts::TAU);
            if (poly.orient > 0.0) != c.convex {
                sweep -= std::f64::consts::TAU;
            }
            p.extend(
                CurveArc::new(
                    (c.c[0] as f64, c.c[1] as f64),
                    (c.r as f64, c.r as f64),
                    a,
                    sweep,
                    0.0,
                )
                .append_iter(0.001),
            );
        }
        p.close_path();
        p
    } else {
        let [x, y, w, h] = s.rect.map(f64::from);
        let [tl, tr, br, bl] = normalized_radii(s.rect, s.radii).map(f64::from);
        let mut p = BezPath::new();
        p.move_to((x + tl, y));
        for (cx, cy, r, start) in [
            (x + w - tr, y + tr, tr, -std::f64::consts::FRAC_PI_2),
            (x + w - br, y + h - br, br, 0.0),
            (x + bl, y + h - bl, bl, std::f64::consts::FRAC_PI_2),
            (x + tl, y + tl, tl, std::f64::consts::PI),
        ] {
            p.line_to((cx + r * start.cos(), cy + r * start.sin()));
            p.extend(
                CurveArc::new((cx, cy), (r, r), start, std::f64::consts::FRAC_PI_2, 0.0)
                    .append_iter(0.001),
            );
        }
        p.close_path();
        p
    };
    let mut points = vec![];
    peniko::kurbo::flatten(curve, 0.02, |el| match el {
        PathEl::MoveTo(p) | PathEl::LineTo(p) => points.push(Coord { x: p.x, y: p.y }),
        _ => {}
    });
    MultiPolygon(vec![Polygon::new(LineString::new(points), vec![])])
}
pub(super) fn offset(p: &MultiPolygon<f64>, distance: f64) -> MultiPolygon<f64> {
    use geo::algorithm::buffer::{BufferStyle, LineJoin};
    if distance == 0.0 {
        return p.clone();
    }
    // Chord sagitta <= 0.01 CSS px for each round buffer join.
    let angle = (2.0 * (1.0 - 0.01 / distance.abs()).clamp(-1.0, 1.0).acos()).min(0.25);
    p.buffer_with_style(BufferStyle::new(distance).line_join(LineJoin::Round(angle)))
}

pub(super) fn region(shapes: &[Shape]) -> MultiPolygon<f64> {
    let mut result = MultiPolygon::new(vec![]);
    for shape in shapes {
        let member = polygon(shape);
        let k = shape.join as f64;
        result = if shape.sub {
            result.difference(&member)
        } else {
            result.union(&member)
        };
        if k > 0.0 {
            // Apply only the local correction; splicing two rounded copies creates slivers.
            let radius = if shape.sub { -k } else { k };
            let joined = offset(&offset(&result, radius), -radius);
            let neighbourhood = offset(&member, 2.0 * k);
            result = if shape.sub {
                result.difference(&result.difference(&joined).intersection(&neighbourhood))
            } else {
                result.union(&joined.difference(&result).intersection(&neighbourhood))
            };
        }
    }
    // Below a 0.001 px square, boolean roundoff is far below our 0.02 px flattening tolerance.
    result.0.retain_mut(|p| {
        let (outer, mut holes) = p.clone().into_inner();
        holes.retain(|r| Polygon::new(r.clone(), vec![]).unsigned_area() >= 1e-6);
        *p = Polygon::new(outer, holes);
        p.unsigned_area() >= 1e-6
    });
    // Boolean roundoff can also retrace a straight edge; do not amplify those spikes into miters.
    result.simplify(1e-5)
}

pub(super) fn bands(region: &MultiPolygon<f64>, width: f64) -> Vec<(MultiPolygon<f64>, f32)> {
    use geo::BoundingRect;
    let mut bands = vec![];
    for poly in &region.0 {
        for (ring, hole) in std::iter::once((poly.exterior(), false))
            .chain(poly.interiors().iter().map(|r| (r, true)))
        {
            let sign = ring
                .0
                .windows(2)
                .map(|p| p[0].x * p[1].y - p[1].x * p[0].y)
                .sum::<f64>()
                .signum()
                * if hole { -1.0 } else { 1.0 };
            let bounds = ring.bounding_rect().unwrap();
            let width = width.min(bounds.width().min(bounds.height()) * 0.5);
            let points: Vec<_> = ring
                .0
                .windows(2)
                .filter(|p| p[0] != p[1])
                .map(|p| p[0])
                .collect();
            let n = points.len();
            let normals: Vec<_> = (0..n)
                .map(|i| {
                    let (a, b) = (points[i], points[(i + 1) % n]);
                    let (dx, dy) = (b.x - a.x, b.y - a.y);
                    let len = dx.hypot(dy);
                    (-dy / len * sign, dx / len * sign)
                })
                .collect();
            let inset: Vec<_> = (0..n)
                .map(|i| {
                    let (a, b) = (normals[(i + n - 1) % n], normals[i]);
                    let d = 1.0 + a.0 * b.0 + a.1 * b.1;
                    let p = points[i];
                    Coord {
                        x: p.x + width * (a.0 + b.0) / d.max(1e-6),
                        y: p.y + width * (a.1 + b.1) / d.max(1e-6),
                    }
                })
                .collect();
            for i in 0..n {
                let j = (i + 1) % n;
                // Adjacent strips meet at their angle bisector rather than painting over each other.
                let band = Polygon::new(
                    LineString::new(vec![points[i], points[j], inset[j], inset[i], points[i]]),
                    vec![],
                );
                bands.push((
                    MultiPolygon(vec![band]).intersection(region),
                    normals[i].1 as f32,
                ));
            }
        }
    }
    bands
}

pub(super) fn path(region: &MultiPolygon<f64>) -> BezPath {
    let mut outline = BezPath::new();
    for poly in &region.0 {
        for ring in std::iter::once(poly.exterior()).chain(poly.interiors()) {
            for (i, p) in ring.0.iter().enumerate() {
                if i == 0 {
                    outline.move_to((p.x, p.y));
                } else {
                    outline.line_to((p.x, p.y));
                }
            }
            outline.close_path();
        }
    }
    outline
}
