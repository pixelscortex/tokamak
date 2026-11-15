//! TKM-9 public component behavior through Solid universal, QuickJS and Blitz.
//! These injected native events do not claim the separate human foreground gate.
mod support;
use blitz_dom::Document;
use blitz_traits::events::{BlitzImeEvent, UiEvent};
use serde_json::json;
use support::*;

#[test]
fn uncontrolled_button_composes_ref_focus_click_and_reactive_state() {
    // Done-when: plain classes, presence-based state, focus callbacks and toggles.
    let mut doc = document();
    assert_eq!(count(&doc, "native-ref"), 1);
    assert_eq!(
        attr(&doc, "native", "class").as_deref(),
        Some("tk-button custom")
    );
    assert_eq!(
        attr(&doc, "native", "aria-pressed").as_deref(),
        Some("false")
    );
    assert_eq!(attr(&doc, "native", "data-pressed"), None);
    assert_eq!(attr(&doc, "action", "aria-pressed"), None);
    focus(&mut doc, "native");
    assert_eq!(count(&doc, "native-focus"), 1);
    assert_eq!(attr(&doc, "native", "data-focused").as_deref(), Some(""));
    pointer(&mut doc, "native");
    assert_eq!(count(&doc, "native-click"), 1);
    assert_eq!(count(&doc, "native-change"), 1);
    assert_eq!(attr(&doc, "native", "data-pressed").as_deref(), Some(""));
    policy(&mut doc, json!({"disabled":true,"class":"changed"}));
    assert_eq!(
        attr(&doc, "native", "class").as_deref(),
        Some("tk-button changed")
    );
    assert_eq!(attr(&doc, "native", "data-disabled").as_deref(), Some(""));
    assert_eq!(attr(&doc, "native", "data-focused"), None);
    pointer(&mut doc, "native");
    assert_eq!(count(&doc, "native-click"), 1);
    policy(&mut doc, json!({"disabled":false,"cancel":true}));
    pointer(&mut doc, "native");
    assert_eq!(count(&doc, "native-click"), 2);
    assert_eq!(
        count(&doc, "native-change"),
        1,
        "canceled click must not toggle"
    );
    // End the cancellation scenario before using Tab to test composed blur.
    policy(&mut doc, json!({"cancel":false}));
    focus(&mut doc, "custom");
    assert!(count(&doc, "native-blur") >= 1);
    assert_eq!(
        count(&doc, "native-ref"),
        1,
        "reactive changes must not remount"
    );
    assert!(doc.take_error().is_none());
}

fn keyboard_contract(name: &str) {
    let mut doc = document();
    focus(&mut doc, name);
    key(&mut doc, "Enter", false, false);
    key(&mut doc, "Enter", false, true);
    key(&mut doc, "Enter", true, false);
    assert_eq!(count(&doc, &format!("{name}-click")), 1);
    key(&mut doc, " ", false, false);
    key(&mut doc, " ", false, true);
    assert_eq!(
        count(&doc, &format!("{name}-click")),
        1,
        "Space activates on release"
    );
    key(&mut doc, " ", true, false);
    key(&mut doc, " ", true, false);
    assert_eq!(
        count(&doc, &format!("{name}-click")),
        2,
        "release/repeat must not double activate"
    );
    policy(&mut doc, json!({"cancel":true}));
    key(&mut doc, "Enter", false, false);
    key(&mut doc, " ", false, false);
    key(&mut doc, " ", true, false);
    assert_eq!(count(&doc, &format!("{name}-click")), 2);
    policy(&mut doc, json!({"cancel":false}));
    key(&mut doc, " ", false, false);
    focus(&mut doc, "controlled");
    key(&mut doc, " ", true, false);
    focus(&mut doc, name);
    key(&mut doc, " ", true, false);
    assert_eq!(
        count(&doc, &format!("{name}-click")),
        2,
        "blur cancels armed Space"
    );
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Preedit(
        "候補".into(),
        Some((0, 6)),
    )));
    key(&mut doc, "Enter", false, false);
    assert_eq!(
        count(&doc, &format!("{name}-click")),
        2,
        "IME confirmation is not activation"
    );
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Disabled));
    key(&mut doc, "Enter", false, false);
    assert_eq!(count(&doc, &format!("{name}-click")), 3);
    assert_eq!(count(&doc, &format!("{name}-change")), 3);
    assert!(doc.take_error().is_none());
}
#[test]
fn native_button_keyboard_activates_exactly_once() {
    keyboard_contract("native");
}
#[test]
fn rendered_non_native_button_keyboard_activates_exactly_once() {
    keyboard_contract("custom");
}

