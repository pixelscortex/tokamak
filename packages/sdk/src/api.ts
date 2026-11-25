// UI references carry names and compile-time argument/result types, never
// handlers. The generated api imports backend modules ONLY in type positions.
import type { FunctionDefinition, FunctionKind } from "./functions";
import type { Id } from "./values";
import type { Visibility } from "./visibility";

const callableReference: unique symbol = Symbol("tokamak.reference.callable");

const referenceTypes: unique symbol = Symbol("tokamak.reference.types");

export const functionKind: unique symbol = Symbol("tokamak.function.kind");

export const functionName: unique symbol = Symbol("tokamak.function.name");

export interface FunctionReference<
  K extends FunctionKind,
  A,
  R,
  V extends Visibility = Visibility,
  Owner extends string = string,
> {
  readonly [callableReference]: true;
  readonly [functionName]: string;
  readonly [functionKind]?: K;
  readonly [referenceTypes]: { kind: K; args: A; result: R; visibility: V; owner: Owner };
}

type ReferencesFromModule<M, V extends Visibility, Owner extends string> = {
  readonly [
    E in keyof M as M[E] extends FunctionDefinition<FunctionKind, unknown, unknown, V> ? E : never
  ]: ReferenceFromDefinition<M[E], Owner>;
};

export type ReferenceFromDefinition<D, Owner extends string = string> =
  D extends FunctionDefinition<infer K, infer A, infer R, infer V>
    ? FunctionReference<K, A, R, V, Owner>
    : never;

export type HookReference<
  K extends FunctionKind,
  A,
  R,
  V extends Visibility = Visibility,
  Owner extends string = string,
> = Omit<FunctionReference<K, A, R, V, Owner>, typeof callableReference>;

export type PointReference<
  K extends FunctionKind,
  A,
  R,
  Owner extends string,
  Name extends string,
  BeforeOnly extends boolean,
> = HookReference<K, A, R, Visibility, Owner> & {
  readonly [functionName]: Name;
  readonly pointBeforeOnly: BeforeOnly;
};

export type HookReferenceFromDefinition<D, Owner extends string> =
  D extends FunctionDefinition<infer K, infer A, infer R, infer V> ? HookReference<K, A, R, V, Owner> : never;

export type ApiFromModule<M, Owner extends string = string> = ReferencesFromModule<
  M,
  typeof Visibility.Public,
  Owner
>;
export type InternalFromModule<M, Owner extends string = string> = ReferencesFromModule<
  M,
  typeof Visibility.Internal,
  Owner
>;
export type PluginFunctionsFromModule<M, Owner extends string = string> = ReferencesFromModule<
  M,
  typeof Visibility.PluginOnly,
  Owner
>;

type QualifyIds<Owner extends string, T> =
  T extends Id<infer Table>
    ? string extends Table
      ? T
      : Table extends `${string}.${string}`
        ? T
        : Id<`${Owner}.${Table}`>
    : T extends object
      ? { [Key in keyof T]: QualifyIds<Owner, T[Key]> }
      : T;

/** Cross-plugin references in a consumer that imports the owner's table handles. */
export type QualifiedPluginApi<Owner extends string, Api> = {
  [Key in keyof Api]: Api[Key] extends HookReference<infer Kind, infer Args, infer Result, infer V, infer O>
    ? (Api[Key] extends FunctionReference<Kind, Args, Result, V, O>
        ? FunctionReference<Kind, QualifyIds<Owner, Args>, QualifyIds<Owner, Result>, V, O>
        : HookReference<Kind, QualifyIds<Owner, Args>, QualifyIds<Owner, Result>, V, O>) & {
        readonly [functionName]: Api[Key][typeof functionName];
      } & (Api[Key] extends { readonly points: infer Points }
          ? { readonly points: QualifiedPluginApi<Owner, Points> }
          : unknown) &
        (Api[Key] extends { readonly pointBeforeOnly: infer BeforeOnly }
          ? { readonly pointBeforeOnly: BeforeOnly }
          : unknown)
    : never;
};

export type ArgsOf<R> = R extends HookReference<FunctionKind, infer A, unknown> ? A : never;

export type ResultOf<R> = R extends HookReference<FunctionKind, unknown, infer V> ? V : never;

/**
 * Generated references have an explicit list of wire names. The lazy form is
 * retained for existing hand-written references.
 * A reference must be at least module.export; folders add module path segments.
 */
export function createApi<T>(
  namespace?: string,
  names?: readonly string[],
  kinds?: Readonly<Record<string, FunctionKind>>,
  points?: Readonly<Record<string, readonly string[]>>,
): T {
  const qualify = (name: string) => (namespace ? `${namespace}/${name}` : name);
  if (names) {
    type Branch = Record<string, object>;
    const root: Branch = Object.create(null);
    const branches = [root];
    for (const name of names) {
      const separator = name.indexOf(":");
      const module = name.slice(0, separator);
      const method = name.slice(separator + 1);
      let branch = root;
      for (const segment of module.split("/")) {
        if (!Object.hasOwn(branch, segment)) {
          const child: Branch = Object.create(null);
          branch[segment] = child;
          branches.push(child);
        }
        branch = branch[segment] as Branch;
      }
      const named = points?.[name];
      branch[method] = Object.freeze({
        [functionName]: qualify(name),
        [functionKind]: kinds?.[name],
        ...(named?.length
          ? {
              points: Object.freeze(
                Object.fromEntries(
                  named.map((point) => [
                    point,
                    Object.freeze({
                      [functionName]: qualify(`${name}#${point}`),
                      [functionKind]: kinds?.[name],
                    }),
                  ]),
                ),
              ),
            }
          : {}),
      });
    }
    branches.forEach(Object.freeze);
    return root as T;
  }
  const path = (parts: string[]): unknown =>
    new Proxy(Object.create(null) as object, {
      get(_target, key) {
        if (key === functionName) {
          if (parts.length < 2) throw new Error("Expected api.module.export reference");
          return qualify(`${parts.slice(0, -1).join("/")}:${parts[parts.length - 1]}`);
        }
        if (typeof key === "string") return path([...parts, key]);
        return undefined;
      },
    });
  return path([]) as T;
}
