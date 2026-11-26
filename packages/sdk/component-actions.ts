import type { JSX } from "@solidjs/web";
import type { AttributeFilters } from "./screen-search";

const componentPartBrand: unique symbol = Symbol("tokamak.component.part");
declare const originalElementBrand: unique symbol;
declare const elementAttributesBrand: unique symbol;
const componentActionBrand: unique symbol = Symbol("tokamak.component.action");

export interface ComponentPart<Target extends string, Props extends object, Attributes extends object = {}> {
  readonly [elementAttributesBrand]?: Attributes;
  readonly [componentPartBrand]: (props: Props) => void;
  readonly target: Target;
}

export type ComponentActionKind = "before" | "after" | "prepend" | "append" | "layer" | "hide" | "attrs";

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

type ReservedAttribute =
  | "data-part"
  | "data-part-ignore"
  | "id"
  | "ref"
  | "children"
  | "innerHTML"
  | "textContent"
  | "outerHTML"
  | "innerText";
type ForbiddenAttribute = ReservedAttribute | `on${string}` | `prop:${string}` | `attr:${string}`;

export function reservedAttribute(key: string) {
  return (
    /^(?:on|prop:|attr:)/i.test(key) ||
    /^(?:data-part|data-part-ignore|id|ref|children|innerhtml|textcontent|outerhtml|innertext)$/i.test(key)
  );
}

type IntrinsicAttributes<Tag extends string> = Tag extends keyof JSX.IntrinsicElements
  ? JSX.IntrinsicElements[Tag]
  : JSX.HTMLAttributes<HTMLElement>;

export type ElementAttributes<Tag extends string> = {
  [K in keyof IntrinsicAttributes<Tag>]: K extends `aria-${string}`
    ? string extends IntrinsicAttributes<Tag>[K]
      ? IntrinsicAttributes<Tag>[K]
      : JSX.EnumeratedPseudoBoolean extends IntrinsicAttributes<Tag>[K]
        ? IntrinsicAttributes<Tag>[K] | boolean
        : IntrinsicAttributes<Tag>[K]
    : IntrinsicAttributes<Tag>[K];
};

type MutableAttributes<A extends object> = {
  [
    K in keyof A as K extends string
      ? Lowercase<K> extends Lowercase<ForbiddenAttribute>
        ? never
        : Extract<A[K], (...args: never[]) => unknown> extends never
          ? K
          : never
      : never
  ]?: K extends "class" ? string : A[K];
};
type Forbidden<F extends ForbiddenAttribute = ForbiddenAttribute> = { [K in F]?: never };
type OriginalProps<A extends object> = MutableAttributes<A> &
  Forbidden<Exclude<ForbiddenAttribute, "children">> & { readonly children?: JSX.Element };

export interface OriginalElement<A extends object = {}> {
  readonly [originalElementBrand]?: true;
  (props: OriginalProps<A>): JSX.Element;
  Children(): JSX.Element;
}

type Layer<P extends object, A extends object = {}> = (props: P, Original: OriginalElement<A>) => JSX.Element;
type Attributes<P extends object, A extends object = {}> = (
  props: P,
  current: Readonly<MutableAttributes<A>>,
) => MutableAttributes<A>;

export type ComponentAction<K extends ComponentActionKind = ComponentActionKind> = Readonly<{
  [componentActionBrand]: K;
  target: string;
  layer?: K extends "layer" ? Layer<any, any> : Addition<any>;
  attributes?: Attributes<any, any>;
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
  attributes?: Attributes<any, any>,
): ComponentAction<K> {
  return Object.freeze({
    [componentActionBrand]: kind,
    target: target.target,
    layer,
    attributes,
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

export function layer<P extends object, A extends object>(
  target: ComponentPart<string, P, A>,
  draw: Layer<NoInfer<P>, NoInfer<A>>,
  options?: ComponentActionOptions<NoInfer<P>>,
) {
  return defineComponentAction("layer", target, draw as Layer<any, any>, options);
}

export function attrs<P extends object, A extends object, Values extends MutableAttributes<NoInfer<A>>>(
  target: ComponentPart<string, P, A>,
  read: (
    props: NoInfer<P>,
    current: Readonly<MutableAttributes<NoInfer<A>>>,
  ) => Values &
    (string extends keyof Values ? unknown : Forbidden & UnknownKeys<Values, MutableAttributes<NoInfer<A>>>),
  options?: ComponentActionOptions<NoInfer<P>>,
) {
  return defineComponentAction("attrs", target, undefined, options, read as Attributes<any, any>);
}

export function componentActionKind<K extends ComponentActionKind>(action: ComponentAction<K>): K {
  return action[componentActionBrand];
}

type SearchOptions = AttributeFilters & { in?: string; nth?: number };
type ScreenMatch = readonly [
  ancestors: string,
  props: object,
  filters?: AttributeFilters,
  attributes?: object,
];
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
  Field extends 1 | 3,
  Before extends unknown[] = [unknown],
> = Matches extends readonly [infer First extends ScreenMatch, ...infer Rest extends ScreenMatch[]]
  ? Before["length"] extends Nth
    ? First[Field]
    : AtPosition<Rest, Nth, Field, [...Before, unknown]>
  : never;
type MatchField<Matches extends readonly ScreenMatch[], Filters, Field extends 1 | 3> = Filters extends {
  nth: infer N extends number;
}
  ? number extends N
    ? Matches[number][Field]
    : AtPosition<Matches, N, Field>
  : Matches[number][Field];
type SearchField<Value extends object, Filters, Field extends 1 | 3> = Value extends readonly ScreenMatch[]
  ? MatchField<
      Extract<keyof Filters, "in" | keyof AttributeFilters> extends never ? Value : Narrow<Value, Filters>,
      Filters,
      Field
    >
  : Field extends 1
    ? Value
    : {};

/** The compiler supplies one props type or a source-ordered list of matches and their filters. */
export type ScreenFind<Names extends Record<string, object>> = <
  Name extends keyof Names & string,
  const Filters extends SearchOptions = {},
>(
  name: Name,
  filters?: Filters &
    AllowedFilters<Names[NoInfer<Name>]> &
    CheckFilters<Filters, AllowedFilters<Names[NoInfer<Name>]>>,
) => ComponentPart<
  string,
  SearchField<Names[Name], Filters, 1>,
  NonNullable<SearchField<Names[Name], Filters, 3>>
>;