#[test]
fn rendered_button_disabled_mid_space_cancels_arming_and_restores_tabstop() {
    // Failure mode: disabled state must clear pending nonnative Space activation.
    let mut doc = document();
    assert_eq!(count(&doc, "custom-ref"), 1);
    assert_eq!(attr(&doc, "custom", "role").as_deref(), Some("button"));
    assert_eq!(attr(&doc, "custom", "tabindex").as_deref(), Some("0"));
    focus(&mut doc, "custom");
    key(&mut doc, " ", false, false);
    policy(&mut doc, json!({"disabled":true}));
    assert_eq!(attr(&doc, "custom", "tabindex").as_deref(), Some("-1"));
    assert_eq!(
        attr(&doc, "custom", "aria-disabled").as_deref(),
        Some("true")
    );
    assert_eq!(
        attr(&doc, "custom", "data-render-disabled").as_deref(),
        Some("true")
    );
    pointer(&mut doc, "custom");
    policy(&mut doc, json!({"disabled":false}));
    focus(&mut doc, "custom");
    key(&mut doc, " ", true, false);
    assert_eq!(count(&doc, "custom-click"), 0);
    assert_eq!(attr(&doc, "custom", "tabindex").as_deref(), Some("0"));
    key(&mut doc, "Enter", false, false);
    assert_eq!(count(&doc, "custom-click"), 1);
}

#[test]
fn controlled_toggle_requests_without_mutating_rejected_owner_value() {
    // Done-when: controlled and uncontrolled semantics must not be conflated.
    let mut doc = document();
    pointer(&mut doc, "controlled");
    assert_eq!(text(&doc, "requested"), "true");
    assert_eq!(count(&doc, "controlled-change"), 1);
    assert_eq!(
        attr(&doc, "controlled", "aria-pressed").as_deref(),
        Some("false")
    );
    policy(&mut doc, json!({"pressed":true}));
    assert_eq!(
        attr(&doc, "controlled", "data-pressed").as_deref(),
        Some("")
    );
    policy(&mut doc, json!({"accept":true}));
    pointer(&mut doc, "controlled");
    assert_eq!(
        attr(&doc, "controlled", "aria-pressed").as_deref(),
        Some("false")
    );
    assert_eq!(attr(&doc, "controlled", "data-pressed"), None);
    assert_eq!(count(&doc, "controlled-change"), 2);
}

