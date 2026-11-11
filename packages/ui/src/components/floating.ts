/** Floating pieces: layouts as signals, and `place` (place.ts).
 *
 *   const [anchor, observeAnchor] = trackLayout();
 *   <button ref={observeAnchor} … />
 *   const at = () => anchor() && place({ anchor: anchor()!.rect, clip: anchor()!.clip, … });
 *
 * The host reports an observed element's box and visible area after the
 * layout that places it and after every layout that moves it (scrolling,
 * a resize), and lays out again before painting when a report changes the
 * document, so a piece placed from these signals is in place in the first
 * frame that shows it. Observation ends with the owner that started it (a
 * `<Show>` closing). */
import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { observeLayout } from "@tokamak/render";
import type { Layout, NativeNode } from "@tokamak/render";

export { place } from "./place";
export type { Box, PlaceOptions, Placement, Side } from "./place";
export type { Layout } from "@tokamak/render";

/** A signal of an element's layout, and the function that starts observing
 * an element (use it as a `ref`, or call it in the owner that should
 * observe). Undefined until the first report. */
export function trackLayout(): [Accessor<Layout | undefined>, (node: NativeNode) => void] {
  const [layout, setLayout] = createSignal<Layout | undefined>(undefined);
  return [layout, (node) => void observeLayout(node, setLayout)];
}
