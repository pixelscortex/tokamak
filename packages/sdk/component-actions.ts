import type { JSX } from "@solidjs/web";

const componentPartBrand: unique symbol = Symbol("tokamak.component.part");
declare const originalElementBrand: unique symbol;
const componentActionBrand: unique symbol = Symbol("tokamak.component.action");

export interface ComponentPart<Target extends string, Props extends object> {
  readonly [componentPartBrand]: (props: Props) => void;
  readonly target: Target;
}

export type ComponentActionKind = "before" | "after" | "prepend" | "append" | "layer" | "hide";

export interface ComponentActionOptions<P extends object = any> {
  order?: number;
  /**
   * Live condition, read with the props of the element's component, so one
   * action can show for some instances only (one message, one thread).
   */
  when?: (props: P) => boolean;
}

type Part<P extends object> = ComponentPart<string, P>;
type Addition<P extends object> = (props: P) => JSX.Element;

type OriginalProps = {
  readonly children?: JSX.Element;
  readonly [attribute: `${string}-${string}`]: never;
};

export interface OriginalElement {
  readonly [originalElementBrand]?: true;
  <P extends OriginalProps>(props: P & Record<Exclude<keyof P, "children">, never>): JSX.Element;
  Children(): JSX.Element;
}

type Layer<P extends object> = (props: P, Original: OriginalElement) => JSX.Element;
export type ComponentAction<K extends ComponentActionKind = ComponentActionKind> = Readonly<{
  [componentActionBrand]: K;
  target: string;
  layer?: K extends "layer" ? Layer<any> : Addition<any>;
  when?: (props: any) => boolean;
}>;
export function isComponentAction(value: unknown): value is ComponentAction {
  return !!value && typeof value === "object" && componentActionBrand in value;
}

export function defineComponentAction<K extends ComponentActionKind, P extends object>(
  kind: K,
  target: Part<P>,
  layer: ComponentAction<K>["layer"],
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
    ui: Addition<NoInfer<P>>,
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

export function layer<P extends object>(
  target: Part<P>,
  draw: Layer<NoInfer<P>>,
  options?: ComponentActionOptions<NoInfer<P>>,
) {
  return defineComponentAction("layer", target, draw, options);
}

export function componentActionKind<K extends ComponentActionKind>(action: ComponentAction<K>): K {
  return action[componentActionBrand];
}

type SearchOptions = { in?: string; nth?: number };
type ScreenMatch = readonly [ancestors: string, props: object];
type InScope<Matches extends readonly ScreenMatch[], Scope extends string> = Matches extends readonly [
  infer First extends ScreenMatch,
  ...infer Rest extends ScreenMatch[],
]
  ? Scope extends First[0]
    ? [First, ...InScope<Rest, Scope>]
    : InScope<Rest, Scope>
  : [];
type AtPosition<
  Matches extends readonly ScreenMatch[],
  Nth extends number,
  Before extends unknown[] = [unknown],
> = Matches extends readonly [infer First extends ScreenMatch, ...infer Rest extends ScreenMatch[]]
  ? Before["length"] extends Nth
    ? First[1]
    : AtPosition<Rest, Nth, [...Before, unknown]>
  : never;
type MatchProps<Matches extends readonly ScreenMatch[], Filters> = Filters extends {
  nth: infer N extends number;
}
  ? number extends N
    ? Matches[number][1]
    : AtPosition<Matches, N>
  : Matches[number][1];
type SearchProps<Value extends object, Filters> = Value extends readonly ScreenMatch[]
  ? MatchProps<Filters extends { in: infer Scope extends string } ? InScope<Value, Scope> : Value, Filters>
  : Value;

/** The compiler supplies one props type or a source-ordered list of matches for each name. */
export type ScreenFind<Names extends Record<string, object>> = <
  Name extends keyof Names & string,
  const Filters extends SearchOptions = {},
>(
  name: Name,
  filters?: Filters,
) => ComponentPart<string, SearchProps<Names[Name], Filters>>;
