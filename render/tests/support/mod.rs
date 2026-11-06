//! Native UI test driver. All inputs enter the production public document API.
use blitz_dom::{Document, Namespace, QualName};
use blitz_traits::{NodeId, events::*, shell::Viewport};
use keyboard_types::{Code, Key, Location, Modifiers, NamedKey};
use render::NativeDocument;
use serde_json::Value;

pub fn document() -> NativeDocument {
    let bundle = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/dist/tests/ui-elements.js"
    ))
    .unwrap();
    let css = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../ui/dist/styles.css"
    ))
    .unwrap();
    let shell = format!(
        "<!doctype html><html><head><style>{css} body {{ margin: 0; }} main {{ display:flex; flex-direction:column; gap:4px; padding:8px; }} button, input, #custom {{ display:block; width:240px; height:36px; }} p {{ margin:0; }}</style></head><body><div id=\"app\"></div></body></html>"
    );
    let mut doc = NativeDocument::new(&shell, &bundle).unwrap();
    doc.inner_mut().set_viewport(Viewport {
        window_size: (800, 1400),
        ..Default::default()
    });
    doc.inner_mut().resolve(0.0);
    doc
}
pub fn id(doc: &NativeDocument, name: &str) -> NodeId {
    doc.inner().get_element_by_id(name).unwrap()
}
pub fn text(doc: &NativeDocument, name: &str) -> String {
    doc.inner().get_node(id(doc, name)).unwrap().text_content()
}
pub fn attr(doc: &NativeDocument, name: &str, attribute: &str) -> Option<String> {
    doc.inner()
        .get_node(id(doc, name))
        .unwrap()
        .element_data()
        .unwrap()
        .attr(QualName::new(None, Namespace::from(""), attribute.into()).local)
        .map(str::to_owned)
}
pub fn policy(doc: &mut NativeDocument, payload: Value) {
    assert!(
        doc.host_event(doc.generation(), "ui-policy", payload)
            .unwrap()
    );
}
pub fn count(doc: &NativeDocument, name: &str) -> u64 {
    serde_json::from_str::<Value>(&text(doc, "counts")).unwrap()[name]
        .as_u64()
        .unwrap_or(0)
}
pub fn key(doc: &mut NativeDocument, value: &str, up: bool, repeat: bool) {
    let (key, code) = match value {
        "Enter" => (Key::Named(NamedKey::Enter), Code::Enter),
        "Tab" => (Key::Named(NamedKey::Tab), Code::Tab),
        "Escape" => (Key::Named(NamedKey::Escape), Code::Escape),
        " " => (Key::Character(" ".into()), Code::Space),
        s => (Key::Character(s.into()), Code::KeyA),
    };
    let event = BlitzKeyEvent {
        key,
        code,
        text: if value.len() == 1 {
            Some(value.into())
        } else {
            None
        },
        modifiers: Modifiers::empty(),
        location: Location::Standard,
        is_auto_repeating: repeat,
        is_composing: false,
        state: if up {
            KeyState::Released
        } else {
            KeyState::Pressed
        },
    };
    doc.handle_ui_event(if up {
        UiEvent::KeyUp(event)
    } else {
        UiEvent::KeyDown(event)
    });
}
pub fn focus(doc: &mut NativeDocument, name: &str) {
    // Match a native redraw after reactive disabled/tabindex changes: Blitz
    // rebuilds its tab-order cache during resolve, just as hit testing does.
    doc.inner_mut().resolve(0.0);
    for _ in 0..16 {
        if doc.inner().get_focussed_node_id() == Some(id(doc, name)) {
            return;
        }
        key(doc, "Tab", false, false);
    }
    panic!("Tab could not focus {name}");
}
pub fn pointer(doc: &mut NativeDocument, name: &str) {
    doc.inner_mut().resolve(0.0);
    let rect = doc.inner().get_client_bounding_rect(id(doc, name)).unwrap();
    assert!(rect.width > 0.0 && rect.height > 0.0);
    let (x, y) = (
        (rect.x + rect.width / 2.0) as f32,
        (rect.y + rect.height / 2.0) as f32,
    );
    let mut event = BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords: PointerCoords {
            page_x: x,
            page_y: y,
            screen_x: x,
            screen_y: y,
            client_x: x,
            client_y: y,
        },
        button: MouseEventButton::Main,
        buttons: MouseEventButtons::Primary,
        mods: Modifiers::empty(),
        details: Default::default(),
        element: Default::default(),
        active_pointers: Default::default(),
    };
    doc.handle_ui_event(UiEvent::PointerDown(event.clone()));
    event.buttons = MouseEventButtons::None;
    doc.handle_ui_event(UiEvent::PointerUp(event));
}
pub fn editor(doc: &NativeDocument, name: &str) -> String {
    doc.inner()
        .get_node(id(doc, name))
        .unwrap()
        .element_data()
        .unwrap()
        .text_input_data()
        .unwrap()
        .editor
        .raw_text()
        .to_owned()
}
