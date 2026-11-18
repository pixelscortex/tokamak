/*
  <Textarea aria-label="Note" placeholder="Add a note" />

  Grows with its text from one line up to the window's height, then scrolls.
  A translucent well with an edge, so it sits on any surface.
*/
import { Textarea as Base } from "@ui-sdk/solid/textarea";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { cn } from "./cn.ts";

export type TextareaProps = ComponentProps<typeof Base>;

export function Textarea(props: TextareaProps): JSX.Element {
  const rest = omit(props, "class");
  return (
    <Base
      autoResize
      rows={1}
      {...rest}
      data-slot="textarea"
      class={cn(
        "block min-h-8 max-h-dvh w-full resize-none rounded-sm bg-edge/50 px-3 py-line",
        "text-row text-ink inset-ring inset-ring-edge placeholder:text-ink-3 focus-ring",
        "disabled:text-ink-3 data-disabled:text-ink-3 field-sizing-content",
        props.class as string,
      )}
    />
  );
}
