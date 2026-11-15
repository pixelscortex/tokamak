//! Read the real editor caret after layout, so page-drawn carets follow native
//! editing, scrolling and wrapping without guessing text widths in JS.
use crate::{Error, Result, bridge::Bridge};
use blitz_dom::{BaseDocument, Document};
use blitz_html::HtmlDocument;
use blitz_traits::NodeId;
use serde::Serialize;
use serde_json::json;
use std::{collections::HashSet, sync::atomic::Ordering};

#[derive(Default)]
pub(super) struct Observed {
    nodes: HashSet<NodeId>,
    last: Option<(NodeId, Report)>,
    geometry: Option<(NodeId, [f64; 8])>,
}

impl Observed {
    pub(super) fn observe(&mut self, node: NodeId, enabled: bool) {
        if enabled {
            self.nodes.insert(node);
        } else {
            self.nodes.remove(&node);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    at_end: bool,
}

fn report(
    doc: &mut BaseDocument,
    id: NodeId,
    geometry: &mut Option<(NodeId, [f64; 8])>,
) -> Option<Report> {
    let node = doc.get_node_mut(id)?;
    if !node.flags.is_in_document() {
        return None;
    }
    let width = node.final_layout().content_box_width();
    let height = node.final_layout().content_box_height();
    // The public centering helper expects an initialized editor layout.
    let scale = node
        .element_data()?
        .text_input_data()?
        .editor
        .try_layout()?
        .scale();
    let y_offset = node.text_input_v_centering_offset(f64::from(scale));
    let input = node.element_data_mut()?.text_input_data_mut()?;
    let layout = input.editor.try_layout()?;
    let scale = f64::from(layout.scale());
    // Zero width gives the insertion point, rather than the left edge of
    // Blitz's centred 1.5 px caret. Parley geometry uses device pixels.
    let rect = input.editor.cursor_geometry(0.0)?;
    let now = (
        id,
        [
            f64::from(width),
            f64::from(height),
            scale,
            rect.x0,
            rect.y0,
            rect.y1,
            f64::from(layout.height()),
            f64::from(layout.full_width()),
        ],
    );
    if *geometry != Some(now) {
        // beta.4 clamps during input events, before reactive growth or a later
        // resize rewraps the text. Reuse its public clamp after those changes.
        // Comparing unscrolled geometry leaves deliberate wheel scrolling alone.
        input.clamp_scroll_offset(width, height);
        *geometry = Some(now);
    }
    let (scroll_x, scroll_y) = if input.is_multiline {
        (0.0, f64::from(input.scroll_offset))
    } else {
        (f64::from(input.scroll_offset), 0.0)
    };
    let selection = input.editor.raw_selection();
    Some(Report {
        x: rect.x0 / scale - scroll_x,
        y: rect.y0 / scale + y_offset - scroll_y,
        width: (rect.x1 - rect.x0) / scale,
        height: (rect.y1 - rect.y0) / scale,
        at_end: selection.is_collapsed()
            && selection.focus().index() == input.editor.raw_text().len(),
    })
}

pub(super) fn report_caret(bridge: &mut Bridge, html: &mut HtmlDocument) -> Result<bool> {
    let observed = &mut bridge.tree.caret;
    if !bridge.alive.load(Ordering::Acquire)
        || (observed.nodes.is_empty() && observed.last.is_none())
    {
        return Ok(false);
    }
    let now = {
        let mut doc = html.inner_mut();
        doc.get_focussed_node_id()
            .filter(|id| observed.nodes.contains(id))
            .and_then(|id| report(&mut doc, id, &mut observed.geometry).map(|r| (id, r)))
    };
    if now.is_none() {
        observed.geometry = None;
    }
    if now == observed.last {
        return Ok(false);
    }
    let previous = std::mem::replace(&mut observed.last, now);
    // Clear the old element even when focus moved to an unobserved input or
    // the editor/IME stopped exposing a caret. Selection painting stays native.
    if let Some((id, _)) = previous {
        if now.is_none_or(|(next, _)| next != id) {
            send(bridge, html, id, json!(null))?;
        }
    }
    if let Some((id, caret)) = now {
        send(bridge, html, id, json!(caret))?;
    }
    Ok(true)
}

fn send(
    bridge: &mut Bridge,
    html: &mut HtmlDocument,
    id: NodeId,
    caret: serde_json::Value,
) -> Result<()> {
    let response = bridge.send_event(
        html,
        &[id],
        id,
        json!({"type":"caretchange", "bubbles":false, "cancelable":false,
            "isComposing":bridge.composition.active(), "caret":caret}),
        "Invalid caret event response: ",
    )?;
    if let Some(error) = response.error {
        return Err(Error(error));
    }
    Ok(())
}
