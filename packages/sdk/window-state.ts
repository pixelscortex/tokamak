import { createMemo, createSignal, type Accessor, type Setter } from "solid-js";

const windowStateBrand: unique symbol = Symbol("tokamak.window-state");

export type WindowState<T> = Accessor<T> & {
  readonly [windowStateBrand]: true;
  readonly set: Setter<T>;
};
export type WindowDerived<T> = Accessor<T> & { readonly [windowStateBrand]: true };

export interface StateOptions {
  keep?: "device" | "me";
}

/** Read with `value()` and write with `value.set(next)`. */
export function state<T>(value: T, options?: StateOptions): WindowState<T> {
  if (options?.keep) throw new Error("Persistent state requires the Tokamak plugin build");
  return makeState(value).state;
}

export function makeState<T>(value: T, write?: (value: T, apply: (previous: T) => T) => void) {
  const [read, set] =
    typeof value === "function"
      ? createSignal<T>(() => value)
      : createSignal<T>(value as Exclude<T, Function>);
  const update = ((next: T | ((previous: T) => T)) => {
    const apply = typeof next === "function" ? (next as (previous: T) => T) : () => next;
    return set((previous) => {
      const value = apply(previous);
      write?.(value, apply);
      return value;
    });
  }) as Setter<T>;
  return {
    state: Object.assign(read, { [windowStateBrand]: true as const, set: write ? update : set }),
    restore: (value: T) => set(() => value),
  };
}

/** A tracked computation, including Solid's Loading and isPending behavior. */
export function derived<T>(compute: () => T | PromiseLike<T>): WindowDerived<T> {
  return Object.assign(createMemo<T>(compute), { [windowStateBrand]: true as const });
}
