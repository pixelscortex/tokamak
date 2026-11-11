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
    /** Layout-bound surface member (render/SURFACES.md); set by
     * `@tokamak/ui`'s Surface components. Presence flags: pass `true` or
     * leave undefined (a string "false" would still be present). */
    "surface-groups"?: string;
    "surface-op"?: "union" | "subtract";
    "surface-radius"?: string;
    "surface-join"?: number;
    "surface-gap"?: number;
    "surface-slant"?: string;
    "surface-animate"?: true;
    "surface-attach"?: "left" | "right" | "top" | "bottom";
    /** A plate: an element drawn from its computed fill (a solid background
     * colour or a `material-*` utility) and bevel instead of a Blitz
     * background. Added by the build to elements whose static `class` makes
     * them one; authors do not write it. */
    "tk-plate"?: true;
    /** A region: the element directly holding a `<tk-surface materials>`
     * layer. Blitz paints no background under the plates inside it. Bare,
     * each plate paints itself, at its own place in paint order; `"sheet"`
     * makes the region's layer draw all of them, below the region's content
     * (render/SURFACES.md, "Plates"). Written by `@tokamak/ui`'s shell
     * regions, `Surface` and `Sheet`; views do not write it. */
    "tk-region"?: true | "sheet";
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

  /** `<tk-surface>` (render/src/surface, render/SURFACES.md): a fused, lit
   * surface painted natively on the GPU; it has no children. `shapes` is a
   * JSON list of shapes in the element's CSS px. */
  export interface SurfaceAttributes extends Attributes {
    /** Members with this name in `surface-groups` add their boxes as shapes. */
    group?: string;
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
    "border-lit"?: string | number;
    "border-mix"?: number;
    /** Materials layer ("the sheet") of the region that holds it (its
     * parent, marked `tk-region`): draws the region's plates that do not
     * paint themselves, each with its own computed material, no fusing: all
     * of them in a `tk-region="sheet"`, otherwise only those on elements
     * that cannot carry a widget (inputs, images, tables). Written by
     * `@tokamak/ui`'s shell regions, `Surface` and `Sheet`. */
    materials?: true;
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
