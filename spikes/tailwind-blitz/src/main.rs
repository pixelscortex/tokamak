//! Isolated TKM-6 experiment: parse real compiled CSS, drive Blitz state, paint PNGs.
//! No browser, JS engine, window, desktop capture, or network asset loader is involved.
use std::{fs, path::Path};

use anyrender::{PaintScene as _, render_to_buffer};
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{Document, DocumentConfig, Namespace, QualName};
use blitz_html::HtmlDocument;
use blitz_traits::{
    NodeId,
    events::{BlitzKeyEvent, KeyState, UiEvent},
    shell::{ColorScheme, Viewport},
};
use keyboard_types::{Code, Key, Location, Modifiers, NamedKey};
use peniko::{Fill, color::palette::css::WHITE, kurbo::Rect};

const WIDTH: u32 = 1000;
const HEIGHT: u32 = 760;
const IDS: &[&str] = &[
    "layers",
    "oklch",
    "mix",
    "vars",
    "property-initial",
    "property-inherits",
    "property-invalid",
    "flex",
    "pressed",
    "pressed-value",
    "hover",
    "focus",
];

fn id(doc: &HtmlDocument, name: &str) -> NodeId {
    doc.get_element_by_id(name)
        .unwrap_or_else(|| panic!("missing #{name}"))
}

fn capture(doc: &mut HtmlDocument, dir: &Path, name: &str) {
    doc.resolve(0.0);
    println!(
        "\nSTATE {name} hover={:?} focus={:?}",
        doc.get_hover_node_id(),
        doc.get_focussed_node_id()
    );
    for name in IDS {
        let node = doc.get_node(id(doc, name)).unwrap();
        let rect = doc.get_client_bounding_rect(node.id).unwrap();
        let style = node.primary_styles().unwrap();
        println!(
            "#{name}: rect={rect:?} bg={:?} border={:?} outline={:?}",
            style.get_background().background_color,
            node.final_layout().border,
            style.get_outline()
        );
    }
    // This is Blitz's actual paint tree rasterized through the supported AnyRender
    // CPU backend, not a screenshot of computed-style numbers or another browser.
    let rgba = render_to_buffer::<VelloCpuImageRenderer, _>(
        |scene| {
            scene.fill(
                Fill::NonZero,
                Default::default(),
                WHITE,
                None,
                &Rect::new(0.0, 0.0, WIDTH as f64, HEIGHT as f64),
            );
            blitz_paint::paint_scene(scene, doc, 1.0, WIDTH, HEIGHT, 0, 0);
        },
        WIDTH,
        HEIGHT,
    );
    let file = fs::File::create(dir.join(format!("{name}.png"))).unwrap();
    let mut encoder = png::Encoder::new(file, WIDTH, HEIGHT);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&rgba)
        .unwrap();
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let (css_file, evidence_dir) = match std::env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [] => ("output.css", "evidence/default"),
        [flag] if flag == "--optimized" => ("output.optimized.css", "evidence/optimized"),
        [flag] if flag == "--focus-fallback" => {
            ("output.focus-fallback.css", "evidence/focus-fallback")
        }
        _ => panic!("usage: tailwind-blitz-probe [--optimized | --focus-fallback]"),
    };
    println!("CSS {css_file}; viewport {WIDTH}x{HEIGHT}; scale 1; CPU paint");
    let css = fs::read_to_string(root.join(css_file)).unwrap();
    let html = fs::read_to_string(root.join("page.html"))
        .unwrap()
        .replace("/* COMPILED_CSS */", &css);
    let dir = root.join(evidence_dir);
    fs::create_dir_all(&dir).unwrap();
    let mut doc = HtmlDocument::from_html(
        &html,
        DocumentConfig {
            viewport: Some(Viewport::new(WIDTH, HEIGHT, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    capture(&mut doc, &dir, "01-baseline");

    let pressed = id(&doc, "pressed");
    doc.mutate().set_attribute(
        pressed,
        QualName::new(None, Namespace::from(""), "data-pressed".into()),
        "",
    );
    capture(&mut doc, &dir, "02-data-pressed");

    let hover = id(&doc, "hover");
    let rect = doc.get_client_bounding_rect(hover).unwrap();
    doc.set_hover_to(
        (rect.x + rect.width / 2.0) as f32,
        (rect.y + rect.height / 2.0) as f32,
    );
    capture(&mut doc, &dir, "03-hover");

    // Seed focus on the preceding tabindex fixture, then let real Tab handling
    // move it to the button. This isolates CSS focus-visible from initial tab entry.
    doc.set_focus_to(hover);
    doc.handle_ui_event(UiEvent::KeyDown(BlitzKeyEvent {
        key: Key::Named(NamedKey::Tab),
        code: Code::Tab,
        modifiers: Modifiers::empty(),
        location: Location::Standard,
        is_auto_repeating: false,
        is_composing: false,
        state: KeyState::Pressed,
        text: None,
    }));
    assert_eq!(
        doc.get_focussed_node_id(),
        Some(id(&doc, "focus")),
        "Tab must reach the focus fixture before claiming focus evidence"
    );
    capture(&mut doc, &dir, "04-keyboard-focus");

    doc.clear_hover();
    doc.clear_focus();
    doc.mutate().clear_attribute(
        pressed,
        QualName::new(None, Namespace::from(""), "data-pressed".into()),
    );
    capture(&mut doc, &dir, "05-cleared");
}
