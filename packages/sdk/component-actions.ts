import type { JSX } from "@solidjs/web";
import type { AttributeFilters } from "./screen-search";

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

type SearchOptions = AttributeFilters & { in?: string; nth?: number };
type ScreenMatch = readonly [ancestors: string, props: object, attributes?: AttributeFilters];
type Keys<T> = T extends unknown ? keyof T : never;
type Values<T, K extends PropertyKey> = T extends Record<K, unknown> ? T[K] : never;
type Available<T> = { [K in Keys<T>]?: Values<T, K> };
type Options<Value> = Value extends readonly ScreenMatch[]
  ? OptionsFromAttributes<NonNullable<Value[number][2]>>
  : {};
type OptionsFromAttributes<T> = Available<OmitEach<T, "aria">> &
  ([Values<T, "aria">] extends [never] ? {} : { aria?: Available<Values<T, "aria">> });
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type AllowedFilters<Value> = { in?: string; nth?: number } & Options<Value>;
type UnknownKeys<Given, Allowed> = Record<Exclude<keyof Given, keyof Allowed>, never>;
type CheckFilters<Given, Allowed> = UnknownKeys<Given, Allowed> &
  (Given extends { aria: infer A }
    ? Allowed extends { aria?: infer B }
      ? { aria: UnknownKeys<A, NonNullable<B>> }
      : never
    : unknown);

type Fits<Match extends ScreenMatch, Filters> = Filters extends { in: infer Scope extends string }
  ? Scope extends Match[0]
    ? FitsAttributes<Match, Filters>
    : false
  : FitsAttributes<Match, Filters>;
type FitsAttributes<Match extends ScreenMatch, Filters> =
  (Match[2] extends AttributeFilters ? Match[2] : {}) extends Pick<
    Filters,
    Exclude<keyof Filters, "in" | "nth">
  >
    ? true
    : false;
type Narrow<
  Matches extends readonly ScreenMatch[],
  Filters,
  Kept extends ScreenMatch[] = [],
> = Matches extends readonly [infer First extends ScreenMatch, ...infer Rest extends ScreenMatch[]]
  ? Narrow<Rest, Filters, Fits<First, Filters> extends true ? [...Kept, First] : Kept>
  : Kept;
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
  ? MatchProps<
      Extract<keyof Filters, "in" | keyof AttributeFilters> extends never ? Value : Narrow<Value, Filters>,
      Filters
    >
  : Value;

/** The compiler supplies one props type or a source-ordered list of matches and their filters. */
export type ScreenFind<Names extends Record<string, object>> = <
  Name extends keyof Names & string,
  const Filters extends SearchOptions = {},
>(
  name: Name,
  filters?: Filters &
    AllowedFilters<Names[NoInfer<Name>]> &
    CheckFilters<Filters, AllowedFilters<Names[NoInfer<Name>]>>,
) => ComponentPart<string, SearchProps<Names[Name], Filters>>;
