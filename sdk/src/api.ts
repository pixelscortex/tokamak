// UI references carry names and compile-time argument/result types, never
// handlers. The generated api imports backend modules ONLY in type positions.
import type { FunctionDefinition, FunctionKind } from "./functions";

const referenceTypes: unique symbol = Symbol("tokamak.reference.types");

export const functionName: unique symbol = Symbol("tokamak.function.name");

export interface FunctionReference<K extends FunctionKind, A, R> {
  readonly [functionName]: string;
  readonly [referenceTypes]: { kind: K; args: A; result: R };
}

export type ApiFromModule<M> = {
  readonly [
    E in keyof M as M[E] extends FunctionDefinition ? E : never
  ]: M[E] extends FunctionDefinition<infer K, infer A, infer R>
    ? FunctionReference<K, A, R>
    : never;
};

export type ArgsOf<R> = R extends FunctionReference<FunctionKind, infer A, unknown> ? A : never;

export type ResultOf<R> = R extends FunctionReference<FunctionKind, unknown, infer V> ? V : never;

/**
 * The generated type is finite, while the implementation is lazy. This avoids
 * importing feature code into a UI just to discover a function's wire name.
 * A reference must be at least module.export; folders add module path segments.
 */
export function createApi<T>(): T {
  const path = (parts: string[]): unknown =>
    new Proxy(Object.create(null) as object, {
      get(_target, key) {
        if (key === functionName) {
          if (parts.length < 2) throw new Error("Expected api.module.export reference");
          return `${parts.slice(0, -1).join("/")}:${parts[parts.length - 1]}`;
        }
        if (typeof key === "string") return path([...parts, key]);
        return undefined;
      },
    });
  return path([]) as T;
}
