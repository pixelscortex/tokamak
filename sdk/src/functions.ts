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

export type FunctionKind = "query" | "mutation";

type WireValue<V> = V extends void ? null : V;

export type WireResult<R> = WireValue<Awaited<R>>;

export interface QueryContext<M extends DataModel> {
  readonly db: DatabaseReader<M>;
}

export interface MutationContext<M extends DataModel> {
  readonly db: DatabaseWriter<M>;
}

const definitionBrand = Symbol("tokamak.function");

export interface FunctionDefinition<
  K extends FunctionKind = FunctionKind,
  A = unknown,
  R = unknown,
> {
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
    ctx: K extends "query" ? QueryContext<M> : MutationContext<M>,
    args: ObjectValue<F>,
  ) => R;
}) => FunctionDefinition<K, ObjectValue<F>, WireResult<R>>;

function builder<K extends FunctionKind, M extends DataModel>(kind: K): FunctionBuilder<K, M> {
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

        const ctx = Object.freeze({
          db: kind === "query" ? createDatabase<M>(host, false) : createDatabase<M>(host, true),
        });
        // The generic kind determines the context; the branch above enforces it
        // at runtime as well. This cast does not widen the author's context.
        const result = await handler(
          ctx as Parameters<typeof handler>[0],
          args as Parameters<typeof handler>[1],
        );
        const wire = result === undefined ? null : result;
        return jsonSnapshot(wire, "function result");
      },
    });
  };
}

/** Loose builders are useful without a schema; createFunctions adds table types. */
export const query = builder<"query", Record<string, JsonObject>>("query");
export const mutation = builder<"mutation", Record<string, JsonObject>>("mutation");
export function createFunctions<S extends SchemaDefinition>(
  _schema: S,
): {
  query: FunctionBuilder<"query", ModelFromSchema<S>>;
  mutation: FunctionBuilder<"mutation", ModelFromSchema<S>>;
} {
  return { query: builder("query"), mutation: builder("mutation") };
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
