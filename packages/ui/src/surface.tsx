/*
  <Surface tone="window" class="flex h-full">…</Surface>

  A region painted in one tone. It also sets what hover and selected look
  like on that tone (bg-hover, bg-selected), which a plain bg-* class
  cannot: on the light window the selected fill is white, not card.
  A consumer may add layout, spacing and radius classes.
  Slots: none. data-surface="<tone>".
*/
import type { JSX } from "@solidjs/web";

export type SurfaceTone = "window" | "stage" | "tray" | "card" | "band";

export function Surface(props: {
  tone: SurfaceTone;
  class?: string;
  children?: JSX.Element;
  "aria-label"?: string;
}): JSX.Element {
  return (
    <div data-surface={props.tone} class={props.class} aria-label={props["aria-label"]}>
      {props.children}
    </div>
  );
}
