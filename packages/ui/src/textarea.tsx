/*
  <Textarea aria-label="Note" placeholder="Add a note" />

  ui-sdk Textarea that grows with its text (autoResize, which uses
  field-sizing: content in the webview) from one line up to half the
  window, then scrolls. A card-tone well, 14/20, radius 8.
  Slots: textarea.
*/
import { Textarea as UiTextarea } from "@ui-sdk/solid/textarea";
import type { ComponentProps, JSX } from "@solidjs/web";

export type TextareaProps = ComponentProps<typeof UiTextarea>;

export function Textarea(props: TextareaProps): JSX.Element {
  return <UiTextarea autoResize rows={1} {...props} />;
}
