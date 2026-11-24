import type { FunctionDefinition, ServerFunctionKind, WireResult } from "../functions";
import { callHost, type HostBridge } from "../host";
import { jsonSnapshot, type JsonValue } from "../values";

export const contractName = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const MEMBER_HOOK_RUN = "run";

const contractBrand: unique symbol = Symbol.for("tokamak.contract");
const providerBrand: unique symbol = Symbol.for("tokamak.contract.provider");
export const contractScope = Symbol.for("tokamak.contract.scope");

export type ContractPlace = "local" | "server";
export interface ContractKey {
  readonly name: string;
  readonly owner?: string;
  readonly place: ContractPlace;
  /** True routes every method; a list routes only the named methods. */
  readonly dataMethods?: true | readonly string[];
}

export interface Contract<T extends object, P extends ContractPlace = ContractPlace> extends ContractKey {
  readonly [contractBrand]: (shape: T) => T;
  readonly place: P;
  list(...context: LookupContext<P>): Promise<readonly BoundProvider<T, P>[]>;
  get(id: string, ...context: LookupContext<P>): ProviderSelection<BoundProvider<T, P>>;
}

interface LocalLookupOptions {
  /** Cancel provider discovery and calls made through the returned list. */
  readonly signal?: NonNullable<HostBridge["signal"]>;
  /** When the live input uses a different signal, identify it so it stays off the wire. */
  readonly inputSignal?: NonNullable<HostBridge["signal"]>;
  /** Handle process failures without hiding healthy providers or their own errors. */
  readonly onUnavailable?: (failure: { plugin: string; message: string; notice?: string }) => void;
}

export interface ContractContext {
  readonly [contractScope]: ContractScope;
}

type LookupContext<P extends ContractPlace> = P extends "local"
  ? [context: ContractContext, options?: LocalLookupOptions]
  : [context?: ContractContext];

type BoundProvider<T, P extends ContractPlace> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: infer A) => infer R
    ? P extends "server"
      ? (...args: A) => Promise<WireResult<R>>
      : T[K]
    : T[K];
};

/** Await a selection for its data and optional methods, or call a required method directly. */
type ProviderSelection<T> = PromiseLike<T | undefined> & {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

function select<T extends object>(id: string, lookup: () => Promise<T | undefined>): ProviderSelection<T> {
  const selection: PromiseLike<T | undefined> = {
    then: (resolve, reject) => lookup().then(resolve, reject),
  };
  return new Proxy(selection, {
    get(target, member) {
      if (member === "then") return target.then;
      if (typeof member !== "string") return undefined;
      return async (...args: unknown[]) => {
        const provider = await lookup();
        const method = provider && (provider as Record<string, unknown>)[member];
        if (typeof method !== "function") throw new Error(`Contract provider ${id} has no ${member} method`);
        return method(...args);
      };
    },
  }) as ProviderSelection<T>;
}

type Implementation<T, P extends ContractPlace> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: infer A) => infer R
    ? P extends "local"
      ? ((...args: A) => R) | LocalImplementation<A, R>
      : A extends [infer Input] | []
        ? FunctionDefinition<ServerFunctionKind, Input, WireResult<R>>
        : never
    : T[K];
};
type LocalImplementation<A extends unknown[], R> = A extends [infer Input] | []
  ? FunctionDefinition<"local", Input, WireResult<R>>
  : never;

export interface Provider<P extends ContractPlace> {
  readonly [providerBrand]: true;
  readonly contract: ContractKey & { readonly place: P };
  readonly implementation: Readonly<Record<string, unknown>>;
}

type MethodKey<T> = {
  [K in keyof T]-?: [NonNullable<T[K]>] extends [never]
    ? never
    : NonNullable<T[K]> extends (...args: never[]) => unknown
      ? K
      : never;
}[keyof T] &
  string;

