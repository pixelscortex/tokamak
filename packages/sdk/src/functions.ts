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
import { functionName, type FunctionReference } from "./api";
import { callHost } from "./host";
import type { LocalProcess, WithPrograms } from "./local";
import { withServerContracts } from "./internal/contracts";
import { Visibility } from "./visibility";

export type ServerFunctionKind = "query" | "mutation" | "action";
export type FunctionKind = ServerFunctionKind | "local";

/** Authenticated caller, preserved across subscriptions and plugin calls. */
export interface User {
  readonly id: string;
  readonly name: string;
  readonly role: "owner" | "admin" | "member";
}

export interface Device {
  readonly id: string;
  readonly name: string;
}

/** Identity used by standalone SDK hosts that do not provide a device. */
export const LOCAL_USER = "local";
export const FALLBACK_LOCAL_DEVICE: Device = Object.freeze({ id: "device:local", name: "This computer" });

export interface AuthContext {
  readonly user: User;
  readonly device: Device;
}

/**
 * The device of the server's own calls: a plugin's `maintenance` entry runs as
 * the server, never as a person or one of their devices. Real devices have
 * generated ids, so no window or local part can carry this one.
 */
export const SERVER_DEVICE_ID = "device:server";

/** Whether the caller is the server itself (its maintenance), not a person's window or local part. */
export function isServerCall(auth: Pick<AuthContext, "device">): boolean {
  return auth.device.id === SERVER_DEVICE_ID;
}

export type Failure<K extends string, D> = {
  readonly failed: true;
  readonly kind: K;
  readonly data: D;
};

type WireValue<V, HasFailure extends boolean> = V extends void
  ? null
  : HasFailure extends true
    ? V extends object
      ? V extends readonly unknown[]
        ? V
        : "failed" extends keyof V
          ? V
          : V & { readonly failed?: undefined }
      : V
    : V;

export type WireResult<R> = WireValue<
  Awaited<R>,
  [Extract<Awaited<R>, Failure<string, unknown>>] extends [never] ? false : true
>;

/** Return an expected failure as a value, so callers can narrow it by kind. */
export function fail<const K extends string, D extends JsonValue>(kind: K, data: D): Failure<K, D> {
  return { failed: true, kind, data };
}

type FailureOf<T> = Extract<T, Failure<string, unknown>>;
type NarrowFailure<T> = [FailureOf<T>] extends [never] ? T & Failure<string, unknown> : FailureOf<T>;

/** Narrow a result to a failure, including when success is a primitive or null. */
export function isFailure<T>(value: T): value is NarrowFailure<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    "failed" in value &&
    value.failed === true &&
    "kind" in value &&
    typeof value.kind === "string" &&
    Object.hasOwn(value, "data")
  );
}

/** Bind finite generated references to host-mediated calls, never import handlers. */
export type PluginCalls<T, K extends FunctionKind> =
  T extends FunctionReference<infer Kind, infer A, infer R>
    ? Kind extends K
      ? (args: A) => Promise<R>
      : never
    : { readonly [P in keyof T]: PluginCalls<T[P], K> };

type RunFunction<K extends FunctionKind> = <A, R>(
  reference: FunctionReference<K, A, R>,
  args: NoInfer<A>,
) => Promise<R>;

export interface QueryContext<M extends DataModel> {
  readonly auth: AuthContext;
  readonly db: DatabaseReader<M>;
  runQuery: RunFunction<"query">;
  use<T>(api: T): PluginCalls<T, "query">;
}

export interface MutationContext<M extends DataModel> {
  readonly auth: AuthContext;
  readonly db: DatabaseWriter<M>;
  runQuery: RunFunction<"query">;
  runMutation: RunFunction<"mutation">;
  use<T>(api: T): PluginCalls<T, "query" | "mutation">;
}

