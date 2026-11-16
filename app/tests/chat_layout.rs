//! Streaming and one-shot layout must agree in the real Solid/Blitz message UI.
#[path = "support/capture.rs"]
mod capture;
#[allow(dead_code)]
#[path = "../../packages/render/tests/support/mod.rs"]
mod support;

use blitz_dom::Document;
use blitz_traits::{NodeId, shell::Viewport};
use render::NativeDocument;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn document(width: u32) -> NativeDocument {
    let app = Path::new(env!("CARGO_MANIFEST_DIR"));
    let css = ["dist/styles.css", "../plugins/chat/dist/styles.css"]
        .map(|path| std::fs::read_to_string(app.join(path)).unwrap())
        .join("\n");
    let shell = format!(
        "<!doctype html><html><head><style>{css} #chat-layout-column {{ width: {}px; }}</style></head><body><div id=\"app\"></div></body></html>",
        width + 30,
    );
    let mut doc = NativeDocument::new_connected_with_fonts(
        &shell,
        &std::fs::read_to_string(app.join("dist/tests/chat-layout.js")).unwrap(),
        None,
        &[
            include_bytes!("../assets/fonts/SpaceGrotesk-Variable.ttf"),
            include_bytes!("../assets/fonts/SpaceMono-Regular.ttf"),
        ],
    )
    .unwrap();
    doc.inner_mut().set_viewport(Viewport {
        window_size: (width + 173, 832),
        ..Default::default()
    });
    doc.resolve_layout(0.0);
    doc
}

fn update(doc: &mut NativeDocument, parts: &[Value], status: &str) {
    doc.host_event(
        doc.generation(),
        "message",
        json!({ "_id": "layout-message", "role": "assistant", "status": status, "parts": parts }),
    )
    .unwrap();
    doc.resolve_layout(0.0);
    assert!(doc.take_error().is_none());
}

fn select(doc: &NativeDocument, selector: &str) -> NodeId {
    doc.inner().query_selector(selector).unwrap().unwrap()
}

#[derive(Debug, PartialEq)]
struct LayoutBox {
    rect: [f64; 4],
    // Painted text width/height/line count: element boxes alone miss this bug.
    text: Option<[f32; 3]>,
}

fn boxes(doc: &NativeDocument) -> Vec<LayoutBox> {
    fn walk(doc: &NativeDocument, id: NodeId, result: &mut Vec<LayoutBox>) {
        let inner = doc.inner();
        let node = inner.get_node(id).unwrap();
        if let Some(element) = node.element_data() {
            let rect = inner.get_client_bounding_rect(id).unwrap();
            result.push(LayoutBox {
                rect: [rect.x, rect.y, rect.width, rect.height],
                text: element.inline_layout_data.as_ref().map(|text| {
                    [
                        text.layout.width(),
                        text.layout.height(),
                        text.layout.lines().count() as f32,
                    ]
                }),
            });
        }
        for child in &node.children {
            walk(doc, *child, result);
        }
    }
    let mut result = Vec::new();
    walk(doc, select(doc, "[data-message] > div > div"), &mut result);
    result
}

fn assert_layout(doc: &NativeDocument, width: u32) {
    let inner = doc.inner();
    let id = select(doc, "[data-message] > div > div");
    let column = inner.get_client_bounding_rect(id).unwrap();
    assert!(
        (column.width - f64::from(width)).abs() < 0.5,
        "column: {column:?}"
    );
    let mut bottom = column.y;
    for id in &inner.get_node(id).unwrap().children {
        if inner.get_node(*id).unwrap().element_data().is_none() {
            continue;
        }
        let rect = inner.get_client_bounding_rect(*id).unwrap();
        assert!(
            rect.y >= bottom - 0.5,
            "overlapping part: {rect:?}, preceding bottom {bottom}"
        );
        assert!(
            (rect.x - column.x).abs() < 0.5 && (rect.width - column.width).abs() < 0.5,
            "narrow part: {rect:?}, column {column:?}"
        );
        bottom = rect.y + rect.height;
    }
    for layout in boxes(doc) {
        if let Some([text_width, text_height, _]) = layout.text {
            assert!(
                f64::from(text_height) <= layout.rect[3] + 0.5,
                "painted lines overflow their allocated height: {layout:?}"
            );
            assert!(
                f64::from(text_width) <= layout.rect[2] + 0.5,
                "painted text exceeds its allocated width: {layout:?}"
            );
        }
    }
}

fn capture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("dist/tests/chat-layout")
        .join(format!("{name}.png"))
}

fn compare_fresh(streamed: &NativeDocument, parts: &[Value], status: &str, width: u32) {
    assert_layout(streamed, width);
    let mut fresh = document(width);
    update(&mut fresh, parts, status);
    assert_layout(&fresh, width);
    assert_eq!(
        boxes(streamed),
        boxes(&fresh),
        "streamed layout differs from a fresh message"
    );
}