#[test]
fn input_aria_relationships_and_render_state_follow_reactive_props() {
    // Done-when: owner ARIA IDs compose with generated label/description IDs.
    let mut doc = document();
    assert_eq!(count(&doc, "input-ref"), 1);
    assert_eq!(
        attr(&doc, "editor", "aria-labelledby").as_deref(),
        Some("external-label editor-label")
    );
    assert_eq!(
        attr(&doc, "editor", "aria-describedby").as_deref(),
        Some("external-description editor-description")
    );
    assert_eq!(text(&doc, "editor-label"), "Task");
    assert_eq!(text(&doc, "editor-description"), "One task");
    policy(
        &mut doc,
        json!({"name":"renamed","label":"New label","description":"New help","invalid":true,"class":"changed"}),
    );
    assert_eq!(text(&doc, "renamed-label"), "New label");
    assert_eq!(text(&doc, "renamed-description"), "New help");
    assert_eq!(
        attr(&doc, "renamed", "aria-labelledby").as_deref(),
        Some("external-label renamed-label")
    );
    assert_eq!(
        attr(&doc, "renamed", "aria-describedby").as_deref(),
        Some("external-description renamed-description")
    );
    assert_eq!(
        attr(&doc, "renamed", "aria-invalid").as_deref(),
        Some("true")
    );
    assert_eq!(attr(&doc, "renamed", "data-invalid").as_deref(), Some(""));
    assert_eq!(
        attr(&doc, "renamed", "data-render-invalid").as_deref(),
        Some("true")
    );
    assert_eq!(
        attr(&doc, "renamed", "class").as_deref(),
        Some("tk-input changed")
    );
    assert!(doc.inner().get_element_by_id("editor-label").is_none());
    policy(&mut doc, json!({"invalid":false}));
    assert_eq!(attr(&doc, "renamed", "data-invalid"), None);
    assert_eq!(count(&doc, "input-ref"), 1);
}

#[test]
fn controlled_input_restores_rejected_native_edits_and_composes_callbacks() {
    // Failure mode: Solid skips equal value writes after native editing. Rejecting
    // an edit must restore the actual Blitz editor, not just a JS signal/attribute.
    let mut doc = document();
    pointer(&mut doc, "editor");
    assert_eq!(attr(&doc, "editor", "data-focused").as_deref(), Some(""));
    assert_eq!(count(&doc, "input-focus"), 1);
    key(&mut doc, "x", false, false);
    assert_eq!(count(&doc, "render-input"), 1);
    assert_eq!(count(&doc, "input-handler"), 1);
    assert_eq!(count(&doc, "input-change"), 1);
    assert!(text(&doc, "requested").contains('x'));
    assert_eq!(editor(&doc, "editor"), "fixed");
    policy(&mut doc, json!({"accept":true}));
    key(&mut doc, "y", false, false);
    assert_eq!(editor(&doc, "editor"), text(&doc, "requested"));
    assert!(editor(&doc, "editor").contains('y'));
    let accepted = editor(&doc, "editor");
    // Input is a noncancelable notification after native editing. The owner,
    // not preventDefault on that notification, decides whether to accept it.
    policy(&mut doc, json!({"cancel":true,"accept":false}));
    key(&mut doc, "z", false, false);
    assert_eq!(count(&doc, "input-cancelable-false"), 3);
    assert_eq!(count(&doc, "input-change"), 3);
    assert_eq!(editor(&doc, "editor"), accepted);
    // Cancel at keydown instead: this precedes native editing and must never
    // generate an input notification or call the composed value callback.
    policy(
        &mut doc,
        json!({"cancel":false,"cancelKey":true,"accept":true}),
    );
    key(&mut doc, "w", false, false);
    assert_eq!(editor(&doc, "editor"), accepted);
    assert_eq!(count(&doc, "input-change"), 3);
    policy(&mut doc, json!({"disabled":true,"cancelKey":false}));
    assert_eq!(attr(&doc, "editor", "data-disabled").as_deref(), Some(""));
    assert_eq!(attr(&doc, "editor", "data-focused"), None);
    key(&mut doc, "q", false, false);
    assert_eq!(editor(&doc, "editor"), accepted);
    assert_eq!(count(&doc, "input-change"), 3);
    focus(&mut doc, "uncontrolled");
    assert!(count(&doc, "input-blur") >= 1);
    assert!(doc.take_error().is_none());
}

#[test]
fn uncontrolled_input_keeps_native_edits_and_callbacks_without_owner_value() {
    // Done-when: defaultValue initializes once but does not pin later edits.
    let mut doc = document();
    assert_eq!(editor(&doc, "uncontrolled"), "seed");
    pointer(&mut doc, "uncontrolled");
    key(&mut doc, "a", false, false);
    let value = editor(&doc, "uncontrolled");
    assert!(value.contains('a'));
    assert_eq!(count(&doc, "uncontrolled-change"), 1);
    policy(
        &mut doc,
        json!({"value":"owner change","defaultValue":"new default"}),
    );
    assert_eq!(editor(&doc, "uncontrolled"), value);
    assert!(doc.take_error().is_none());
}

