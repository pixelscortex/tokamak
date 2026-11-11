//! The surface's data model: shapes as parsed from the `shapes` attribute,
//! the exact rounded-polygon outline (`Poly`), and the `Look` (every
//! attribute other than geometry). Plain data; the maths that turns it into a
//! distance field is in `sdf`, the GPU encoding in `gpu`.
use serde::Deserialize;
use std::sync::Arc;

/// Shapes per surface. The per-pixel cost is bounded by tiling (see `tiles`),
/// so this bounds parameter-buffer size and parse time, not rendering cost.
pub(super) const MAX_SHAPES: usize = 4096;

pub(super) type V2 = [f32; 2];

/// A shape's identity within its surface, stable across changes: an entry
/// of the `shapes` attribute by index, a layout-bound member by node. Shape
/// animation and partial re-rendering match old and new shapes by key, never
/// by position, so shapes appearing or disappearing elsewhere in the list do
/// not move (or re-render) the others.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Key {
    Explicit(u32),
    Member(blitz_traits::NodeId),
}

/// Index keys for a list without identities (tests, the demo driver).
pub(super) fn index_keys(n: usize) -> Vec<Key> {
    (0..n as u32).map(Key::Explicit).collect()
}

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

/// One rounded vertex of a `Poly`: the arc (centre `c`, radius `r`) and its
/// tangent points on the incoming (`t1`) and outgoing (`t2`) edges.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Corner {
    pub c: V2,
    pub r: f32,
    pub convex: bool,
    pub t1: V2,
    pub t2: V2,
}

/// A closed outline whose straight edges are joined by tangent arcs, one
/// radius per vertex, convex or concave. This is how a notch with leaning
/// sides gets exact circular joins: the panel and its notch are ONE outline,
/// so every join is a vertex arc, whatever the angle. (Joining two separate
/// shapes with the CSG `join` is exact only where their edges meet at 90
/// degrees.) The boundary is C1, which makes the nearest-feature signed
/// distance in `sdf` exact.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Poly {
    pub points: Vec<[f32; 3]>,
    pub corners: Vec<Corner>,
    /// +1 if the vertices run clockwise on screen (y down), -1 otherwise.
    pub orient: f32,
}

/// Radius used for "sharp" vertices: a tiny arc keeps the outline C1, so the
/// nearest-feature sign never meets a kink; invisible at any scale.
const MIN_ARC: f32 = 0.01;

impl Poly {
    /// Builds the arcs: for each vertex, the circle of radius r tangent to
    /// both adjacent edges. If the tangent points would run past the middle
    /// of an edge the radius is reduced so neighbouring arcs never overlap.
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
                let mut r = points[i][2].max(MIN_ARC);
                let mut t = r / half.tan();
                let t_max = 0.5 * l1.min(l2);
                if t > t_max {
                    t = t_max;
                    r = t * half.tan();
                }
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

    /// Vertex-wise interpolation; None if the vertex counts differ.
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
    /// x, y, w, h in CSS px (a poly's bounding box).
    pub rect: [f32; 4],
    /// tl, tr, br, bl (unused by a poly).
    pub radii: [f32; 4],
    /// Negative means "use the surface default".
    pub join: f32,
    pub gap: f32,
    pub poly: Option<Arc<Poly>>,
    /// Own look, for a materials layer (`Look::layered`): each shape is
    /// shaded on its own and painted over the ones before it.
    pub paint: Option<Paint>,
}

/// A shape's own material in a materials layer, read from the member's
/// computed `--tk-fill`, `--tk-bevel` and `--tk-elevation`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Paint {
    pub fill: [f32; 4],
    pub bevel: f32,
    pub recessed: bool,
}

impl Shape {
    pub fn rect(sub: bool, rect: [f32; 4], radii: [f32; 4]) -> Shape {
        Shape {
            sub,
            rect,
            radii,
            join: -1.0,
            gap: -1.0,
            poly: None,
            paint: None,
        }
    }

    pub fn from_poly(sub: bool, poly: Poly) -> Shape {
        Shape {
            rect: poly.bounds(),
            poly: Some(Arc::new(poly)),
            ..Shape::rect(sub, [0.0; 4], [0.0; 4])
        }
    }

    /// The same shape moved by (dx, dy) CSS px.
    pub fn translated(&self, dx: f32, dy: f32) -> Shape {
        let [x, y, w, h] = self.rect;
        // Moving keeps a valid polygon valid; keep the old one if rounding
        // ever says otherwise.
        let poly = self.poly.as_ref().map(|p| {
            let points = p
                .points
                .iter()
                .map(|q| [q[0] + dx, q[1] + dy, q[2]])
                .collect();
            Poly::new(points).map(Arc::new).unwrap_or_else(|| p.clone())
        });
        Shape {
            rect: [x + dx, y + dy, w, h],
            poly,
            ..self.clone()
        }
    }

