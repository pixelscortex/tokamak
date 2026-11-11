/** Textarea: multi-line text that grows with its content, one line at a
 * time, up to `maxRows`, then scrolls inside.
 *
 *   <Textarea aria-label="Message" placeholder="Reply…" value={draft()}
 *     onValueChange={setDraft} onSubmit={send} />
 *
 * With `onSubmit`, Enter submits and Shift+Enter inserts a new line;
 * without it, Enter inserts a new line. `onKeyDown` runs first: calling
 * `preventDefault()` there stops both the submit and the native edit (the
 * composer uses this for its command list).
 *
 * How it grows. Blitz's `<textarea>` is a real multi-line editor, but its
 * height is fixed (`rows` lines) and nothing reports how tall its text is.
 * So the textarea shares one grid cell with an invisible copy of its text
 * (the "mirror": same font, same width, `white-space: pre-wrap`): layout
 * sizes the cell to the mirror, at most `maxRows` lines, and the textarea
 * fills the cell. No measuring, no frame between a keystroke and the new
 * height. The cell can also be squeezed by its parent (`min-h-0`): a
 * composer that runs out of room takes lines from the text first.
 *
 * Placeholder: Blitz draws none, so it is a span over the empty field.
 * Typography is fixed per `size` (the mirror must match it exactly). */
import { Show, createSignal, splitProps, untrack } from "solid-js";
import { setProp } from "@tokamak/render";
import type { JSX, NativeEvent, NativeNode } from "@tokamak/render";

export interface TextareaProps {
  value?: string;
  /** Uncontrolled initial text (read once). */
  defaultValue?: string;
  onValueChange?: (value: string, event: NativeEvent) => void;
  /** Enter (without Shift) calls this with the text instead of inserting a
   * line. The owner clears the text if it wants to. */
  onSubmit?: (value: string) => void;
  /** Runs before the textarea's own key handling. */
  onKeyDown?: (event: NativeEvent) => void;
  onFocus?: (event: NativeEvent) => void;
  onBlur?: (event: NativeEvent) => void;
  placeholder?: string;
  /** Lines before it scrolls (default 8). */
  maxRows?: number;
  /** Lines when empty (default 1). */
  minRows?: number;
  /** `md`: 15 px on 24 px lines (default); `sm`: 13 px on 20 px lines. */
  size?: "md" | "sm";
  disabled?: boolean;
  readonly?: boolean;
  /** Id of the `<textarea>` itself. */
  id?: string;
  "aria-label"?: string;
  /** Classes of the outer grid cell (width, margins). */
  class?: string;
  ref?: (node: NativeNode) => void;
}

/** Line height per size, CSS px (the mirror and the textarea share it). */
export const textareaLine = { md: 24, sm: 20 } as const;

export function Textarea(props: TextareaProps): JSX.Element {
  const [local] = splitProps(props, ["value", "defaultValue"]);
  const [own, setOwn] = createSignal(untrack(() => local.defaultValue ?? local.value ?? ""));
  const current = () => local.value ?? own();
  let node: NativeNode | undefined;
  const line = () => textareaLine[props.size ?? "md"];
  const type = () => (props.size === "sm" ? "text-[13px] leading-5" : "text-[15px] leading-6");
  const rows = () => `min-height: ${(props.minRows ?? 1) * line()}px; max-height: ${(props.maxRows ?? 8) * line()}px`;
  function input(event: NativeEvent) {
    if (props.disabled || props.readonly) return;
    const next = event.value ?? "";
    if (local.value === undefined) setOwn(next);
    props.onValueChange?.(next, event);
    // A controlled owner that rejected the edit: put its text back into the
    // editor (Solid skips the write when the prop did not change).
    if (node && local.value !== undefined && next !== local.value) setProp(node, "value", local.value);
  }
  function keydown(event: NativeEvent) {
    props.onKeyDown?.(event);
    if (event.defaultPrevented || !props.onSubmit) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!event.repeat) props.onSubmit(current());
    }
  }
  return (
    <div class={`grid min-h-0 grid-rows-[minmax(0,1fr)] ${props.class ?? ""}`}>
      {/* The mirror: sizes the cell. The trailing space gives a final empty
        * line its height. */}
      <div
        aria-hidden="true"
        class={`invisible col-start-1 row-start-1 overflow-hidden break-words whitespace-pre-wrap ${type()}`}
        style={rows()}
      >
        {`${current()} `}
      </div>
      <textarea
        id={props.id}
        ref={(el) => {
          node = el;
          props.ref?.(el);
        }}
        rows={1}
        aria-label={props["aria-label"]}
        aria-disabled={props.disabled ? true : undefined}
        disabled={props.disabled}
        readonly={props.readonly}
        value={current()}
        onInput={input}
        onKeyDown={keydown}
        onAppleKeybinding={(event) => {
          // macOS sends its newline command before the key itself; the key
          // (with its Shift state) decides, in `keydown`.
          if (props.onSubmit && event.command === "insertNewline:") event.preventDefault();
        }}
        onFocus={(event) => props.onFocus?.(event)}
        onBlur={(event) => props.onBlur?.(event)}
        class={`col-start-1 row-start-1 m-0 h-full min-h-0 w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-ui text-ink outline-none ${type()}`}
      >
        {untrack(current)}
      </textarea>
      <Show when={current() === "" && props.placeholder}>
        <span class={`pointer-events-none col-start-1 row-start-1 truncate text-ink-4 ${type()}`}>
          {props.placeholder}
        </span>
      </Show>
    </div>
  );
}
