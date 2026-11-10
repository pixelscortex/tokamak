//! The actual lab bundle on the production native controls, without a backend.
//! The controls live in the Components section of the lab shell.
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;
use blitz_dom::Document;
use blitz_traits::{events::*, shell::Viewport};
use render::NativeDocument;

fn document(width: u32) -> NativeDocument {
    section(width, "components")
}

/// The lab at `width` x 900 with `name`'s rail section open.
fn section(width: u32, name: &str) -> NativeDocument {
    let mut doc = NativeDocument::new(
        include_str!("../dist/shell.html"),
        include_str!("../dist/ui.js"),
    )
    .unwrap();
    doc.inner_mut().set_viewport(Viewport {
        window_size: (width, 900),
        ..Default::default()
    });
    doc.inner_mut().resolve(0.0);
    support::pointer(&mut doc, &format!("lab-rail-{name}"));
    doc.inner_mut().resolve(0.0);
    doc
}

/// Tab focus like `support::focus`, with room for the shell's top bar and rail
/// controls, which come before the section's controls in tab order.
fn focus(doc: &mut NativeDocument, name: &str) {
    doc.inner_mut().resolve(0.0);
    for _ in 0..48 {
        if doc.inner().get_focussed_node_id() == Some(support::id(doc, name)) {
            return;
        }
        support::key(doc, "Tab", false, false);
    }
    panic!("Tab could not focus {name}");
}

#[test]
fn real_controls_edit_validate_toggle_and_remount_without_a_server() {
    let mut doc = document(1440);
    assert!(support::text(&doc, "lab").contains("Component lab"));
    assert!(!include_str!("../dist/ui.js").contains("todo:list"));
    support::pointer(&mut doc, "lab-action");
    assert_eq!(support::text(&doc, "lab-action-count"), "1 activations");
    focus(&mut doc, "lab-action");
    support::key(&mut doc, "Enter", false, false);
    assert_eq!(support::text(&doc, "lab-action-count"), "2 activations");
    support::pointer(&mut doc, "lab-disabled-action");
    assert_eq!(support::text(&doc, "lab-action-count"), "2 activations");
    support::pointer(&mut doc, "lab-toggle");
    assert_eq!(
        support::attr(&doc, "lab-toggle", "aria-pressed").as_deref(),
        Some("true")
    );
    focus(&mut doc, "lab-controlled");
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit(" edited".into())));
    assert!(support::text(&doc, "lab-input-value").contains("edited"));
    assert_eq!(
        support::attr(&doc, "lab-invalid", "aria-invalid").as_deref(),
        Some("true")
    );
    focus(&mut doc, "lab-invalid");
    doc.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit("core".into())));
    assert_eq!(
        support::attr(&doc, "lab-invalid", "aria-invalid").as_deref(),
        Some("false")
    );
    focus(&mut doc, "lab-readonly");
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

/// The lab window's minimum size (app.config.json `minWidth`/`minHeight`).
fn min_window() -> (u32, u32) {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../app.config.json")).unwrap();
    let get = |key: &str| config[key].as_u64().unwrap() as u32;
    (get("minWidth"), get("minHeight"))
}

fn rect(doc: &NativeDocument, name: &str) -> blitz_dom::BoundingRect {
    doc.inner()
        .get_client_bounding_rect(support::id(doc, name))
        .unwrap()
}

