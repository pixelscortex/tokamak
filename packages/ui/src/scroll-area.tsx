/*
  <ScrollArea class="min-h-0 flex-1" label="Review">…</ScrollArea>

  A panel's one scroll container: it scrolls up and down only, and draws the
  quiet thumb of Paper "Scrollbars · options" (option B) over its edge: a 4 px
  thumb in a 12 px lane, edge at rest, edge-strong while the pointer or focus is
  inside (150 ms in, 300 ms out after 600 ms), ink-3 when the thumb itself is
  hovered or dragged. Keep at least 12 px of padding on the end side so the lane
  covers no content. The browser still scrolls, so the wheel, keys and find in
  page work as usual. Give the root its size; content wraps, never scrolls sideways.
*/
import {
  ScrollArea as Root,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "@ui-sdk/solid/scroll-area";
import type { JSX } from "@solidjs/web";
import { cn } from "./cn.ts";

export type ScrollAreaProps = {
  class?: string;
  /** Names the scrolling region for screen readers; also makes it a landmark. */
  label?: string;
  /** The viewport, the element that scrolls. */
  viewportRef?: (element: HTMLDivElement) => void;
  contentRef?: (element: HTMLDivElement) => void;
  children: JSX.Element;
};

export function ScrollArea(props: ScrollAreaProps): JSX.Element {
  return (
    <Root
      type="auto"
      data-slot="scroll-area"
      class={cn("group/scroll relative flex min-h-0 flex-col overflow-hidden", props.class)}
    >
      <ScrollAreaViewport
        ref={props.viewportRef}
        role={props.label ? "region" : undefined}
        aria-label={props.label}
        class="size-full min-h-0 flex-1 focus-ring"
      >
        <ScrollAreaContent ref={props.contentRef} class="flex min-h-full flex-col">
          {props.children}
        </ScrollAreaContent>
      </ScrollAreaViewport>
      <ScrollAreaScrollbar
        orientation="vertical"
        class="flex w-3 touch-none justify-center py-1 opacity-0 select-none data-visible:opacity-100"
      >
        <ScrollAreaThumb
          class={cn(
            "w-1 rounded-full bg-edge transition-colors delay-600 duration-300 ease-out",
            "group-focus-within/scroll:bg-edge-strong group-focus-within/scroll:delay-0 group-focus-within/scroll:duration-150",
            "group-data-hovering/scroll:bg-edge-strong group-data-hovering/scroll:delay-0 group-data-hovering/scroll:duration-150",
            "hover:bg-ink-3 hover:delay-0 data-dragging:bg-ink-3 data-dragging:delay-0 motion-reduce:transition-none",
          )}
        />
      </ScrollAreaScrollbar>
    </Root>
  );
}
