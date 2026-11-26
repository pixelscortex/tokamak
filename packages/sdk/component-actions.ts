import type { JSX } from "@solidjs/web";

const componentPartBrand: unique symbol = Symbol("tokamak.component.part");
const componentActionBrand: unique symbol = Symbol("tokamak.component.action");

export interface ComponentPart<Target extends string, Props extends object> {
  readonly [componentPartBrand]: (props: Props) => void;
  readonly target: Target;
}

export type ComponentActionKind = "before" | "after" | "prepend" | "append" | "wrap" | "replace" | "hide";

export interface ComponentActionOptions<P extends object = any> {
  order?: number;
  /**
   * Live condition, read with the props of the element's component, so one
   * action can show for some instances only (one message, one thread).
   */
  when?: (props: P) => boolean;
}

type Part<P extends object> = ComponentPart<string, P>;
type Layer<P extends object> = (props: P) => JSX.Element;
export type ComponentAction<K extends ComponentActionKind = ComponentActionKind> = Readonly<{
  [componentActionBrand]: K;
  target: string;
  layer?: Layer<any>;
  when?: (props: any) => boolean;
}>;
export function isComponentAction(value: unknown): value is ComponentAction {
  return !!value && typeof value === "object" && componentActionBrand in value;
}

export function defineComponentAction<K extends ComponentActionKind, P extends object>(
  kind: K,
  target: Part<P>,
  layer: Layer<any> | undefined,
  options?: ComponentActionOptions<P>,
): ComponentAction<K> {
  return Object.freeze({
    [componentActionBrand]: kind,
    target: target.target,
    layer,
    when: options?.when,
  });
}

function insert<K extends "before" | "after" | "prepend" | "append">(kind: K) {
  return <P extends object>(
    target: Part<P>,
    ui: Layer<NoInfer<P>>,
    options?: ComponentActionOptions<NoInfer<P>>,
  ) => defineComponentAction(kind, target, ui, options);
}

export const before = insert("before");
export const after = insert("after");
export const prepend = insert("prepend");
export const append = insert("append");

export function hide<P extends object>(target: Part<P>, options?: ComponentActionOptions<NoInfer<P>>) {
  return defineComponentAction("hide", target, undefined, options);
}

export function wrapPart<P extends object>(
  target: Part<P>,
  wrapper: Layer<NoInfer<P> & { readonly children: JSX.Element }>,
  options?: ComponentActionOptions<NoInfer<P>>,
) {
  return defineComponentAction("wrap", target, wrapper, options);
}

export function replacePart<P extends object>(
  target: Part<P>,
  replacement: Layer<NoInfer<P>>,
  options?: ComponentActionOptions<NoInfer<P>>,
) {
  return defineComponentAction("replace", target, replacement, options);
}

export function componentActionKind<K extends ComponentActionKind>(action: ComponentAction<K>): K {
  return action[componentActionBrand];
}