#[test]
fn input_disabled_reactivity_prevents_edits_and_clears_focus_state() {
    // Done-when: disabled is a live native editing policy, not merely ARIA.
    let mut doc = document();
    pointer(&mut doc, "editor");
    policy(&mut doc, json!({"disabled":true,"accept":true}));
    assert_eq!(attr(&doc, "editor", "disabled").as_deref(), Some(""));
    assert_eq!(
        attr(&doc, "editor", "aria-disabled").as_deref(),
        Some("true")
    );
    assert_eq!(attr(&doc, "editor", "data-focused"), None);
    key(&mut doc, "x", false, false);
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit("語".into())));
    assert_eq!(editor(&doc, "editor"), "fixed");
    assert_eq!(count(&doc, "input-change"), 0);
    policy(&mut doc, json!({"disabled":false}));
    pointer(&mut doc, "editor");
    key(&mut doc, "y", false, false);
    assert!(editor(&doc, "editor").contains('y'));
    assert_eq!(count(&doc, "input-change"), 1);
    assert!(doc.take_error().is_none());
}

#[test]
fn shipped_showcase_runs_real_elements_and_native_input() {
    // Done-when: the shipped demo must consume the kit in real QuickJS/Blitz,
    // not hand-built lookalikes or a DOM-only fixture.
    let bundle =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/dist/demo.js")).unwrap();
    let shell =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/dist/shell.html")).unwrap();
    let mut doc = render::NativeDocument::new(&shell, &bundle).unwrap();
    doc.inner_mut().set_viewport(blitz_traits::shell::Viewport {
        window_size: (1000, 1600),
        ..Default::default()
    });
    assert_eq!(
        attr(&doc, "increment", "data-part").as_deref(),
        Some("button")
    );
    assert_eq!(attr(&doc, "editor", "data-part").as_deref(), Some("input"));
    assert_eq!(
        attr(&doc, "increment", "class").as_deref(),
        Some("tk-button")
    );
    pointer(&mut doc, "increment");
    assert_eq!(
        attr(&doc, "increment", "aria-pressed").as_deref(),
        Some("true")
    );
    pointer(&mut doc, "editor");
    key(&mut doc, "x", false, false);
    assert_eq!(editor(&doc, "editor"), "x");
    pointer(&mut doc, "clear");
    assert_eq!(editor(&doc, "editor"), "");
    assert!(doc.take_error().is_none());
}

fn wrapped_activation_contract(activation: &str, cancel: bool, stop: bool) {
    // Composition regression: native and swapped elements must dispatch the
    // final rendered click handler, not call Button's earlier props directly.
    // A click remains a bubbling click after preventDefault; stopPropagation is
    // independent. The same event object must reach wrapper, owner and ancestor.
    let mut doc = document();
    policy(&mut doc, json!({"renderCancel":cancel,"renderStop":stop}));
    pointer(&mut doc, "wrapped");
    assert_wrapped_clicks(&doc, 1, cancel, stop);
    focus(&mut doc, "wrapped");
    key(&mut doc, activation, false, false);
    key(&mut doc, activation, false, true);
    if activation == " " {
        assert_wrapped_clicks(&doc, 1, cancel, stop);
    }
    key(&mut doc, activation, true, false);
    key(&mut doc, activation, true, false);
    assert_wrapped_clicks(&doc, 2, cancel, stop);
    assert!(doc.take_error().is_none());
}

