//! Draw SVG icon paths as vector fills and strokes without Blitz's SVG stack.
//! Paint accepts currentColor and #rgb/#rrggbb/#rrggbbaa.
use anyrender::{PaintScene, RenderContext, Scene};
use blitz_dom::node::{ComputedStyles, Widget};
use peniko::{
    Color, Fill,
    kurbo::{Affine, BezPath, Cap, Join, Stroke},
};

pub(super) const UA_CSS: &str = "tk-icon { display: block; flex-shrink: 0; pointer-events: none; }";

pub(super) fn widget() -> Box<dyn Widget> {
    Box::new(Icon {
        path: BezPath::new(),
        view: 24.0,
        fill: None,
        stroke: None,
        stroke_width: 1.75,
    })
}

struct Icon {
    path: BezPath,
    view: f64,
    fill: Option<Paint>,
    stroke: Option<Paint>,
    stroke_width: f64,
}

#[derive(Clone, Copy)]
enum Paint {
    Fixed(Color),
    Current,
}

fn colour(value: Option<&str>) -> Option<Paint> {
    let value = value?;
    if value.trim().eq_ignore_ascii_case("currentcolor") {
        return Some(Paint::Current);
    }
    let [r, g, b, a] = parse_colour(value)?;
    Some(Paint::Fixed(Color::new([r, g, b, a])))
}

fn parse_colour(text: &str) -> Option<[f32; 4]> {
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

impl Widget for Icon {
    fn attribute_changed(&mut self, name: &str, _old: Option<&str>, new: Option<&str>) {
        let number = |fallback: f64| {
            new.and_then(|v| v.trim().parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v > 0.0)
                .unwrap_or(fallback)
        };
        match name {
            "d" => {
                self.path = BezPath::from_svg(new.unwrap_or("")).unwrap_or_else(|error| {
                    eprintln!("tk-icon d: {error}");
                    BezPath::new()
                })
            }
            "view" => self.view = number(24.0),
            "fill" => self.fill = colour(new),
            "stroke" => self.stroke = colour(new),
            "stroke-width" => self.stroke_width = number(1.75),
            _ => {}
        }
    }

    fn paint(
        &mut self,
        _render_ctx: &mut dyn RenderContext,
        styles: &ComputedStyles,
        width: u32,
        height: u32,
        _scale: f64,
    ) -> Scene {
        let side = width.min(height) as f64;
        let transform =
            Affine::translate(((width as f64 - side) / 2.0, (height as f64 - side) / 2.0))
                * Affine::scale(side / self.view);
        // Hex colours compute to sRGB, so the raw components are sRGB here.
        let current = Color::new(
            *styles
                .clone_color()
                .to_color_space(style::color::ColorSpace::Srgb)
                .raw_components(),
        );
        let resolve = |p: Paint| match p {
            Paint::Fixed(c) => c,
            Paint::Current => current,
        };
        let mut scene = Scene::new();
        if let Some(fill) = self.fill.map(resolve) {
            scene.fill(Fill::NonZero, transform, fill, None, &self.path);
        }
        if let Some(stroke) = self.stroke.map(resolve) {
            let style = Stroke::new(self.stroke_width)
                .with_caps(Cap::Round)
                .with_join(Join::Round);
            scene.stroke(&style, transform, stroke, None, &self.path);
        }
        scene
    }
}