/// Chat at wide to minimum widths: the reading column shrinks with the
/// stage and never runs into the context column (which gets out of the way
/// below a 1200 px window), and the title notch and composer follow the
/// column, their fused shapes (fillets, the notch's slant) staying inside
/// the stage. Nothing in the top bar or the plugin sidebar overlaps.
#[test]
fn chat_fits_wide_and_narrow_stages() {
    let (min_width, min_height) = min_window();
    let mut doc = section(1440, "chat");
    for (width, height) in [
        (1440, 900),
        (1100, 900),
        (900, 900),
        (min_width, min_height),
    ] {
        doc.inner_mut().set_viewport(Viewport {
            window_size: (width, height),
            ..Default::default()
        });
        doc.inner_mut().resolve(0.0);
        let stage = rect(&doc, "shell-stage");
        let column = rect(&doc, "lab-chat-column");
        let context = rect(&doc, "lab-chat-context");
        let shown = context.width > 0.0;
        assert_eq!(shown, width >= 1200, "{width}: context column shown");
        for name in ["lab-chat-bubble", "lab-chat-card", "lab-chat-reply"] {
            let r = rect(&doc, name);
            assert!(
                r.x >= column.x - 0.5 && r.x + r.width <= column.x + column.width + 0.5,
                "{width}: {name} {r:?} outside the column {column:?}"
            );
            if shown {
                assert!(
                    r.x + r.width <= context.x,
                    "{width}: {name} {r:?} runs into the context column {context:?}"
                );
            }
        }
        assert!(
            column.width <= 640.0 && column.width > 300.0,
            "{width}: {column:?}"
        );
        // Fused shapes: the composer's fillets reach 22 px beyond its box,
        // the notch's slant 40 * tan(22 deg) ~ 16 px plus its 14 px fillet.
        for (name, reach) in [("lab-chat-composer-shape", 22.0), ("lab-chat-notch", 31.0)] {
            let r = rect(&doc, name);
            assert!(
                r.x - reach >= stage.x && r.x + r.width + reach <= stage.x + stage.width,
                "{width}: {name} {r:?} (+{reach}) leaves the stage {stage:?}"
            );
            assert!(
                r.x >= column.x - 16.5 && r.x + r.width <= column.x + column.width + 0.5,
                "{width}: {name} {r:?} detached from the column {column:?}"
            );
        }
        // The plugin sidebar keeps its 220 px; the stage starts after it.
        let title = rect(&doc, "lab-chat-title");
        assert!(title.width > 40.0, "{width}: the title stays readable");
        // Top bar: start, search and end actions side by side.
        let search = rect(&doc, "lab-search");
        let toggle = rect(&doc, "lab-chat-context-toggle");
        let back = rect(&doc, "lab-back");
        assert!(
            back.x + back.width <= search.x,
            "{width}: {back:?} {search:?}"
        );
        assert!(
            search.x + search.width <= toggle.x,
            "{width}: {search:?} {toggle:?}"
        );
    }
    // The panel toggle hides the context column on a wide window too.
    doc.inner_mut().set_viewport(Viewport {
        window_size: (1440, 900),
        ..Default::default()
    });
    doc.inner_mut().resolve(0.0);
    support::pointer(&mut doc, "lab-chat-context-toggle");
    doc.inner_mut().resolve(0.0);
    assert_eq!(rect(&doc, "lab-chat-context").width, 0.0);
    assert!(doc.take_error().is_none());
}

/// The cards wrap to the stage's width (window minus rail, sidebar and gap),
/// and never overflow it.
#[test]
fn cards_fit_wide_and_narrow_stages() {
    let mut doc = document(1440);
    for width in [1440, 1100, min_window().0] {
        doc.inner_mut().set_viewport(Viewport {
            window_size: (width, 900),
            ..Default::default()
        });
        doc.inner_mut().resolve(0.0);
        let stage = doc
            .inner()
            .get_client_bounding_rect(support::id(&doc, "shell-stage"))
            .unwrap();
        let rects = ["inputs", "actions", "settings"].map(|name| {
            doc.inner()
                .get_client_bounding_rect(support::id(&doc, &format!("lab-case-{name}")))
                .unwrap()
        });
        if width >= 1440 {
            assert_eq!(rects[0].y, rects[2].y, "three columns");
        } else if width >= 1100 {
            assert_eq!(rects[0].y, rects[1].y, "two columns");
            assert!(rects[2].y > rects[0].y);
        } else {
            assert!(
                rects[0].y < rects[1].y && rects[1].y < rects[2].y,
                "one column"
            );
        }
        for rect in rects {
            assert!(
                rect.x >= stage.x && rect.x + rect.width <= stage.x + stage.width + 1.0,
                "{width}: {rect:?} outside {stage:?}"
            );
        }
    }
}

/// The native window's base colour (shown while a resize catches up) is the
/// theme's `--color-base`.
#[test]
fn window_base_colour_matches_the_theme_token() {
    let theme = include_str!("../../packages/ui/src/theme.css");
    let main = include_str!("../src/main.rs");
    let token = theme
        .lines()
        .find_map(|l| l.trim().strip_prefix("--color-base: #"))
        .and_then(|v| v.strip_suffix(';'))
        .unwrap();
    assert!(
        main.contains(&format!("WINDOW_BASE: u32 = 0x{token};")),
        "lab/src/main.rs WINDOW_BASE must equal --color-base #{token}"
    );
}
