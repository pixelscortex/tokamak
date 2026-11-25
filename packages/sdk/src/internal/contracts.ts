import type { FunctionDefinition, MachineFailure, FunctionKind, WireResult } from "../functions";
import { callHost, type HostBridge, type LocalChannel, type ChannelHandler } from "../host";
import { jsonSnapshot, type JsonValue } from "../values";

export const contractName = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const MEMBER_HOOK_RUN = "run";

const contractBrand: unique symbol = Symbol.for("tokamak.contract");
const providerBrand: unique symbol = Symbol.for("tokamak.contract.provider");
export const contractScope = Symbol.for("tokamak.contract.scope");
export const providerIdentity = Symbol.for("tokamak.contract.buildIdentity");

/** A stable cache key for this registration in this local build. */
export function localProviderIdentity(provider: object): object | undefined {
  return (provider as { [providerIdentity]?: object })[providerIdentity];
}

export const openChannel = Symbol.for("tokamak.contract.channel");

export function hasLocalChannel(provider: object): boolean {
  return typeof (provider as { [openChannel]?: unknown })[openChannel] === "function";
}

/** Open a linked data call, when the provider runs in another QuickJS process. */
export function openLocalChannel(
  provider: object,
  method: string,
  args: unknown,
  receive: ChannelHandler,
): LocalChannel | undefined {
  const entry = provider as {
    [openChannel]?: (method: string, args: unknown, receive: ChannelHandler) => LocalChannel;
  };
  return entry[openChannel]?.(method, args, receive);
}

export type ContractTarget = "caller" | "server";
export interface ContractKey {
  readonly name: string;
  readonly owner?: string;
  readonly on: ContractTarget;
  /** Route every method across local QuickJS processes. */
  readonly dataMethods?: true;
}

export interface Contract<T extends object, P extends ContractTarget = ContractTarget> extends ContractKey {
  readonly [contractBrand]: (shape: T) => T;
  readonly on: P;
  list(...context: LookupContext<P>): Promise<readonly BoundProvider<T, P>[]>;
  get(id: string, ...context: LookupContext<P>): ProviderSelection<BoundProvider<T, P>>;
}

interface LocalLookupOptions {
  readonly onIncompatible?: (plugin: string) => void;
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

type LookupContext<P extends ContractTarget> = P extends "caller"
  ? [context: ContractContext, options?: LocalLookupOptions]
  : [context?: ContractContext];

type BoundProvider<T, P extends ContractTarget> = {
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

type Implementation<T, P extends ContractTarget> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: infer A) => infer R
    ? P extends "caller"
      ? ((...args: A) => R) | LocalImplementation<A, R>
      : A extends [infer Input] | []
        ? FunctionDefinition<FunctionKind, Input, WireResult<R>>
        : never
    : T[K];
};
type LocalImplementation<A extends unknown[], R> = A extends [infer Input] | []
  ? FunctionDefinition<"action", Input, WireResult<R | MachineFailure>> & { readonly on: "caller" }
  : never;

export interface Provider<P extends ContractTarget> {
  readonly [providerBrand]: true;
  readonly contract: ContractKey & { readonly on: P };
  readonly implementation: Readonly<Record<string, unknown>>;
}

export function contract<T extends object>(
  name: string,
  options: { on: "caller"; dataMethods?: true },
): Contract<T, "caller">;
export function contract<T extends object>(name: string, options?: { on: "server" }): Contract<T, "server">;
export function contract<T extends object>(
  name: string,
  options?: { on: ContractTarget; dataMethods?: true },
) {
  return options?.on === "caller"
    ? contractReference<T, "caller">(name, "caller", undefined, true)
    : contractReference<T, "server">(name, "server");
}

/** Used by the build to import contract keys without importing the defining plugin's code. */
export function contractReference<T extends object, P extends ContractTarget>(
  name: string,
  on: P,
  owner?: string,
  dataMethods?: true,
): Contract<T, P> {
  if (!contractName.test(name)) throw new Error(`Invalid contract name: ${name}`);
  const key = Object.freeze({
    name,
    on,
    ...(owner === undefined ? {} : { owner }),
    ...(dataMethods === undefined ? {} : { dataMethods }),
  });
  const resolve = async (
    context?: ContractContext,
    id?: string,
    options?: LocalLookupOptions,
  ): Promise<readonly ContractEntry[]> => {
    const scoped = context?.[contractScope] ?? (on === "server" ? serverScope : undefined);
    if (!scoped) throw new Error("Contract lookup requires a plugin function; pass ctx in actions");
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
export function provide<T extends object, P extends ContractTarget>(
  key: Contract<T, P>,
  implementation: Implementation<NoInfer<T>, P>,
  _options?: P extends "caller" ? { unavailable: string } : never,
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

/** List usable local providers alongside builds whose declarations no longer match. */
export async function localProviders<T extends object>(key: Contract<T, "caller">, context: ContractContext) {
  const incompatible: string[] = [];
  const entries = await context[contractScope].list(key, undefined, {
    onIncompatible: (plugin) => incompatible.push(plugin),
  });
  return {
    providers: entries.map((entry) => entry.implementation as BoundProvider<T, "caller">),
    incompatible,
  };
}

let serverScope: ContractScope | undefined;

export function serverContracts(host: HostBridge): ContractScope {
  return {
    async list(key) {
      if (key.on !== "server") throw new Error("Local contracts run in a plugin process");
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
