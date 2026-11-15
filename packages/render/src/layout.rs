//! Report observed element boxes to JS after Blitz layout.
//! Push reports avoid measuring before the JS turn's mutations are laid out.
use crate::{Result, bridge::Bridge};
use blitz_dom::{BaseDocument, Document};
use blitz_html::HtmlDocument;
use blitz_traits::NodeId;
use serde::Serialize;
use serde_json::json;
use std::{collections::BTreeMap, sync::atomic::Ordering};
use style::values::computed::Overflow;

#[derive(Default)]
pub(super) struct Observed {
    /// Elements marked `tk-observe` (layout.rs): their JS handle, and the
    /// layout last reported to JS (None: not reported yet, or it left the
    /// document and must be reported again when it returns).
    observed: BTreeMap<NodeId, (u32, Option<Report>)>,
}

impl Observed {
    pub(super) fn observe(&mut self, node: NodeId, handle: u32, enabled: bool) {
        if enabled {
            self.observed.entry(node).or_insert((handle, None));
        } else {
            self.observed.remove(&node);
        }
    }
}

pub(super) fn report_layout(bridge: &mut Bridge, html: &mut HtmlDocument) -> Result<bool> {
    if !bridge.alive.load(Ordering::Acquire) || bridge.tree.layout.observed.is_empty() {
        return Ok(false);
    }
    let mut changed = Vec::new();
    {
        let doc = html.inner();
        bridge
            .tree
            .layout
            .observed
            .retain(|id, _| doc.get_node(*id).is_some());
        for (node, (handle, last)) in bridge.tree.layout.observed.iter_mut() {
            let now = report(&doc, *node);
            if now != *last {
                *last = now;
                if let Some(r) = now {
                    changed.push(json!({"id": handle, "rect": r.rect, "clip": r.clip, "scroll": r.scroll}));
                }
            }
        }
    }
    if changed.is_empty() {
        return Ok(false);
    }
    let json = json!({"topic": "tk:layout", "payload": changed}).to_string();
    let result = bridge.js.call("host", Some(&json));
    bridge.flush(html)?;
    result?;
    Ok(true)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
struct Report {
    /// Border box: x, y, width, height (CSS px, window coordinates).
    rect: [f32; 4],
    /// Visible area: x, y, width, height (CSS px, window coordinates).
    clip: [f32; 4],
    /// Vertical scroll offset, content height and viewport height (CSS px).
    scroll: [f64; 3],
}

fn report(doc: &BaseDocument, node: NodeId) -> Option<Report> {
    let n = doc.get_node(node)?;
    if !n.flags.is_in_document() {
        return None;
    }
    let rect = border_box(doc, node)?;
    if rect[2] <= 0.0 && rect[3] <= 0.0 && n.primary_styles().is_none() {
        return None;
    }
    let viewport = doc.viewport();
    let scale = viewport.hidpi_scale * viewport.zoom;
    let (w, h) = viewport.window_size;
    let mut clip = [0.0, 0.0, w as f32 / scale, h as f32 / scale];
    let root = doc.root_element().id;
    let mut current = n.parent;
    while let Some(id) = current {
        let Some(ancestor) = doc.get_node(id) else {
            break;
        };
        current = ancestor.parent;
        // The root's overflow belongs to the window (as in blitz-paint).
        if id == root {
            continue;
        }
        let clips = ancestor.primary_styles().is_some_and(|s| {
            let b = s.get_box();
            b.overflow_x != Overflow::Visible || b.overflow_y != Overflow::Visible
        });
        if !clips {
            continue;
        }
        let Some(b) = border_box(doc, id) else {
            continue;
        };
        let border = ancestor.final_layout().border;
        let padding = [
            b[0] + border.left,
            b[1] + border.top,
            b[2] - border.left - border.right,
            b[3] - border.top - border.bottom,
        ];
        clip = intersect(clip, padding);
    }
    Some(Report {
        rect,
        clip,
        scroll: [n.scroll_offset().y, n.scroll_height() as f64, n.client_height() as f64],
    })
}

/// The border box of `node` in window coordinates. Blitz's client rect of
/// a scroll container also subtracts the container's OWN scroll offset
/// (blitz-dom 0.3.0-beta.4 `physical_unrounded_geometry` walks from the
/// node itself), so a scrolled scroller would seem to move up with its
/// content; that offset is added back.
pub(crate) fn border_box(doc: &BaseDocument, node: NodeId) -> Option<[f32; 4]> {
    let r = doc.get_client_bounding_rect(node)?;
    let own = doc.get_node(node)?.scroll_offset();
    Some([
        (r.x + own.x) as f32,
        (r.y + own.y) as f32,
        r.width as f32,
        r.height as f32,
    ])
}

fn intersect(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    let x0 = a[0].max(b[0]);
    let y0 = a[1].max(b[1]);
    let x1 = (a[0] + a[2]).min(b[0] + b[2]);
    let y1 = (a[1] + a[3]).min(b[1] + b[3]);
    [x0, y0, (x1 - x0).max(0.0), (y1 - y0).max(0.0)]
}

#[cfg(test)]
mod tests {
    use super::intersect;

    #[test]
    fn intersect_keeps_the_overlap_and_empties_disjoint_rects() {
        assert_eq!(
            intersect([0.0, 0.0, 100.0, 80.0], [20.0, 10.0, 200.0, 40.0]),
            [20.0, 10.0, 80.0, 40.0]
        );
        assert_eq!(
            intersect([0.0, 0.0, 10.0, 10.0], [20.0, 20.0, 5.0, 5.0]),
            [20.0, 20.0, 0.0, 0.0]
        );
    }
}
