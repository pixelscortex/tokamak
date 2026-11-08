//! The actual lab bundle on the production native controls, without a backend.
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;
use blitz_dom::Document;
use blitz_traits::{events::*, shell::Viewport};
use render::NativeDocument;

fn document() -> NativeDocument {
    let mut doc = NativeDocument::new(
        include_str!("../dist/shell.html"),
        include_str!("../dist/ui.js"),
    )
    .unwrap();
    doc.inner_mut().set_viewport(Viewport {
        window_size: (1160, 1800),
        ..Default::default()
    });
    doc.inner_mut().resolve(0.0);
    doc
}

#[test]
fn real_controls_edit_validate_toggle_and_remount_without_a_server() {
    let mut doc = document();
    assert!(support::text(&doc, "lab").contains("Component lab"));
    assert!(!include_str!("../dist/ui.js").contains("todo:list"));
    support::pointer(&mut doc, "lab-action");
    assert_eq!(support::text(&doc, "lab-action-count"), "1 activations");
    support::focus(&mut doc, "lab-action");
    support::key(&mut doc, "Enter", false, false);
    assert_eq!(support::text(&doc, "lab-action-count"), "2 activations");
    support::pointer(&mut doc, "lab-disabled-action");
    assert_eq!(support::text(&doc, "lab-action-count"), "2 activations");
    support::pointer(&mut doc, "lab-toggle");
    assert_eq!(
        support::attr(&doc, "lab-toggle", "aria-pressed").as_deref(),
        Some("true")
    );
    support::focus(&mut doc, "lab-controlled");
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit(" edited".into())));
    assert!(support::text(&doc, "lab-input-value").contains("edited"));
    assert_eq!(
        support::attr(&doc, "lab-invalid", "aria-invalid").as_deref(),
        Some("true")
    );
    support::focus(&mut doc, "lab-invalid");
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit("core".into())));
    assert_eq!(
        support::attr(&doc, "lab-invalid", "aria-invalid").as_deref(),
        Some("false")
    );
    support::focus(&mut doc, "lab-readonly");
    let before = support::editor(&doc, "lab-readonly");
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit("blocked".into())));
    assert_eq!(support::editor(&doc, "lab-readonly"), before);
    support::pointer(&mut doc, "lab-save");
    assert_eq!(
        support::text(&doc, "lab-save-status"),
        "Saved preview: Design workspace"
    );
    support::pointer(&mut doc, "lab-reset");
    doc.inner_mut().resolve(0.0);
    assert_eq!(
        support::editor(&doc, "lab-controlled"),
        "Personal workspace"
    );
    assert_eq!(support::text(&doc, "lab-action-count"), "0 activations");
    support::pointer(&mut doc, "lab-filter-buttons");
    assert!(doc.inner().get_element_by_id("lab-controlled").is_none());
    assert!(doc.inner().get_element_by_id("lab-action").is_some());
    assert!(doc.take_error().is_none());
}

#[test]
fn cards_fit_wide_and_narrow_native_viewports() {
    let mut doc = document();
    for width in [1160, 820, 620] {
        doc.inner_mut().set_viewport(Viewport {
            window_size: (width, 1800),
            ..Default::default()
        });
        doc.inner_mut().resolve(0.0);
        for name in ["inputs", "actions", "settings", "foundations"] {
            let id = support::id(&doc, &format!("lab-case-{name}"));
            let rect = doc.inner().get_client_bounding_rect(id).unwrap();
            assert!(
                rect.x >= 0.0 && rect.x + rect.width <= width as f64 + 1.0,
                "{name}: {rect:?}"
            );
        }
    }
}
