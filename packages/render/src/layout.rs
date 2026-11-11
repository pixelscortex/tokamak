//! Layout reports: what JS can learn about where things are.
//!
//! JS has no layout of its own: the tree it builds is laid out by Blitz, in
//! Rust, after the JS turn ends. To place a floating piece (a menu, a
//! popover, a tooltip) it needs boxes, so an element marked `tk-observe`
//! (`observeLayout` in js/index.ts) is reported to JS after layout:
//!
//! - `rect`: its border box, CSS px, relative to the window (what
//!   `getBoundingClientRect` would say: scrolling included, transforms not);
//! - `clip`: the part of the window it can show in: the window, cut by the
//!   padding box of every ancestor that clips its overflow (a scroller, an
//!   `overflow: hidden` panel). Its nearest clipping ancestor is the one
//!   that usually decides.
//!
//! Push, not pull: a synchronous "where is this node" call from JS would
//! read a layout that does not yet contain the mutations of the JS turn
//! asking, so the answer would be stale exactly when it matters (a menu
//! that has just been opened). Instead the host reports after each layout,
//! and only what changed: a static document reports nothing, so this costs
//! no frames. `NativeDocument::resolve_layout` lays out, reports, and lays
//! out again if the report changed the document (a menu re-placed), a few
//! rounds at most, so a frame is painted with the placement already done.
use blitz_dom::BaseDocument;
use blitz_traits::NodeId;
use serde::Serialize;
use style::values::computed::Overflow;

/// One observed element's layout, as JS receives it (`id` is its JS handle).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub(crate) struct Report {
    /// Border box: x, y, width, height (CSS px, window coordinates).
    pub rect: [f32; 4],
    /// Visible area: x, y, width, height (CSS px, window coordinates).
    pub clip: [f32; 4],
}

/// The layout of `node` now; None if it is not laid out (not in the
/// document, or `display: none`).
pub(crate) fn report(doc: &BaseDocument, node: NodeId) -> Option<Report> {
    let n = doc.get_node(node)?;
    if !n.flags.is_in_document() {
        return None;
    }
    let r = doc.get_client_bounding_rect(node)?;
    let rect = [r.x as f32, r.y as f32, r.width as f32, r.height as f32];
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
        let Some(b) = doc.get_client_bounding_rect(id) else {
            continue;
        };
        let border = ancestor.final_layout().border;
        let padding = [
            b.x as f32 + border.left,
            b.y as f32 + border.top,
            b.width as f32 - border.left - border.right,
            b.height as f32 - border.top - border.bottom,
        ];
        clip = intersect(clip, padding);
    }
    Some(Report { rect, clip })
}

/// The overlap of two rects (x, y, w, h); empty ones keep a zero size.
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
