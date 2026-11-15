#[allow(dead_code)]
#[path = "support/mod.rs"]
mod support;
use blitz_dom::Document;
use blitz_traits::{
    events::{BlitzImeEvent, UiEvent},
    shell::Viewport,
};
use render::NativeDocument;

fn document(tag: &str) -> NativeDocument {
    let mut doc = NativeDocument::new(
        &format!(r#"<html><body><div id="app"><{tag} id="editable"></{tag}><{tag} id="readonly" readonly></{tag}><{tag} id="disabled" disabled></{tag}></div></body></html>"#),
        r#"globalThis.__tokamak = { dispatch() { return '{"prevented":false,"stopped":false,"error":null}'; }, host() {}, drain() { return '[]'; }, dispose() {} };"#,
    ).unwrap();
    doc.inner_mut().set_viewport(Viewport {
        window_size: (800, 600),
        ..Default::default()
    });
    doc.resolve_layout(0.0);
    doc
}
fn focus(doc: &mut NativeDocument, name: &str) {
    let id = doc.inner().get_element_by_id(name).unwrap();
    doc.inner_mut().set_focus_to(id);
    assert_eq!(doc.inner().get_focussed_node_id(), Some(id));
}
fn text(doc: &NativeDocument, name: &str) -> String {
    let inner = doc.inner();
    inner
        .get_node(inner.get_element_by_id(name).unwrap())
        .unwrap()
        .element_data()
        .unwrap()
        .text_input_data()
        .unwrap()
        .editor
        .raw_text()
        .to_owned()
}

#[test]
fn readonly_textareas_reject_ime_commits() {
    let mut doc = document("textarea");
    focus(&mut doc, "readonly");
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit("blocked".into())));
    assert_eq!(text(&doc, "readonly"), "");
}

#[test]
fn asynchronous_paste_obeys_the_current_fields_edit_policy() {
    for tag in ["input", "textarea"] {
        let mut doc = document(tag);
        focus(&mut doc, "editable");
        doc.handle_ui_event(UiEvent::Paste("editable".into()));
        assert_eq!(text(&doc, "editable"), "editable", "{tag}");
        for name in ["readonly", "disabled"] {
            focus(&mut doc, name);
            doc.handle_ui_event(UiEvent::Paste("blocked".into()));
            assert_eq!(text(&doc, name), "", "{tag} {name}");
        }
        focus(&mut doc, "editable");
        doc.handle_ui_event(UiEvent::AppleStandardKeybinding("paste:".into()));
        focus(&mut doc, "readonly");
        doc.handle_ui_event(UiEvent::Paste("late reply".into()));
        assert_eq!(text(&doc, "readonly"), "", "{tag} late reply");
    }
}

#[test]
fn disabled_fieldsets_block_paste_typing_and_ime_except_in_the_first_legend() {
    for tag in ["input", "textarea"] {
        for (content, accepts) in [
            (format!("<{tag} id='field'></{tag}>"), false),
            (
                format!("<legend><span><{tag} id='field'></{tag}></span></legend>"),
                true,
            ),
            (
                format!("<legend>first</legend><legend><{tag} id='field'></{tag}></legend>"),
                false,
            ),
            (
                format!(
                    "<legend><fieldset disabled><legend><{tag} id='field'></{tag}></legend></fieldset></legend>"
                ),
                true,
            ),
            (
                format!(
                    "<legend><fieldset disabled><{tag} id='field'></{tag}></fieldset></legend>"
                ),
                false,
            ),
        ] {
            let mut doc = NativeDocument::new(
                &format!("<html><body><div id='app'><fieldset id='fieldset'>{content}</fieldset></div></body></html>"),
                r#"globalThis.__tokamak = { dispatch() { return '{"prevented":false,"stopped":false,"error":null}'; }, host() {}, drain() { return '[]'; }, dispose() {} };"#,
            ).unwrap();
            doc.inner_mut().set_viewport(Viewport {
                window_size: (800, 600),
                ..Default::default()
            });
            doc.resolve_layout(0.0);
            focus(&mut doc, "field");
            let id = doc.inner().get_element_by_id("fieldset").unwrap();
            doc.inner_mut().mutate().set_attribute(
                id,
                blitz_dom::QualName::new(None, blitz_dom::Namespace::from(""), "disabled".into()),
                "",
            );
            doc.handle_ui_event(UiEvent::Paste("late".into()));
            assert_eq!(
                text(&doc, "field"),
                if accepts { "late" } else { "" },
                "{tag} {content} paste"
            );
            support::key(&mut doc, "x", false, false);
            assert_eq!(
                text(&doc, "field"),
                if accepts { "latex" } else { "" },
                "{tag} {content} typing"
            );
            doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit("ime".into())));
            assert_eq!(
                text(&doc, "field"),
                if accepts { "latexime" } else { "" },
                "{tag} {content} IME"
            );
        }
    }
}