fn assert_wrapped_clicks(doc: &render::NativeDocument, clicks: u64, cancel: bool, stop: bool) {
    assert_eq!(
        count(doc, "wrapped-render"),
        clicks,
        "every activation must reach the final render wrapper"
    );
    assert_eq!(count(doc, "wrapped-owner"), clicks);
    assert_eq!(
        count(doc, "wrapped-owner-click"),
        clicks,
        "activation must deliver a click, not reuse a keyboard event"
    );
    assert_eq!(count(doc, "wrapped-owner-identity"), clicks);
    let bubbles = if stop {
        0
    } else {
        clicks
    };
    assert_eq!(
        count(doc, "wrapped-parent"),
        bubbles,
        "click ancestor must observe the same pointer/keyboard bubbling policy"
    );
    assert_eq!(count(doc, "wrapped-parent-click"), bubbles);
    assert_eq!(count(doc, "wrapped-parent-identity"), bubbles);
    assert_eq!(
        count(doc, "wrapped-parent-prevented"),
        if cancel {
            bubbles
        } else {
            0
        }
    );
    assert_eq!(
        count(doc, "wrapped-change"),
        if cancel {
            0
        } else {
            clicks
        }
    );
    assert_eq!(
        attr(doc, "wrapped", "aria-pressed").as_deref(),
        Some(if !cancel && clicks % 2 == 1 {
            "true"
        } else {
            "false"
        })
    );
}

#[test]
fn rendered_button_enter_obeys_final_click_wrapper_cancellation() {
    wrapped_activation_contract("Enter", true, false);
}
#[test]
fn rendered_button_space_obeys_final_click_wrapper_cancellation() {
    wrapped_activation_contract(" ", true, false);
}
#[test]
fn rendered_button_enter_click_bubbles_once_through_final_wrapper() {
    wrapped_activation_contract("Enter", false, false);
}
#[test]
fn rendered_button_space_click_bubbles_once_through_final_wrapper() {
    wrapped_activation_contract(" ", false, false);
}
#[test]
fn rendered_button_keyboard_preserves_final_wrapper_stop_propagation() {
    wrapped_activation_contract("Enter", false, true);
    wrapped_activation_contract(" ", false, true);
}

#[test]
fn rendered_button_empty_string_click_throw_reports_error_flushes_and_recovers() {
    // Regression: error:string|null must distinguish an empty thrown string
    // from no error. Keyboard activation nests final click dispatch inside the
    // native key turn; a truthiness guard silently drops this listener failure.
    let mut doc = document();
    policy(
        &mut doc,
        json!({"renderCancel":false,"renderThrowEmpty":true}),
    );
    focus(&mut doc, "wrapped");
    key(&mut doc, "Enter", false, false);
    assert!(
        doc.take_error().is_some(),
        "an empty-string listener throw must still report an error to the native turn"
    );
    assert_eq!(
        count(&doc, "wrapped-render"),
        1,
        "valid signal writes before the throw must flush in the failing turn"
    );
    assert_eq!(count(&doc, "wrapped-owner"), 0);
    assert_eq!(count(&doc, "wrapped-parent"), 0);
    assert_eq!(
        attr(&doc, "wrapped", "aria-pressed").as_deref(),
        Some("false")
    );
    assert!(doc.take_error().is_none(), "taking the error consumes it");

    // Listener exceptions are recoverable, unlike a rejected native mutation
    // batch: the same document must accept host updates and another activation.
    policy(&mut doc, json!({"renderThrowEmpty":false}));
    key(&mut doc, "Enter", true, false);
    key(&mut doc, "Enter", false, false);
    key(&mut doc, "Enter", true, false);
    assert_eq!(count(&doc, "wrapped-render"), 2);
    assert_eq!(count(&doc, "wrapped-owner"), 1);
    assert_eq!(count(&doc, "wrapped-parent"), 1);
    assert_eq!(count(&doc, "wrapped-change"), 1);
    assert_eq!(
        attr(&doc, "wrapped", "aria-pressed").as_deref(),
        Some("true")
    );
    assert!(doc.take_error().is_none());
}
