// Definitions close over handlers instead of exposing an unvalidated handler
// entry point. The registry and host always invoke the same validation path.
import { createDatabase } from "./database";
import type { DatabaseReader, DatabaseWriter } from "./database";
import type { HostBridge } from "./host";
import type { DataModel, ModelFromSchema, SchemaDefinition } from "./schema";
import type { Fields, ObjectValue, ValidatorDescription } from "./validators";
import { v, validate } from "./validators";
import type { JsonObject, JsonValue } from "./values";
import { jsonSnapshot } from "./values";
import { createApi, functionName, type FunctionReference } from "./api";
import { callHost } from "./host";

export type FunctionKind = "query" | "mutation" | "action";

type WireValue<V> = V extends void ? null : V;

export type WireResult<R> = WireValue<Awaited<R>>;

/** Bind finite generated references to host-mediated calls, never import handlers. */
export type PluginCalls<T, K extends FunctionKind> =
  T extends FunctionReference<infer Kind, infer A, infer R>
    ? Kind extends K
      ? (args: A) => Promise<R>
      : never
    : { readonly [P in keyof T]: PluginCalls<T[P], K> };

export interface QueryContext<M extends DataModel> {
  readonly db: DatabaseReader<M>;
  use<T>(api: T): PluginCalls<T, "query">;
  providers<T>(interfaceName: string): Promise<readonly T[]>;
}

export interface MutationContext<M extends DataModel> {
  readonly db: DatabaseWriter<M>;
  use<T>(api: T): PluginCalls<T, "query" | "mutation">;
  providers<T>(interfaceName: string): Promise<readonly T[]>;
}

/** Actions have no database capability; each nested call owns its transaction. */
export interface ActionContext {
  use<T>(api: T): PluginCalls<T, FunctionKind>;
  readonly signal?: HostBridge["signal"];
  /** Requires a manifest env:<name> grant; unset values return null. */
  env(name: string): Promise<string | null>;
  runQuery<A, R>(reference: FunctionReference<"query", A, R>, args: NoInfer<A>): Promise<R>;
  runMutation<A, R>(reference: FunctionReference<"mutation", A, R>, args: NoInfer<A>): Promise<R>;
  providers<T>(interfaceName: string): Promise<readonly T[]>;
}

const definitionBrand = Symbol("tokamak.function");

export interface FunctionDefinition<K extends FunctionKind = FunctionKind, A = unknown, R = unknown> {
  readonly [definitionBrand]: true;
  readonly kind: K;
  readonly args: ValidatorDescription;
  readonly _types?: { args: A; result: R };
  invoke(args: unknown, host: HostBridge): Promise<JsonValue>;
}

export type FunctionBuilder<K extends FunctionKind, M extends DataModel> = <
  F extends Fields = Record<never, never>,
  R = unknown,
>(definition: {
  args?: F;
  handler: (
    ctx: K extends "query" ? QueryContext<M> : K extends "mutation" ? MutationContext<M> : ActionContext,
    args: ObjectValue<F>,
  ) => R;
}) => FunctionDefinition<K, ObjectValue<F>, WireResult<R>>;

