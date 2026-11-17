import { Textarea } from "@ui-sdk/solid/textarea";
import { omit, onCleanup, useContext } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { ComposerContext } from "../../lib/composer";

export type ComposerInputProps = Omit<ComponentProps<typeof Textarea>, "class">;

/**
 * The prompt: bare 16/26 text on the composer card that grows with its text.
 * @tokamak/ui's Textarea draws a well with an edge; the composer's anatomy has
 * none, so this is the same ui-sdk textarea with the composer's own look.
 */
export function ComposerInput(props: ComposerInputProps): JSX.Element {
  const composer = useContext(ComposerContext);
  const report = (event: Event) => {
    const input = event.currentTarget as HTMLTextAreaElement;
    composer?.selection(input.selectionStart, input.selectionEnd);
  };
  onCleanup(() => composer?.bind(undefined));
  return (
    <Textarea
      autoResize
      rows={1}
      submitShortcut="enter"
      {...omit(props, "ref")}
      ref={(element: HTMLTextAreaElement) => composer?.bind(element)}
      onKeyUp={report}
      onPointerUp={report}
      data-slot="composer-input"
      class="block min-h-8 w-full resize-none bg-transparent py-1 text-read text-ink outline-none placeholder:text-ink-3 disabled:text-ink-3 field-sizing-content"
    />
  );
}