/** Actions have no database capability; each nested call owns its transaction. */
export interface ActionContext {
  readonly auth: AuthContext;
  use<T>(api: T): PluginCalls<T, ServerFunctionKind>;
  readonly signal?: HostBridge["signal"];
  readonly crypto: {
    hashPassword(password: string): Promise<string>;
    verifyPassword(password: string, hash: string): Promise<boolean>;
    verifyAndRehashPassword(
      password: string,
      hash: string,
    ): Promise<{
      valid: boolean;
      replacementHash?: string;
    }>;
  };
  /** Requires a manifest env:<name> grant; unset values return null. */
  env(name: string): Promise<string | null>;
  runQuery: RunFunction<"query">;
  runMutation: RunFunction<"mutation">;
  runAction: RunFunction<"action">;
}

export interface LocalContext {
  readonly auth: AuthContext;
  readonly signal: NonNullable<HostBridge["signal"]>;
  readonly proc: LocalProcess;
  /** Contains programs started by this callback and by any local providers it calls. */
  readonly withPrograms: WithPrograms;
  runQuery<A, R>(reference: FunctionReference<"query", A, R>, args: NoInfer<A>): Promise<R>;
  runMutation<A, R>(reference: FunctionReference<"mutation", A, R>, args: NoInfer<A>): Promise<R>;
  runAction<A, R>(reference: FunctionReference<"action", A, R>, args: NoInfer<A>): Promise<R>;
}

const definitionBrand = Symbol("tokamak.function");

export interface FunctionDefinition<
  K extends FunctionKind = FunctionKind,
  A = unknown,
  R = unknown,
  V extends Visibility = Visibility,
> {
  readonly [definitionBrand]: true;
  readonly kind: K;
  readonly visibility: V;
  readonly args: ValidatorDescription;
  readonly _types?: { args: A; result: R };
  invoke(args: unknown, host: HostBridge): Promise<JsonValue>;
  invokeLocal?(args: unknown, host: HostBridge, auth: AuthContext): unknown;
}

export type FunctionBuilder<
  K extends FunctionKind,
  M extends DataModel,
  V extends Visibility = typeof Visibility.Public,
> = <F extends Fields = Record<never, never>, R = unknown>(definition: {
  args?: F;
  handler: (
    ctx: K extends "query"
      ? QueryContext<M>
      : K extends "mutation"
        ? MutationContext<M>
        : K extends "local"
          ? LocalContext
          : ActionContext,
    args: ObjectValue<F>,
  ) => R;
}) => FunctionDefinition<K, ObjectValue<F>, WireResult<R>, V>;

function builder<
  K extends FunctionKind,
  M extends DataModel,
  V extends Visibility = typeof Visibility.Public,