export function contract<T extends object>(
  name: string,
  options: {
    place: "local";
    dataMethods?: true | readonly [MethodKey<T>, ...MethodKey<T>[]];
  },
): Contract<T, "local">;
export function contract<T extends object>(
  name: string,
  options?: { place: "server" },
): Contract<T, "server">;
export function contract<T extends object>(
  name: string,
  options?: { place: ContractPlace; dataMethods?: true | readonly string[] },
): Contract<T, "local"> | Contract<T, "server"> {
  return options?.place === "local"
    ? contractReference<T, "local">(name, "local", undefined, options.dataMethods)
    : contractReference<T, "server">(name, "server");
}

/** Used by the build to import contract keys without importing the defining plugin's code. */
export function contractReference<T extends object, P extends ContractPlace>(
  name: string,
  place: P,
  owner?: string,
  dataMethods?: true | readonly string[],
): Contract<T, P> {
  if (!contractName.test(name)) throw new Error(`Invalid contract name: ${name}`);
  const key = Object.freeze({
    name,
    place,
    ...(owner === undefined ? {} : { owner }),
    ...(dataMethods === undefined
      ? {}
      : { dataMethods: dataMethods === true ? (true as const) : Object.freeze([...dataMethods]) }),
  });
  const resolve = async (
    context?: ContractContext,
    id?: string,
    options?: LocalLookupOptions,
  ): Promise<readonly ContractEntry[]> => {
    const scoped = context?.[contractScope] ?? (place === "server" ? serverScope : undefined);
    if (!scoped)
      throw new Error(
        "Contract lookup requires a plugin function; pass ctx in local functions and server actions",
      );
    return scoped.list(key, id, options);
  };
  return Object.freeze({
    ...key,
    [contractBrand]: (shape: T) => shape,
    list: async (context?: ContractContext, options?: LocalLookupOptions) =>
      (await resolve(context, undefined, options)).map(
        ({ implementation }) => implementation as BoundProvider<T, P>,
      ),
    get: (id: string, context?: ContractContext, options?: LocalLookupOptions) =>
      select(
        id,
        async () =>
          (await resolve(context, id, options)).find((provider) => provider.id === id)?.implementation as
            | BoundProvider<T, P>
            | undefined,
      ),
  });
}

/** A provider is registered by exporting it from an authored plugin module. */
export function provide<T extends object, P extends ContractPlace>(
  key: Contract<T, P>,
  implementation: Implementation<NoInfer<T>, P>,
  _options?: P extends "local" ? { unavailable: string } : never,
): Provider<P> {
  return Object.freeze({
    [providerBrand]: true as const,
    contract: key,
    implementation: implementation as Readonly<Record<string, unknown>>,
  });
}

export interface ContractEntry {
  readonly id: string;
  readonly implementation: object;
}

export interface ContractScope {
  list(key: ContractKey, id?: string, options?: LocalLookupOptions): Promise<readonly ContractEntry[]>;
}

let serverScope: ContractScope | undefined;

export function serverContracts(host: HostBridge): ContractScope {
  return {
    async list(key) {
      if (key.place !== "server") throw new Error("Local contracts run in the client worker");
      const providers = await callHost(host, "contract.list", {
        name: key.name,
        ...(key.owner && { owner: key.owner }),
      });
      return providers.map(({ id, data, methods }) => ({
        id,
        implementation: Object.freeze({
          ...data,
          ...Object.fromEntries(
            Object.entries(methods).map(([member, name]) => [
              member,
              (args: unknown = {}) =>
                callHost(host, "plugin.call", {
                  name,
                  args: jsonSnapshot(args, "contract arguments"),
                  contract: key.name,
                }),
            ]),
          ),
        }),
      }));
    },
  };
}

export function withServerContracts<T>(host: HostBridge, invoke: () => Promise<T>): Promise<T> {
  // Legacy query/mutation lookup. Their bundle instance serves one invocation.
  // Concurrent action and local workers carry scope on the handler context.
  const previous = serverScope;
  serverScope = serverContracts(host);
  return invoke().finally(() => {
    serverScope = previous;
  });
}

export function contractData(implementation: object, methods: readonly string[]): JsonValue {
  return jsonSnapshot(
    Object.fromEntries(Object.entries(implementation).filter(([name]) => !methods.includes(name))),
    "contract provider data",
  );
}
