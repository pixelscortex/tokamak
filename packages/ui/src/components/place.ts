/** Placement of a floating piece (a menu, a popover, a tooltip) next to
 * the thing it belongs to: which side it opens on, where it sits, and how
 * tall it may be. Pure arithmetic on boxes the host reports after layout
 * (`observeLayout` in @tokamak/render; `trackLayout` in floating.ts reads
 * them into signals):
 *
 *   const at = place({ anchor: trigger.rect, clip: trigger.clip,
 *     size: { width: 240, height: 300 }, side: "bottom", offset: 6 });
 *   // at.side, at.x, at.y, at.maxHeight
 *
 * - `side` is a preference: `"bottom"` (default) or `"top"`. When the
 *   preferred side has less room than the piece needs and the other side
 *   has more, it flips. `"auto"` is `"bottom"` with the same rule: below
 *   unless it does not fit there and fits better above.
 * - Room is measured inside `clip`: the area the anchor can show in (the
 *   window cut by every clipping ancestor: the stage scroller, a scrolling
 *   box), less `margin` at its edges and `offset` from the anchor.
 * - `maxHeight` is the room on the chosen side: give it to the piece, with
 *   its list scrolling inside, and it never overflows, even when neither
 *   side fits it whole.
 * - Horizontally it lines up with the anchor (`align`), then shifts to stay
 *   inside the clip (never past its left or right edge, less `margin`).
 *
 * All values are CSS px in window coordinates. */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Side = "top" | "bottom";

export interface PlaceOptions {
  /** The box the piece belongs to (a trigger). */
  anchor: Box;
  /** Where the anchor can show: the window cut by its clipping ancestors. */
  clip: Box;
  /** The piece's natural size (its height before any limit). */
  size: { width: number; height: number };
  /** Preferred side (default `bottom`). */
  side?: Side | "auto";
  /** Which edge of the anchor the piece lines up with (default `start`). */
  align?: "start" | "end" | "center";
  /** Gap between the anchor and the piece. */
  offset?: number;
  /** Kept free at the clip's edges. */
  margin?: number;
}

export interface Placement {
  side: Side;
  /** The piece's top-left corner. */
  x: number;
  y: number;
  /** The piece's height: its natural height, limited to `maxHeight`. */
  height: number;
  /** The room on the chosen side (never negative). */
  maxHeight: number;
}

export function place(o: PlaceOptions): Placement {
  const offset = o.offset ?? 0;
  const margin = o.margin ?? 8;
  const { anchor, clip, size } = o;
  const room = (side: Side) =>
    Math.max(
      0,
      side === "bottom"
        ? clip.y + clip.height - margin - (anchor.y + anchor.height + offset)
        : anchor.y - offset - (clip.y + margin),
    );
  const preferred: Side = o.side === "top" ? "top" : "bottom";
  const other: Side = preferred === "top" ? "bottom" : "top";
  const side =
    room(preferred) >= size.height || room(other) <= room(preferred) ? preferred : other;
  const maxHeight = room(side);
  const height = Math.min(size.height, maxHeight);
  const y = side === "bottom" ? anchor.y + anchor.height + offset : anchor.y - offset - height;
  const aligned =
    o.align === "end"
      ? anchor.x + anchor.width - size.width
      : o.align === "center"
        ? anchor.x + (anchor.width - size.width) / 2
        : anchor.x;
  const lo = clip.x + margin;
  const hi = clip.x + clip.width - margin - size.width;
  // Too wide for the clip: keep its left edge in (its right overflows).
  const x = hi < lo ? lo : Math.min(Math.max(aligned, lo), hi);
  return { side, x, y, height, maxHeight };
}