function builder<K extends FunctionKind, M extends DataModel>(
  kind: K,
  schema?: SchemaDefinition,
): FunctionBuilder<K, M> {
  return (definition) => {
    const description = v.object(definition.args ?? {}).description;
    const handler = definition.handler;
    return Object.freeze({
      [definitionBrand]: true as const,
      kind,
      args: description,
      async invoke(input: unknown, host: HostBridge) {
        // A snapshot both rejects lossy JSON and prevents a caller mutating args
        // while a handler is suspended on a database operation.
        const args = jsonSnapshot(input, "args");
        validate(description, args);

        const providers = async <T>(interfaceName: string) =>
          (await callHost(host, "plugin.providers", { interface: interfaceName })).map((id) =>
            createApi<T>(id),
          );
        const run = async (
          kind: "query" | "mutation",
          reference: { [functionName]: string },
          input: unknown,
        ) =>
          callHost(host, kind === "query" ? "action.runQuery" : "action.runMutation", {
            name: reference[functionName],
            args: jsonSnapshot(input, "nested call args"),
          });
        const ctx = Object.freeze(
          kind === "action"
            ? {
                use: <T>(api: T) => bindCalls(api, host),
                signal: host.signal,
                env: (name: string) => callHost(host, "action.env", { name }),
                runQuery: (reference: { [functionName]: string }, args: unknown) =>
                  run("query", reference, args),
                runMutation: (reference: { [functionName]: string }, args: unknown) =>
                  run("mutation", reference, args),
                providers,
              }
            : {
                db:
                  kind === "query"
                    ? createDatabase<M>(host, false, schema)
                    : createDatabase<M>(host, true, schema),
                use: <T>(api: T) => bindCalls(api, host),
                providers,
              },
        );
        // The generic kind determines the context; the branch above enforces it
        // at runtime as well. Plugin reference kinds are erased, so the kernel
        // also enforces query-only calls. This cast never widens author types.
        const result = await handler(
          ctx as unknown as Parameters<typeof handler>[0],
          args as Parameters<typeof handler>[1],
        );
        const wire = result === undefined ? null : result;
        return jsonSnapshot(wire, "function result");
      },
    });
  };
}

function bindCalls<T>(api: T, host: HostBridge): PluginCalls<T, FunctionKind> {
  const bind = (reference: unknown): unknown =>
    new Proxy(() => {}, {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        return bind((reference as Record<string, unknown>)[key]);
      },
      apply(_target, _thisArg, argumentsList) {
        if (argumentsList.length !== 1) throw new Error("Plugin calls require one argument object");
        return callHost(host, "plugin.call", {
          name: (reference as { [functionName]: string })[functionName],
          args: jsonSnapshot(argumentsList[0], "plugin call args"),
        });
      },
    });
  return bind(api) as PluginCalls<T, FunctionKind>;
}

/** Loose builders are useful without a schema; createFunctions adds table types. */
export const query = builder<"query", Record<string, JsonObject>>("query");
export const mutation = builder<"mutation", Record<string, JsonObject>>("mutation");
export const action = builder<"action", Record<string, JsonObject>>("action");
export function createFunctions<S extends SchemaDefinition>(
  schema: S,
): {
  query: FunctionBuilder<"query", ModelFromSchema<S>>;
  mutation: FunctionBuilder<"mutation", ModelFromSchema<S>>;
  action: FunctionBuilder<"action", ModelFromSchema<S>>;
} {
  return {
    query: builder("query", schema),
    mutation: builder("mutation", schema),
    action: builder<"action", ModelFromSchema<S>>("action", schema),
  };
}

export type FunctionRegistry = Readonly<Record<string, FunctionDefinition>>;

export function createRegistry(modules: Record<string, object>): FunctionRegistry {
  const entries: [string, FunctionDefinition][] = [];
  for (const [module, exports] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(exports)) {
      if (
        value !== null &&
        typeof value === "object" &&
        (value as Partial<FunctionDefinition>)[definitionBrand] === true
      ) {
        entries.push([`${module}:${name}`, value as FunctionDefinition]);
      }
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

/** Host inspection does not execute handlers or require a bridge. */
export function functionMetadata(
  registry: FunctionRegistry,
): { name: string; kind: FunctionKind; args: ValidatorDescription }[] {
  return Object.entries(registry).map(([name, definition]) => ({
    name,
    kind: definition.kind,
    args: definition.args,
  }));
}

export async function invokeFunction(
  registry: FunctionRegistry,
  request: { name: string; args: JsonValue },
  host: HostBridge,
): Promise<JsonValue> {
  if (!Object.hasOwn(registry, request.name)) throw new Error(`Unknown function: ${request.name}`);
  return registry[request.name].invoke(request.args, host);
}
