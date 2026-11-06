/** Action/toggle behavior; native button activation stays in the renderer. */
import {
  createRenderEffect,
  createSignal,
  mergeProps,
  splitProps,
} from "solid-js";
import type { JSX, NativeEvent } from "@tokamak/render";

export interface ButtonState {
  readonly pressed: boolean;
  readonly disabled: boolean;
  readonly focused: boolean;
}

export interface ButtonProps extends JSX.ButtonAttributes {
  /** Supplying either pressed prop opts into toggle semantics. */
  pressed?: boolean;
  defaultPressed?: boolean;
  onPressedChange?: (pressed: boolean, event: NativeEvent) => void;
  /** Set false when render returns a non-button element (for example a div). */
  nativeButton?: boolean;
  /** Spread these reactive props on one element. Do not snapshot them. */
  render?: (props: JSX.ButtonAttributes, state: ButtonState) => JSX.Element;
}

/** Part: button. State attributes are present only when true: data-pressed,
 * data-disabled, data-focused. Plain class extends the themed base class.
 * @example <Button defaultPressed={false} onPressedChange={save}>Done</Button>
 * @example <Button render={(props) => <button {...props} class="my-button" />} />
 * A render callback forwards props to its element. For a non-button, pass
 * nativeButton={false}; only then does UI supply Enter/Space and button role.
 * Native button keyboard activation remains exclusively in the renderer.
 */
export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "render",
    "pressed",
    "defaultPressed",
    "onPressedChange",
    "class",
    "disabled",
    "onClick",
    "onFocus",
    "onBlur",
    "nativeButton",
    "onKeyDown",
    "onKeyUp",
    "tabindex",
  ]);
  const [pressed, setPressed] = createSignal(local.defaultPressed ?? false);
  const [focused, setFocused] = createSignal(false);
  const toggles = () =>
    local.pressed !== undefined || local.defaultPressed !== undefined;
  const state: ButtonState = {
    get pressed() {
      return local.pressed ?? pressed();
    },
    get disabled() {
      return local.disabled ?? false;
    },
    get focused() {
      return focused() && !state.disabled;
    },
  };
  const native = () => local.nativeButton !== false;
  let spaceArmed = false;
  createRenderEffect(() => {
    if (state.disabled) spaceArmed = false;
  });
  function activate(event: NativeEvent) {
    if (state.disabled) {
      event.preventDefault();
      return;
    }
    local.onClick?.(event);
    if (event.defaultPrevented || !toggles()) return;
    const next = !state.pressed;
    if (local.pressed === undefined) setPressed(next);
    local.onPressedChange?.(next, event);
  }
  const element = mergeProps(rest, {
    get type() {
      return native() ? ("button" as const) : undefined;
    },
    get role() {
      return native() ? rest.role : "button";
    },
    get tabindex() {
      return state.disabled && !native()
        ? -1
        : (local.tabindex ?? (native() ? undefined : 0));
    },
    "data-part": "button",
    get class() {
      return ["tk-button", local.class].filter(Boolean).join(" ");
    },
    get disabled() {
      return native() ? state.disabled : undefined;
    },
    get "aria-disabled"() {
      return state.disabled;
    },
    get "aria-pressed"() {
      return toggles() ? state.pressed : undefined;
    },
    get "data-pressed"() {
      return toggles() && state.pressed ? "" : undefined;
    },
    get "data-disabled"() {
      return state.disabled ? "" : undefined;
    },
    get "data-focused"() {
      return state.focused ? "" : undefined;
    },
    onClick: activate,
    onKeyDown(event: NativeEvent) {
      local.onKeyDown?.(event);
      if (native() || event.target !== event.currentTarget) return;
      if (event.defaultPrevented || event.isComposing || state.disabled) {
        spaceArmed = false;
        return;
      }
      if (event.key === "Enter") {
        if (!event.repeat) activate(event);
        event.preventDefault();
      } else if (event.key === " ") {
        event.preventDefault();
        if (!event.repeat) spaceArmed = true;
      }
    },
    onKeyUp(event: NativeEvent) {
      local.onKeyUp?.(event);
      if (native() || event.key !== " ") return;
      const armed = spaceArmed;
      spaceArmed = false;
      if (
        armed &&
        !event.repeat &&
        !event.defaultPrevented &&
        !event.isComposing &&
        event.target === event.currentTarget
      ) {
        activate(event);
        event.preventDefault();
      }
    },
    onFocus(event: NativeEvent) {
      setFocused(true);
      local.onFocus?.(event);
    },
    onBlur(event: NativeEvent) {
      spaceArmed = false;
      setFocused(false);
      local.onBlur?.(event);
    },
  });
  return local.render ? local.render(element, state) : <button {...element} />;
}
