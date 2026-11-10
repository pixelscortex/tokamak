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

  /** `<tk-surface>` (render/src/surface, render/SURFACES.md): a fused, lit
   * surface painted natively on the GPU; it has no children. `shapes` is a
   * JSON list of shapes in the element's CSS px. */
  export interface SurfaceAttributes extends Attributes {
    shapes?: string;
    join?: number;
    gap?: number;
    fill?: string;
    bevel?: number;
    light?: number;
    elevation?: "raised" | "recessed";
    border?: number;
    "border-color"?: string;
    "border-align"?: "inside" | "center" | "outside";
    "border-lit"?: string;
  }

  export interface IntrinsicElements {
    "tk-surface": SurfaceAttributes;
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
  }
}
