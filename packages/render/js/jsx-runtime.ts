/** Native JSX types intentionally expose no DOM globals or browser methods.
 * Node identities are document-local numbers; handlers run synchronously. */
import type { NativeNode } from "./index";

export interface NativeEvent {
  readonly type: string;
  readonly target: number;
  currentTarget: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly value?: string;
  readonly key?: string;
  readonly code?: string;
  /** macOS commands arrive before KeyboardInput; cancel their native editing here. */
  readonly command?: string;
  readonly repeat?: boolean;
  readonly isComposing: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export type EventHandler = (event: NativeEvent) => void;

export namespace JSX {
  export type Element = NativeNode | string | number | boolean | null | undefined | Element[];

  export interface ElementChildrenAttribute {
    children: unknown;
  }

  export interface Attributes {
    children?: Element;
    ref?: (node: NativeNode) => void;
    id?: string;
    class?: string;
    style?: string;
    title?: string;
    role?: string;
    tabindex?: number;
    hidden?: boolean;
    [name: `data-${string}`]: string | number | boolean | undefined;
    [name: `aria-${string}`]: string | number | boolean | undefined;
    onClick?: EventHandler;
    onInput?: EventHandler;
    onFocus?: EventHandler;
    onBlur?: EventHandler;
    onFocusIn?: EventHandler;
    onFocusOut?: EventHandler;
    onKeyDown?: EventHandler;
    onKeyUp?: EventHandler;
    onComposition?: EventHandler;
    onAppleKeybinding?: EventHandler;
    "tk-group"?: string;
    "surface-own"?: "false";
    "surface-groups"?: string;
    "surface-op"?: "add" | "cut";
    "surface-join"?: number;
    "surface-slant"?: string;
    "surface-animate"?: true;
    "surface-attach"?: "left" | "right" | "top" | "bottom";
    /** With `WindowOptions::custom_titlebar`: pressing here drags the window. */
    "window-drag"?: true;
    "window-no-drag"?: true;
  }

  export interface ButtonAttributes extends Attributes {
    disabled?: boolean;
    type?: "button";
  }

  // Only the verified plain text editor is promised, not web password masking,
  // placeholder rendering, form submission, selection or full DOM input APIs.
  export interface InputAttributes extends Attributes {
    type?: "text";
    value?: string;
    disabled?: boolean;
    readonly?: boolean;
  }

  /** Blitz's multi-line plain text editor (parley). Its height is `rows`
   * lines of its line height (default 2); it wraps at word boundaries,
   * scrolls vertically to keep the caret in view and never grows with its
   * content (`@tokamak/ui`'s Textarea grows it). Its initial text is its
   * text content; `value` replaces the editor's text. No placeholder. */
  export interface TextareaAttributes extends Attributes {
    value?: string;
    rows?: number;
    disabled?: boolean;
    readonly?: boolean;
  }

  /** Background layer of a fused group; its root owns the computed look. */
  export interface SurfaceAttributes extends Attributes {
    group: string;
  }

  /** `<tk-icon>` (render/src/icon.rs): SVG path data drawn natively. */
  export interface IconAttributes extends Attributes {
    d: string;
    view?: number;
    fill?: string;
    stroke?: string;
    "stroke-width"?: number;
  }

  export interface IntrinsicElements {
    "tk-surface": SurfaceAttributes;
    "tk-icon": IconAttributes;
    div: Attributes;
    span: Attributes;
    p: Attributes;
    main: Attributes;
    section: Attributes;
    header: Attributes;
    nav: Attributes;
    aside: Attributes;
    style: Attributes;
    footer: Attributes;
    h1: Attributes;
    h2: Attributes;
    label: Attributes;
    button: ButtonAttributes;
    input: InputAttributes;
    textarea: TextareaAttributes;
  }
}
