import type { JSX } from "@solidjs/web";
import type { AttributeFilters } from "./screen-search";

const componentPartBrand: unique symbol = Symbol("tokamak.component.part");
declare const renderFunctionBrand: unique symbol;
declare const originalElementBrand: unique symbol;
const componentActionBrand: unique symbol = Symbol("tokamak.component.action");

export interface ComponentPart<Target extends string, Props extends object> {
  readonly [componentPartBrand]: (props: Props) => void;
  readonly target: Target;
}

export interface RenderFunction<Props extends object> {
  readonly [renderFunctionBrand]: (props: Props) => void;
  readonly target: string;
  readonly renderTarget?: string;
}

export type ComponentActionKind = "before" | "after" | "prepend" | "append" | "layer" | "hide" | "attach";

export interface ComponentActionOptions<P extends object = any> {
  order?: number;
  /**
   * Live condition, read with the props of the owning component, so one
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
  target: { readonly target: string },
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

export function attach<P extends object>(
  target: RenderFunction<P>,
  fn: (props: NoInfer<P>) => JSX.Element | void,
  options?: ComponentActionOptions<NoInfer<P>>,
) {
  return defineComponentAction(
    "attach",
    { target: target.renderTarget ?? target.target },
    fn as Addition<P>, // A void callback returns undefined, which Solid can render.
    options,
  );
}

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

type ElementTarget<Names, Name, Filters> = Name extends keyof Names
  ? ComponentPart<string, SearchProps<Extract<Names[Name], object>, Filters>>
  : unknown;
type FunctionTarget<Functions, Name, Filters> =
  Extract<keyof Filters, keyof AttributeFilters> extends never
    ? Name extends keyof Functions
      ? SearchProps<Extract<Functions[Name], object>, Filters> extends infer P extends object
        ? [P] extends [never]
          ? unknown
          : RenderFunction<P>
        : never
      : unknown
    : unknown;
type FindFilters<Names, Name> = AllowedFilters<Name extends keyof Names ? Names[Name] : {}>;

/** Separate match lists let a name carry both element and render function props. */
export type ScreenFind<
  Names extends Record<string, object>,
  Functions extends Record<string, object> = {},
> = <Name extends (keyof Names | keyof Functions) & string, const Filters extends SearchOptions = {}>(
  name: Name,
  filters?: Filters &
    FindFilters<Names, NoInfer<Name>> &
    CheckFilters<Filters, FindFilters<Names, NoInfer<Name>>>,
) => { readonly target: string } & ElementTarget<Names, Name, Filters> &
  FunctionTarget<Functions, Name, Filters>;
