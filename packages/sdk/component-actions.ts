import { createComponent, createContext, type Component } from "solid-js";
import type { JSX } from "@solidjs/web";

const componentBrand: unique symbol = Symbol("tokamak.component");
const componentPartBrand: unique symbol = Symbol("tokamak.component.part");
const componentActionBrand: unique symbol = Symbol("tokamak.component.action");

export interface ComponentPart<Target extends string, Locked extends boolean, Props extends object> {
  readonly [componentPartBrand]: (props: Props) => void;
  readonly target: Target;
  readonly locked: Locked;
}

export type ComponentParts<C extends Component<any>, Parts> = C & {
  readonly [K in keyof Parts]: Parts[K] extends {
    readonly target: infer Target extends string;
    readonly locked: infer Locked extends boolean;
  }
    ? ComponentPart<Target, Locked, Parameters<C>[0]>
    : never;
};

export interface ComponentSelf<P extends object> {
  readonly name: string;
  readonly props: P;
}

export type ComponentOptions = Record<string, never>;

/** Define a component whose JSX elements can be extended by other plugins. */
export function component<P extends object = {}>(
  name: string,
  _options: ComponentOptions,
  render: (props: P, self: ComponentSelf<P>) => JSX.Element,
): Component<P> & { readonly [componentBrand]: true } {
  return defineComponent(name, _options, render);
}

export function defineComponent<P extends object>(
  name: string,
  _options: ComponentOptions,
  render: (props: P, self: ComponentSelf<P>) => JSX.Element,
  parts?: Record<string, { target: string; locked: boolean }>,
) {
  const value = Object.assign(
    (props: P) =>
      createComponent(PartProps, {
        value: props,
        get children() {
          return render(props, { name, props });
        },
      }),
    { [componentBrand]: true as const },
  );
  for (const [part, { target, locked }] of Object.entries(parts ?? {}))
    Object.defineProperty(value, part, {
      value: Object.freeze({ [componentPartBrand]: true, target, locked }),
    });
  return value;
}

export const PartProps = createContext<object>({});
export type ComponentActionKind = "before" | "after" | "prepend" | "append" | "wrap" | "replace" | "hide";

export interface ComponentActionOptions<P extends object = any> {
  order?: number;
  /**
   * Live condition, read with the props of the element's component, so one
   * action can show for some instances only (one message, one thread).
   */
  when?: (props: P) => boolean;
}

type UnlockedPart<P extends object> = ComponentPart<string, false, P>;
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
  target: UnlockedPart<P>,
  layer: Layer<any> | undefined,
  options?: ComponentActionOptions<P>,
): ComponentAction<K> {
  if (target.locked) throw new Error(`Cannot change locked element ${target.target}`);
  return Object.freeze({
    [componentActionBrand]: kind,
    target: target.target,
    layer,
    when: options?.when,
  });
}

function insert<K extends "before" | "after" | "prepend" | "append">(kind: K) {
  return <P extends object>(
    target: UnlockedPart<P>,
    ui: Layer<NoInfer<P>>,
    options?: ComponentActionOptions<NoInfer<P>>,
  ) => defineComponentAction(kind, target, ui, options);
}

export const before = insert("before");
export const after = insert("after");
export const prepend = insert("prepend");
export const append = insert("append");

export function hide<P extends object>(
  target: UnlockedPart<P>,
  options?: ComponentActionOptions<NoInfer<P>>,
) {
  return defineComponentAction("hide", target, undefined, options);
}

export function wrapPart<P extends object>(
  target: UnlockedPart<P>,
  wrapper: Layer<NoInfer<P> & { readonly children: JSX.Element }>,
  options?: ComponentActionOptions<NoInfer<P>>,
) {
  return defineComponentAction("wrap", target, wrapper, options);
}

export function replacePart<P extends object>(
  target: UnlockedPart<P>,
  replacement: Layer<NoInfer<P>>,
  options?: ComponentActionOptions<NoInfer<P>>,
) {
  return defineComponentAction("replace", target, replacement, options);
}

export function componentActionKind<K extends ComponentActionKind>(action: ComponentAction<K>): K {
  return action[componentActionBrand];
}