    /// Per-field interpolation used by the shape animation.
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
            // Defaults (negative) do not interpolate meaningfully; snap.
            join: if a.join < 0.0 || b.join < 0.0 {
                b.join
            } else {
                mix(a.join, b.join)
            },
            gap: if a.gap < 0.0 || b.gap < 0.0 {
                b.gap
            } else {
                mix(a.gap, b.gap)
            },
            poly,
            paint: b.paint,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShapeSpec {
    op: OpSpec,
    #[serde(default)]
    kind: KindSpec,
    #[serde(default)]
    x: f32,
    #[serde(default)]
    y: f32,
    #[serde(default)]
    w: f32,
    #[serde(default)]
    h: f32,
    r: Option<RadiusSpec>,
    points: Option<Vec<PointSpec>>,
    join: Option<f32>,
    gap: Option<f32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum OpSpec {
    Add,
    Sub,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum KindSpec {
    #[default]
    Rect,
    Circle,
    Poly,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RadiusSpec {
    One(f32),
    Four([f32; 4]),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PointSpec {
    Sharp([f32; 2]),
    Rounded([f32; 3]),
}

/// Parses the `shapes` attribute. Rejects rather than guesses: unknown
/// fields, negative or non-finite boxes, degenerate polys, too many shapes.
pub(super) fn parse_shapes(json: &str) -> Result<Vec<Shape>, String> {
    let specs: Vec<ShapeSpec> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if specs.len() > MAX_SHAPES {
        return Err(format!("at most {MAX_SHAPES} shapes"));
    }
    specs
        .into_iter()
        .map(|s| {
            let finite = [s.x, s.y, s.w, s.h].iter().all(|v| v.is_finite());
            if !finite || s.w < 0.0 || s.h < 0.0 {
                return Err("shape box must be finite and non-negative".into());
            }
            let sub = matches!(s.op, OpSpec::Sub);
            let mut shape = match s.kind {
                KindSpec::Poly => {
                    let points: Vec<[f32; 3]> = s
                        .points
                        .ok_or("a poly needs points")?
                        .into_iter()
                        .map(|p| match p {
                            PointSpec::Sharp([x, y]) => [x, y, 0.0],
                            PointSpec::Rounded([x, y, r]) => [x, y, r.max(0.0)],
                        })
                        .collect();
                    if points.iter().flatten().any(|v| !v.is_finite()) {
                        return Err("poly points must be finite".into());
                    }
                    let poly = Poly::new(points).ok_or("a poly needs 3+ points and an area")?;
                    Shape::from_poly(sub, poly)
                }
                KindSpec::Circle => Shape::rect(sub, [s.x, s.y, s.w, s.h], [s.w.min(s.h) * 0.5; 4]),
                KindSpec::Rect => {
                    let radii = match s.r {
                        None => [0.0; 4],
                        Some(RadiusSpec::One(r)) => [r.max(0.0); 4],
                        Some(RadiusSpec::Four(r)) => r.map(|v| v.max(0.0)),
                    };
                    Shape::rect(sub, [s.x, s.y, s.w, s.h], radii)
                }
            };
            shape.join = s.join.map_or(-1.0, |v| v.max(0.0));
            shape.gap = s.gap.map_or(-1.0, |v| v.max(0.0));
            Ok(shape)
        })
        .collect()
}

/// `#rgb`, `#rrggbb` or `#rrggbbaa`, straight alpha, sRGB-encoded values.
pub(crate) fn parse_colour(text: &str) -> Option<[f32; 4]> {
    let hex = text.trim().strip_prefix('#')?;
    let digit = |i: usize, n: usize| u8::from_str_radix(hex.get(i..i + n)?, 16).ok();
    let (r, g, b, a) = match hex.len() {
        3 => (digit(0, 1)? * 17, digit(1, 1)? * 17, digit(2, 1)? * 17, 255),
        6 => (digit(0, 2)?, digit(2, 2)?, digit(4, 2)?, 255),
        8 => (digit(0, 2)?, digit(2, 2)?, digit(4, 2)?, digit(6, 2)?),
        _ => return None,
    };
    Some([r, g, b, a].map(|c| c as f32 / 255.0))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Align {
    Inside,
    Center,
    Outside,
}

/// Everything except the geometry.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Look {
    pub join: f32,
    pub gap: f32,
    pub fill: [f32; 4],
    pub bevel: f32,
    pub light_deg: f32,
    pub recessed: bool,
    pub border: f32,
    pub border_colour: [f32; 4],
    pub border_align: Align,
    /// How much the light modulates the border (`border-lit`): 0 is a flat
    /// hairline, 1 the full lit/shaded swing with the edge direction.
    pub border_lit: f32,
    /// `border-mix`: when set (>= 0), the border colour is the fill moved
    /// this fraction of the way to white (a hairline "strength"), instead of
    /// `border_colour`. Follows the fill, so one number tunes every material.
    pub border_mix: f32,
    /// `materials`: a materials layer. Shapes are not combined into one
    /// field; each is shaded with its own `Paint` and painted over the
    /// previous ones (see `bind`, "Materials").
    pub layered: bool,
}

/// `var(--name)` -> `name` (custom property names are stored without `--`).
pub(super) fn var_name(value: &str) -> Option<String> {
    let inner = value.trim().strip_prefix("var(")?.strip_suffix(')')?.trim();
    Some(inner.strip_prefix("--")?.to_string())
}

impl Default for Look {
    fn default() -> Self {
        let grey = |v: u8| [v as f32 / 255.0, v as f32 / 255.0, v as f32 / 255.0, 1.0];
        Self {
            join: 0.0,
            gap: 0.0,
            fill: grey(0x12),
            bevel: 2.0,
            light_deg: 0.0,
            recessed: false,
            border: 0.0,
            border_colour: grey(0x2a),
            border_align: Align::Inside,
            border_lit: 0.0,
            border_mix: -1.0,
            layered: false,
        }
    }
}

impl Look {
    /// Applies one attribute. Returns false for names the look does not own.
    pub fn set(&mut self, name: &str, value: Option<&str>) -> bool {
        let defaults = Look::default();
        let number = |fallback: f32| {
            value
                .and_then(|v| v.trim().parse::<f32>().ok())
                .filter(|v| v.is_finite())
                .unwrap_or(fallback)
        };
        match name {
            "join" => self.join = number(defaults.join).max(0.0),
            "gap" => self.gap = number(defaults.gap).max(0.0),
            "bevel" => self.bevel = number(defaults.bevel).max(0.0),
            "light" => self.light_deg = number(defaults.light_deg),
            "fill" => {
                self.fill = value
                    .map_or(Some(defaults.fill), parse_colour)
                    .unwrap_or_else(|| {
                        eprintln!("tk-surface fill: expected #rgb, #rrggbb or #rrggbbaa");
                        defaults.fill
                    })
            }
            "elevation" => self.recessed = value == Some("recessed"),
            "border" => self.border = number(defaults.border).max(0.0),
            "border-color" => {
                self.border_colour = value
                    .and_then(parse_colour)
                    .unwrap_or(defaults.border_colour)
            }
            "border-align" => {
                self.border_align = match value {
                    Some("center") => Align::Center,
                    Some("outside") => Align::Outside,
                    _ => Align::Inside,
                }
            }
            // `true` (or empty) is the full swing, a number is the amount.
            "border-lit" => {
                self.border_lit = match value.map(str::trim) {
                    None | Some("false") => 0.0,
                    Some("" | "true") => 1.0,
                    Some(_) => number(0.0).clamp(0.0, 1.0),
                }
            }
            "border-mix" => self.border_mix = number(-1.0).min(1.0),
            "materials" => self.layered = value.is_some(),
            _ => return false,
        }
        true
    }

    /// Unit vector towards the light, screen coordinates (y down).
    pub fn light(&self) -> V2 {
        let a = self.light_deg.to_radians();
        [a.sin(), -a.cos()]
    }

    pub fn sign(&self) -> f32 {
        if self.recessed { -1.0 } else { 1.0 }
    }

    /// Distance (CSS px) of the border's outer and inner edges from the
    /// silhouette; with no border both are 0.
    pub fn border_edges(&self) -> (f32, f32) {
        let outer = match self.border_align {
            Align::Inside => 0.0,
            Align::Center => self.border * 0.5,
            Align::Outside => self.border,
        };
        (outer, outer - self.border)
    }

    /// The border's colour as painted (see `border_mix`).
    pub fn border_rgba(&self) -> [f32; 4] {
        if self.border_mix < 0.0 {
            return self.border_colour;
        }
        let m = self.border_mix;
        let [r, g, b, a] = self.fill;
        [r + (1.0 - r) * m, g + (1.0 - g) * m, b + (1.0 - b) * m, a]
    }

    pub fn join_of(&self, s: &Shape) -> f32 {
        if s.join >= 0.0 { s.join } else { self.join }
    }

    pub fn gap_of(&self, s: &Shape) -> f32 {
        if s.gap >= 0.0 { s.gap } else { self.gap }
    }
}