>(kind: K, visibility: V, schema?: SchemaDefinition): FunctionBuilder<K, M, V> {
  return (definition) => {
    const description = v.object(definition.args ?? {}).description;
    const handler = definition.handler;
    return Object.freeze({
      [definitionBrand]: true as const,
      kind,
      visibility,
      args: description,
      ...(kind === "local"
        ? {
            // Contract members are called in the same worker and can receive
            // live objects. Window calls still enter invoke() and validate JSON.
            invokeLocal: (input: unknown, host: HostBridge, auth: AuthContext) =>
              handler(
                localContext(host, auth) as Parameters<typeof handler>[0],
                input as Parameters<typeof handler>[1],
              ),
          }
        : {}),
      async invoke(input: unknown, host: HostBridge) {
        // A snapshot both rejects lossy JSON and prevents a caller mutating args
        // while a handler is suspended on a database operation.
        const args = jsonSnapshot(input, "args");
        validate(description, args);
        // Direct definition invocation supports lightweight standalone hosts;
        // server entry points always supply the authenticated caller below.
        const auth =
          host.auth === null
            ? null
            : Object.freeze({
                user: Object.freeze(
                  host.auth?.user ?? host.user ?? { id: LOCAL_USER, name: "You", role: "owner" as const },
                ),
                device: Object.freeze(host.auth?.device ?? FALLBACK_LOCAL_DEVICE),
              });
        const caller = () => {
          if (!auth) throw new Error("There is no caller before sign-in");
          return auth;
        };

        const run =
          (expected: ServerFunctionKind) => (reference: { [functionName]: string }, input: unknown) => {
            const payload = {
              name: reference[functionName],
              args: jsonSnapshot(input, "nested call args"),
            };
            return kind === "action" && expected !== "action"
              ? callHost(host, expected === "query" ? "action.runQuery" : "action.runMutation", payload)
              : callHost(host, "plugin.call", { ...payload, kind: expected });
          };
        const ctx = Object.freeze(
          kind === "local"
            ? localContext(host, caller())
            : kind === "action"
              ? {
                  get auth() {
                    return caller();
                  },
                  use: <T>(api: T) => bindCalls(api, host),
                  signal: host.signal,
                  crypto: Object.freeze({
                    hashPassword: (password: string) => callHost(host, "crypto.hashPassword", { password }),
                    verifyPassword: (password: string, hash: string) =>
                      callHost(host, "crypto.verifyPassword", { password, hash }),
                    verifyAndRehashPassword: (password: string, hash: string) =>
                      callHost(host, "crypto.verifyAndRehashPassword", { password, hash }),
                  }),
                  env: (name: string) => callHost(host, "action.env", { name }),
                  runQuery: run("query"),
                  runMutation: run("mutation"),
                  runAction: run("action"),
                }
              : {
                  get auth() {
                    return caller();
                  },
                  db:
                    kind === "query"
                      ? createDatabase<M>(host, false, schema)
                      : createDatabase<M>(host, true, schema),
                  runQuery: run("query"),
                  ...(kind === "mutation" ? { runMutation: run("mutation") } : {}),
                  use: <T>(api: T) => bindCalls(api, host),
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

export function localContext(host: HostBridge, auth: AuthContext): LocalContext {
  if (!host.proc || !host.signal) throw new Error("Local functions require the client worker");
  async function run<A, R>(
    operation: "local.runQuery" | "local.runMutation" | "local.runAction",
    reference: FunctionReference<ServerFunctionKind, A, R>,
    input: A,
  ): Promise<R> {
    return (await callHost(host, operation, {
      name: reference[functionName],
      args: jsonSnapshot(input, "nested call args"),
    })) as R;
  }
  return {
    auth,
    proc: host.proc,
    withPrograms:
      host.withPrograms ??
      (() => {
        throw new Error("Program scopes require the client worker");
      }),
    signal: host.signal,
    runQuery: (reference, args) => run("local.runQuery", reference, args),
    runMutation: (reference, args) => run("local.runMutation", reference, args),
    runAction: (reference, args) => run("local.runAction", reference, args),
  };
}

function bindCalls<T>(api: T, host: HostBridge): PluginCalls<T, ServerFunctionKind> {
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
  return bind(api) as PluginCalls<T, ServerFunctionKind>;
}

/** Loose builders are useful without a schema; createFunctions adds table types. */
type LooseModel = Record<string, JsonObject>;
export const query = builder<"query", LooseModel>("query", Visibility.Public);
export const mutation = builder<"mutation", LooseModel>("mutation", Visibility.Public);
export const action = builder<"action", LooseModel>("action", Visibility.Public);
const localFunction = builder<"local", LooseModel>("local", Visibility.Public);

export function local<F extends Fields, R = unknown>(definition: {
  args: F;
  handler: (ctx: LocalContext, args: ObjectValue<F>) => R;
}): FunctionDefinition<"local", ObjectValue<F>, WireResult<R>, typeof Visibility.Public>;
// A separately declared handler cannot infer its argument from a later
// provide() call. An annotation preserves the input type when one is supplied.
export function local<A = any, R = unknown>(definition: {
  args?: undefined;
  handler: (ctx: LocalContext, args: A) => R;
}): FunctionDefinition<"local", A, WireResult<R>, typeof Visibility.Public>;
export function local(definition: {
  args?: Fields;
  handler: (ctx: LocalContext, args: never) => unknown;
}): unknown {
  return localFunction(definition as Parameters<typeof localFunction>[0]);
}
export const internalQuery = builder<"query", LooseModel, typeof Visibility.Internal>(
  "query",
  Visibility.Internal,
);
export const internalMutation = builder<"mutation", LooseModel, typeof Visibility.Internal>(
  "mutation",
  Visibility.Internal,
);
export const internalAction = builder<"action", LooseModel, typeof Visibility.Internal>(
  "action",
  Visibility.Internal,
);
/** Export a server function to dependencies without admitting window requests. */
export function pluginOnly<
  D extends FunctionDefinition<ServerFunctionKind, unknown, unknown, typeof Visibility.Public>,
>(definition: D): Omit<D, "visibility"> & { readonly visibility: typeof Visibility.PluginOnly } {
  if (definition.visibility !== Visibility.Public || (definition.kind as FunctionKind) === "local")
    throw new Error("Only non-internal server functions can be plugin-only");
  return Object.freeze({ ...definition, visibility: Visibility.PluginOnly });
}

export function createFunctions<S extends SchemaDefinition>(
  schema: S,
): {
  query: FunctionBuilder<"query", ModelFromSchema<S>>;
  mutation: FunctionBuilder<"mutation", ModelFromSchema<S>>;
  action: FunctionBuilder<"action", ModelFromSchema<S>>;
  local: typeof local;
  internalQuery: FunctionBuilder<"query", ModelFromSchema<S>, typeof Visibility.Internal>;
  internalMutation: FunctionBuilder<"mutation", ModelFromSchema<S>, typeof Visibility.Internal>;
  internalAction: FunctionBuilder<"action", ModelFromSchema<S>, typeof Visibility.Internal>;
} {
  return {
    query: builder("query", Visibility.Public, schema),
    mutation: builder("mutation", Visibility.Public, schema),
    action: builder<"action", ModelFromSchema<S>>("action", Visibility.Public, schema),
    local,
    internalQuery: builder("query", Visibility.Internal, schema),
    internalMutation: builder("mutation", Visibility.Internal, schema),
    internalAction: builder<"action", ModelFromSchema<S>, typeof Visibility.Internal>(
      "action",
      Visibility.Internal,
      schema,
    ),
  };
}

export type FunctionRegistry = Readonly<Record<string, FunctionDefinition>>;

export function createRegistry(
  modules: Record<string, object>,
  contractMethods: Record<string, unknown> = {},
): FunctionRegistry {
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
  for (const [name, value] of Object.entries(contractMethods)) {
    const method = value as FunctionDefinition | undefined;
    if (method?.[definitionBrand] !== true) throw new Error(`Invalid contract method: ${name}`);
    // Even a provider using a public builder gets a private contract address.
    entries.push([name, Object.freeze({ ...method, visibility: Visibility.Internal })]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

/** Host inspection does not execute handlers or require a bridge. */
export function functionMetadata(
  registry: FunctionRegistry,
): { name: string; kind: FunctionKind; args: ValidatorDescription; visibility: Visibility }[] {
  return Object.entries(registry).map(([name, definition]) => ({
    name,
    kind: definition.kind,
    args: definition.args,
    visibility: definition.visibility,
  }));
}

export async function invokeFunction(
  registry: FunctionRegistry,
  request: { name: string; args: JsonValue },
  host: HostBridge,
): Promise<JsonValue> {
  if (!Object.hasOwn(registry, request.name)) throw new Error(`Unknown function: ${request.name}`);
  const args = jsonSnapshot(request.args, "args");
  validate(registry[request.name].args, args);
  const auth = await callHost(host, "auth.current", {});
  return withServerContracts(host, () =>
    registry[request.name].invoke(args, {
      auth,
      signal: host.signal,
      proc: host.proc,
      withPrograms: host.withPrograms,
      op: (name, payload) => host.op(name, payload),
    }),
  );
}
