/** A labeled plain-text editor using only the native renderer's verified API. */
import { createSignal, createUniqueId, mergeProps, splitProps } from "solid-js";
import { setProp } from "@tokamak/render";
import type { JSX, NativeEvent, NativeNode } from "@tokamak/render";

export interface InputState {
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly focused: boolean;
}

export interface InputProps extends Omit<JSX.InputAttributes, "children"> {
  defaultValue?: string;
  invalid?: boolean;
  label?: string;
  description?: string;
  onValueChange?: (value: string, event: NativeEvent) => void;
  /** Replace the control, not its label/description. Forward to a text input. */
  render?: (props: JSX.InputAttributes, state: InputState) => JSX.Element;
}

/** Parts: field, label, input, description (data-part). The input exposes
 * data-disabled, data-invalid, data-focused only when true. class styles the
 * control; label/description IDs are joined with supplied ARIA relationships.
 * @example <Input label="Todo" description="One task" value={title()} onValueChange={setTitle} />
 * @example <Input defaultValue="Buy milk" render={(props) => <input {...props} />} />
 * `value !== undefined` means controlled; defaultValue is read only on mount.
 */
export function Input(props: InputProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "render",
    "value",
    "defaultValue",
    "onValueChange",
    "onInput",
    "class",
    "disabled",
    "invalid",
    "label",
    "description",
    "id",
    "ref",
    "onFocus",
    "onBlur",
    "aria-labelledby",
    "aria-describedby",
    "aria-invalid",
  ]);
  const generated = `tk-input-${createUniqueId()}`;
  const id = () => local.id ?? generated;
  const [value, setValue] = createSignal(local.defaultValue ?? "");
  const [focused, setFocused] = createSignal(false);
  let node: NativeNode | undefined;
  const state: InputState = {
    get disabled() {
      return local.disabled ?? false;
    },
    get invalid() {
      return (
        local.invalid ??
        (local["aria-invalid"] === true || local["aria-invalid"] === "true")
      );
    },
    get focused() {
      return focused() && !state.disabled;
    },
  };
  const currentValue = () => local.value ?? value();
  const element = mergeProps(rest, {
    type: "text" as const,
    get id() {
      return id();
    },
    "data-part": "input",
    get class() {
      return ["tk-input", local.class].filter(Boolean).join(" ");
    },
    get value() {
      return currentValue();
    },
    get disabled() {
      return state.disabled;
    },
    get "aria-disabled"() {
      return state.disabled;
    },
    get "aria-invalid"() {
      return state.invalid;
    },
    get "aria-labelledby"() {
      return (
        [
          local["aria-labelledby"],
          local.label !== undefined ? `${id()}-label` : undefined,
        ]
          .filter(Boolean)
          .join(" ") || undefined
      );
    },
    get "aria-describedby"() {
      return (
        [
          local["aria-describedby"],
          local.description !== undefined ? `${id()}-description` : undefined,
        ]
          .filter(Boolean)
          .join(" ") || undefined
      );
    },
    get "data-disabled"() {
      return state.disabled ? "" : undefined;
    },
    get "data-invalid"() {
      return state.invalid ? "" : undefined;
    },
    get "data-focused"() {
      return state.focused ? "" : undefined;
    },
    ref(control: NativeNode) {
      node = control;
      local.ref?.(control);
    },
    onInput(event: NativeEvent) {
      if (state.disabled || rest.readonly) return;
      local.onInput?.(event);
      if (!event.defaultPrevented) {
        const next = event.value ?? "";
        if (local.value === undefined) setValue(next);
        local.onValueChange?.(next, event);
      }
      // Native editing precedes onInput. Solid's spread skips equal values, so
      // explicitly restore a controlled value even when the owner rejects it.
      if (node && event.value !== currentValue())
        setProp(node, "value", currentValue());
    },
    onFocus(event: NativeEvent) {
      setFocused(true);
      local.onFocus?.(event);
    },
    onBlur(event: NativeEvent) {
      setFocused(false);
      local.onBlur?.(event);
    },
  });
  return (
    <div class="tk-field" data-part="field">
      {local.label !== undefined && (
        <label id={`${id()}-label`} data-part="label">
          {local.label}
        </label>
      )}
      {local.render ? local.render(element, state) : <input {...element} />}
      {local.description !== undefined && (
        <p id={`${id()}-description`} data-part="description">
          {local.description}
        </p>
      )}
    </div>
  );
}