fn stream_mixed_message(width: u32, long_first: bool) {
    let mut streamed = document(width);
    let mut parts = Vec::new();
    let paragraphs = [
        if long_first {
            "I’ll check what this session exposes for ACP. This paragraph grows over many small updates before the first tool starts. It needs more than one line even when the entire message column is available, so its measured height must grow with its text."
        } else {
            "I’ll check what this session exposes for ACP."
        },
        "I’m using OpenAI Docs to check ACP terminology; the session itself doesn’t expose an ACP connection status to me. This paragraph continues long enough to need several lines, including in a wide message column, before another tool is appended.",
        "The messages and tool calls are working here. This final paragraph is appended after the last tool call and should use exactly the same available width as both earlier paragraphs in this message. All paragraphs must have the same layout they would have had when mounted together.",
    ];
    for (index, paragraph) in paragraphs.iter().enumerate() {
        let part_index = parts.len();
        let mut text = String::new();
        for chunk in paragraph.split_inclusive(' ') {
            text.push_str(chunk);
            let part = json!({ "type": "text", "text": text });
            if parts.len() == part_index {
                parts.push(part);
            } else {
                parts[part_index] = part;
            }
            update(&mut streamed, &parts, "streaming");
            assert_layout(&streamed, width);
        }
        if index < 2 {
            // Keep the completed paragraph mounted while appending a sibling.
            // On main, this alone leaves its 530x26 box with 5 painted lines.
            let paragraph_id = select(&streamed, ".chat-markdown p");
            parts.push(json!({
                "type": "tool", "callId": format!("call-{index}"), "plugin": "acp",
                "toolName": "read_file", "args": {}, "status": "running"
            }));
            update(&mut streamed, &parts, "streaming");
            assert_eq!(select(&streamed, ".chat-markdown p"), paragraph_id);
            compare_fresh(&streamed, &parts, "streaming", width);
            let tool = parts.last_mut().unwrap();
            tool["status"] = json!("done");
            tool["summary"] = json!(if index == 0 {
                "Read file '/Users/justkira/.codex/skills/.system/openai-docs/SKILL.md'"
            } else {
                "Read file '/Users/x/workspace/project/docs/agent-client-protocol/connection-and-streaming-behavior.md'"
            });
            update(&mut streamed, &parts, "streaming");
            compare_fresh(&streamed, &parts, "streaming", width);
        }
    }
    let name = format!(
        "{width}-{}",
        if long_first {
            "long"
        } else {
            "short"
        }
    );
    capture::save(&mut streamed, &capture_path(&format!("{name}-streaming")));
    compare_fresh(&streamed, &parts, "streaming", width);
    update(&mut streamed, &parts, "complete");
    capture::save(&mut streamed, &capture_path(&format!("{name}-finished")));
    compare_fresh(&streamed, &parts, "complete", width);
}

#[test]
fn streamed_mixed_message_matches_one_shot_layout() {
    for width in [530, 1060] {
        for long_first in [false, true] {
            stream_mixed_message(width, long_first);
        }
    }
}

#[test]
fn changing_other_parts_preserves_layout_and_tool_expansion() {
    let width = 530;
    let mut doc = document(width);
    let mut parts = vec![
        json!({ "type": "text", "text": "Before the changing parts." }),
        json!({ "type": "tool", "callId": "call-0", "plugin": "acp", "toolName": "read_file", "args": { "path": "/Users/x/project/README.md" }, "status": "running" }),
        json!({ "type": "plan", "entries": [{ "content": "Check", "status": "pending", "priority": "medium" }] }),
        json!({ "type": "permission", "requestId": "request-0", "title": "Read files", "options": [{ "optionId": "yes", "name": "Allow once", "kind": "allow_once" }], "status": "pending" }),
        json!({ "type": "text", "text": "After the changing parts." }),
    ];
    update(&mut doc, &parts, "streaming");
    let button = select(&doc, "button[aria-expanded]");
    support::pointer_node(&mut doc, button);
    doc.resolve_layout(0.0);
    assert_layout(&doc, width);
    parts[1]["status"] = json!("done");
    parts[1]["summary"] =
        json!("Read file '/Users/justkira/.codex/skills/.system/openai-docs/SKILL.md'");
    parts[1]["result"] =
        json!({ "content": "The tool completed while its details were expanded." });
    parts[2]["entries"][0]["content"] = json!("Inspect the layout of every updated text block and tool summary in the conversation before reporting the result. ".repeat(3));
    parts[3]["status"] = json!("answered");
    parts[3]["optionId"] = json!("yes");
    update(&mut doc, &parts, "complete");
    assert_eq!(select(&doc, "button[aria-expanded=true]"), button);
    assert_layout(&doc, width);
    let mut fresh = document(width);
    update(&mut fresh, &parts, "complete");
    let fresh_button = select(&fresh, "button[aria-expanded]");
    support::pointer_node(&mut fresh, fresh_button);
    fresh.resolve_layout(0.0);
    assert_layout(&fresh, width);
    assert_eq!(boxes(&doc), boxes(&fresh));
}
