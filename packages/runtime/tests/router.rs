//! Two separate production QuickJS/native documents, no browser globals/polyfill.
use blitz_dom::Document;
use render::NativeDocument;
use serde_json::json;

fn text(document: &NativeDocument, id: &str) -> String {
    let id = document.inner().get_element_by_id(id).unwrap();
    document.inner().get_node(id).unwrap().text_content()
}
fn event(document: &mut NativeDocument, action: &str, path: Option<&str>) {
    document
        .host_event(
            document.generation(),
            "route",
            json!({"action":action,"path":path}),
        )
        .unwrap();
}
#[test]
fn production_memory_routing_updates_native_views_and_keeps_windows_independent() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let output = std::process::Command::new("proto")
        .args(["run", "bun", "--", "tests/build-router.ts"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let bundle = std::fs::read_to_string(root.join("dist/tests/router.js")).unwrap();
    assert!(!bundle.contains("document.createElement"));
    assert!(!bundle.contains("window."));
    let shell = "<html><body><div id='app'></div></body></html>";
    let mut a = NativeDocument::new(shell, &bundle).unwrap();
    let b = NativeDocument::new(shell, &bundle).unwrap();
    assert_eq!(text(&a, "location"), "/threads");
    event(&mut a, "push", Some("/threads/one?tab=items#latest"));
    assert_eq!(text(&a, "thread"), "one");
    assert_eq!(text(&a, "location"), "/threads/one?tab=items#latest");
    event(&mut a, "back", None);
    assert_eq!(text(&a, "thread"), "none");
    event(&mut a, "forward", None);
    assert_eq!(text(&a, "thread"), "one");
    event(&mut a, "replace", Some("/threads/two"));
    assert_eq!(text(&a, "thread"), "two");
    assert_eq!(text(&b, "location"), "/threads");
    assert_eq!(text(&b, "thread"), "none");
}
