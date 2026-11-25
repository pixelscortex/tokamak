// Definitions close over handlers instead of exposing an unvalidated handler
// entry point. The registry and host always invoke the same validation path.
import { createDatabase } from "./database";
import type { DatabaseReader, DatabaseWriter } from "./database";
import type { HostBridge } from "./host";
import type { DataModel, ModelFromSchema, SchemaDefinition } from "./schema";
import type { Fields, ObjectValue, Validator, ValidatorDescription } from "./validators";
import { v, validate } from "./validators";
import type { Id, JsonObject, JsonValue } from "./values";
import { jsonSnapshot } from "./values";
import { functionName, type FunctionReference } from "./api";
import { callHost } from "./host";
import type { LocalProcess, WithPrograms } from "./local";
import {
  contractScope,
  serverContracts,
  withServerContracts,
  type ContractContext,
} from "./internal/contracts";
import { Visibility } from "./visibility";

export type ServerFunctionKind = "query" | "mutation" | "action";
export type ActionTarget = "server" | "caller";
export type MachineFailure = Failure<"noMachine", null>;
export interface ActionOptions {
  on?: ActionTarget;
}
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

/** Host-owned metadata for this invocation. Anonymous calls have no user or device. */
export interface CallContext {
  readonly user: User | null;
  readonly device: Device | null;
  readonly threadId?: Id<"threads">;
  readonly depth: number;
}

export function callContext(
  auth: AuthContext | null,
  note?: CallContext | null,
  threadId?: Id<"threads">,
): CallContext {
  const thread = note?.threadId ?? threadId;
  return Object.freeze({
    user: auth ? Object.freeze({ ...auth.user }) : null,
    device: auth ? Object.freeze({ ...auth.device }) : null,
    depth: note?.depth ?? 0,
    ...(thread === undefined ? {} : { threadId: thread }),
  });
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

/** Return an expected failure that callers can narrow by kind. A mutation returning it rolls back its writes. */
export function fail<const K extends string>(kind: K): Failure<K, null>;
export function fail<const K extends string, D extends JsonValue>(kind: K, data: D): Failure<K, D>;
export function fail(kind: string, data: JsonValue = null): Failure<string, JsonValue> {
  return { failed: true, kind, data };
}

type FailureOf<T> = Extract<T, Failure<string, unknown>>;
type NarrowFailure<T> = [FailureOf<T>] extends [never] ? T & Failure<string, unknown> : FailureOf<T>;

/** Narrow a result to a failure, including when success is a primitive or null. */
export function isFailure<T>(value: T): value is NarrowFailure<T> {
  // Keep this wire shape in sync with the server's failure_kind guard.
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

export interface QueryContext<M extends DataModel> extends ContractContext {
  readonly auth: AuthContext;
  readonly call: CallContext;
  readonly db: DatabaseReader<M>;
  runQuery: RunFunction<"query">;
  use<T>(api: T): PluginCalls<T, "query">;
}

export interface MutationContext<M extends DataModel> extends ContractContext {
  readonly auth: AuthContext;
  readonly call: CallContext;
  readonly db: DatabaseWriter<M>;
  runQuery: RunFunction<"query">;
  runMutation: RunFunction<"mutation">;
  use<T>(api: T): PluginCalls<T, "query" | "mutation">;
}

/** Actions have no database capability; each nested call owns its transaction. */
export interface ActionContext extends ContractContext {
  readonly auth: AuthContext;
  readonly call: CallContext;
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
  runAction: RunAction;
}

interface RunAction {
  <A, R>(reference: FunctionReference<"action", A, R>, args: NoInfer<A>): Promise<R>;
  <A, R>(
    reference: FunctionReference<"action", A, R>,
    args: NoInfer<A>,
    options: ActionOptions,
  ): Promise<R | MachineFailure>;
}

export interface CallerActionContext extends ActionContext {
  readonly signal: LocalContext["signal"];
  readonly retiring?: LocalContext["retiring"];
  readonly proc: LocalProcess;
  readonly withPrograms: <T>(
    run: (forceStop: () => Promise<void>, context: CallerActionContext) => Promise<T>,
  ) => Promise<T>;
}

const missingMachine = Symbol("noMachine");

export function requireActionMachine(): never {
  throw missingMachine;
}

export interface LocalContext extends ContractContext {
  readonly auth: AuthContext;
  readonly call: CallContext;
  readonly signal: NonNullable<HostBridge["signal"]>;
  /** QuickJS root call only: its own installed build was replaced. Calls can still settle. */
  readonly retiring?: HostBridge["signal"];
  readonly proc: LocalProcess;
  /** Use the callback context to start programs and select providers owned by this scope. */
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
  readonly returns?: ValidatorDescription;
  readonly on?: ActionTarget;
  readonly _types?: { args: A; result: R };
  invoke(args: unknown, host: HostBridge): Promise<JsonValue>;
  invokeLocal?(args: unknown, host: HostBridge, auth: AuthContext, call: CallContext): unknown;
}

type ReturnValidator = Validator<unknown> | undefined;

type FunctionOptions<K extends FunctionKind, M extends DataModel, F extends Fields, R, S> = {
  args?: F;
  returns?: K extends "query" ? S : never;
  on?: K extends "action" ? ActionTarget : never;
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
};

type BuiltFunction<K extends FunctionKind, A, R, V extends Visibility, S> = FunctionDefinition<
  K,
  A,
  WireResult<R>,
  V
> &
  (S extends Validator<unknown> ? { readonly returns: ValidatorDescription } : unknown);

export type FunctionBuilder<
  K extends FunctionKind,
  M extends DataModel,
  V extends Visibility = typeof Visibility.Public,
> = <F extends Fields = Record<never, never>, R = unknown, S extends ReturnValidator = undefined>(
  definition: FunctionOptions<K, M, F, R, S>,
) => BuiltFunction<K, ObjectValue<F>, R, V, S>;

function builder<
  K extends FunctionKind,
  M extends DataModel,
  V extends Visibility = typeof Visibility.Public,
>(kind: K, visibility: V, schema?: SchemaDefinition): FunctionBuilder<K, M, V> {
  return <F extends Fields, R, S extends ReturnValidator>(definition: FunctionOptions<K, M, F, R, S>) => {
    const description = v.object(definition.args ?? {}).description;
    const handler = definition.handler;
    const returns = definition.returns?.description;
    return Object.freeze({
      [definitionBrand]: true as const,
      kind,
      visibility,
      args: description,
      ...(returns ? { returns } : {}),
      ...(definition.on === undefined ? {} : { on: definition.on }),
      ...(kind === "local"
        ? {
            // Contract members are called in the same worker and can receive
            // live objects. Window calls still enter invoke() and validate JSON.
            invokeLocal: (input: unknown, host: HostBridge, auth: AuthContext, call: CallContext) =>
              handler(
                localContext(host, auth, call) as Parameters<typeof handler>[0],
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
        const call = callContext(
          auth,
          host.call,
          (kind === "local" || host.proc) && !host.call?.threadId
            ? threadArgument(description, args)
            : undefined,
        );
        const caller = () => {
          if (!auth) throw new Error("There is no caller before sign-in");
          return auth;
        };

        const actionContext = (bridge: HostBridge): CallerActionContext => {
          const machine = requireActionMachine;
          const run =
            (expected: ServerFunctionKind) =>
            (reference: { [functionName]: string }, input: unknown, options?: ActionOptions) =>
              callHost(bridge, "plugin.call", {
                name: reference[functionName],
                args: jsonSnapshot(input, "nested call args"),
                kind: expected,
                ...(options?.on === undefined ? {} : { on: options.on }),
              });
          return Object.freeze({
            call,
            get auth() {
              return caller();
            },
            [contractScope]: {
              list: (key, id, options) =>
                (key.place === "local" && bridge.contracts ? bridge.contracts : serverContracts(bridge)).list(
                  key,
                  id,
                  options,
                ),
            },
            use: <T>(api: T) => bindCalls(api, bridge),
            signal: bridge.signal!,
            retiring: bridge.retiring,
            proc: bridge.proc ?? machine,
            withPrograms: <T>(work: (stop: () => Promise<void>, ctx: CallerActionContext) => Promise<T>) =>
              bridge.withPrograms?.((stop, scoped) => work(stop, actionContext(scoped))) ?? machine(),
            crypto: Object.freeze({
              hashPassword: (password: string) => callHost(bridge, "crypto.hashPassword", { password }),
              verifyPassword: (password: string, hash: string) =>
                callHost(bridge, "crypto.verifyPassword", { password, hash }),
              verifyAndRehashPassword: (password: string, hash: string) =>
                callHost(bridge, "crypto.verifyAndRehashPassword", { password, hash }),
            }),
            env: (name: string) => callHost(bridge, "action.env", { name }),
            runQuery: (reference, args) =>
              bridge.proc
                ? run("query")(reference, args)
                : callHost(bridge, "action.runQuery", {
                    name: reference[functionName],
                    args: jsonSnapshot(args, "nested call args"),
                  }),
            runMutation: (reference, args) =>
              bridge.proc
                ? run("mutation")(reference, args)
                : callHost(bridge, "action.runMutation", {
                    name: reference[functionName],
                    args: jsonSnapshot(args, "nested call args"),
                  }),
            runAction: run("action"),
          } as CallerActionContext);
        };
        const run =
          (expected: ServerFunctionKind) => (reference: { [functionName]: string }, input: unknown) => {
            const payload = {
              name: reference[functionName],
              args: jsonSnapshot(input, "nested call args"),
            };
            return callHost(host, "plugin.call", { ...payload, kind: expected });
          };
        const ctx = Object.freeze(
          kind === "local"
            ? localContext(host, caller(), call)
            : kind === "action"
              ? actionContext(host)
              : {
                  call,
                  get auth() {
                    return caller();
                  },
                  db:
                    kind === "query"
                      ? createDatabase<M>(host, false, schema)
                      : createDatabase<M>(host, true, schema),
                  runQuery: run("query"),
                  ...(kind === "mutation" ? { runMutation: run("mutation") } : {}),
                  [contractScope]: serverContracts(host),
                  use: <T>(api: T) => bindCalls(api, host),
                },
        );
        // The generic kind determines the context; the branch above enforces it
        // at runtime as well. Plugin reference kinds are erased, so the kernel
        // also enforces query-only calls. This cast never widens author types.
        try {
          const result = await handler(
            ctx as unknown as Parameters<typeof handler>[0],
            args as Parameters<typeof handler>[1],
          );
          const snapshot = jsonSnapshot(result === undefined ? null : result, "function result");
          if (returns) validate(returns, snapshot, "result");
          return snapshot;
        } catch (error) {
          if (error === missingMachine) return fail("noMachine", null);
          throw error;
        }
      },
    }) as BuiltFunction<K, ObjectValue<F>, R, V, S>;
  };
}

const CHAT_THREAD_ID_PREFIX = "chat/threads:";

// Local function validators run in the worker; a qualified ID identifies its owner.
export function threadArgument(schema: ValidatorDescription, value: unknown): Id<"threads"> | undefined {
  switch (schema.kind) {
    case "id":
      return schema.table === "threads" &&
        typeof value === "string" &&
        value.startsWith(CHAT_THREAD_ID_PREFIX)
        ? (value as Id<"threads">)
        : undefined;
    case "optional":
      return value === undefined ? undefined : threadArgument(schema.inner, value);
    case "object":
      for (const key of Object.keys(schema.fields).sort()) {
        const id = threadArgument(schema.fields[key], (value as JsonObject)[key]);
        if (id !== undefined) return id;
      }
      return;
    case "array":
      for (const item of value as unknown[]) {
        const id = threadArgument(schema.item, item);
        if (id !== undefined) return id;
      }
      return;
    case "union":
      for (const member of schema.members) {
        try {
          validate(member, value);
        } catch {
          continue;
        }
        return threadArgument(member, value);
      }
  }
}

export function localContext(host: HostBridge, auth: AuthContext, call: CallContext): LocalContext {
  if (!host.proc || !host.signal) throw new Error("Local functions require a plugin process");
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
  return Object.freeze<LocalContext>({
    auth,
    call,
    proc: host.proc,
    [contractScope]: host.contracts ?? {
      list() {
        throw new Error("Local contracts require a plugin process");
      },
    },
    withPrograms(run) {
      if (!host.withPrograms) throw new Error("Program scopes require a plugin process");
      return host.withPrograms((forceStop, scoped) => run(forceStop, localContext(scoped, auth, call)));
    },
    signal: host.signal,
    retiring: host.retiring,
    runQuery: (reference, args) => run("local.runQuery", reference, args),
    runMutation: (reference, args) => run("local.runMutation", reference, args),
    runAction: (reference, args) => run("local.runAction", reference, args),
  });
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
type ActionBuilder<V extends Visibility> = {
  <F extends Fields = Record<never, never>, R = unknown>(definition: {
    on: "caller";
    args?: F;
    handler: (ctx: CallerActionContext, args: ObjectValue<F>) => R;
  }): FunctionDefinition<"action", ObjectValue<F>, WireResult<R | MachineFailure>, V> & {
    readonly on: "caller";
  };
  <F extends Fields = Record<never, never>, R = unknown>(definition: {
    on?: "server";
    args?: F;
    handler: (ctx: ActionContext, args: ObjectValue<F>) => R;
  }): FunctionDefinition<"action", ObjectValue<F>, WireResult<R>, V>;
};

function actionBuilder<V extends Visibility>(visibility: V): ActionBuilder<V> {
  return builder<"action", LooseModel, V>("action", visibility) as ActionBuilder<V>;
}

export const action = actionBuilder(Visibility.Public);
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
export const internalAction = actionBuilder(Visibility.Internal);
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
  action: typeof action;
  local: typeof local;
  internalQuery: FunctionBuilder<"query", ModelFromSchema<S>, typeof Visibility.Internal>;
  internalMutation: FunctionBuilder<"mutation", ModelFromSchema<S>, typeof Visibility.Internal>;
  internalAction: typeof internalAction;
} {
  return {
    query: builder("query", Visibility.Public, schema),
    mutation: builder("mutation", Visibility.Public, schema),
    action,
    local,
    internalQuery: builder("query", Visibility.Internal, schema),
    internalMutation: builder("mutation", Visibility.Internal, schema),
    internalAction,
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
export function functionMetadata(registry: FunctionRegistry): {
  name: string;
  kind: FunctionKind;
  args: ValidatorDescription;
  returns?: ValidatorDescription;
  visibility: Visibility;
  on?: ActionTarget;
}[] {
  return Object.entries(registry).map(([name, definition]) => ({
    name,
    kind: definition.kind,
    args: definition.args,
    ...(definition.returns ? { returns: definition.returns } : {}),
    visibility: definition.visibility,
    ...(definition.on === undefined ? {} : { on: definition.on }),
  }));
}

export async function invokeFunction(
  registry: FunctionRegistry,
  request: { name: string; args: JsonValue },
  host: HostBridge,
  recordThread?: (threadId: Id<"threads">) => void,
): Promise<JsonValue> {
  if (!Object.hasOwn(registry, request.name)) throw new Error(`Unknown function: ${request.name}`);
  const args = jsonSnapshot(request.args, "args");
  const definition = registry[request.name];
  validate(definition.args, args);
  const thread = recordThread && threadArgument(definition.args, args);
  if (thread) recordThread(thread);
  const note = await callHost(host, "auth.current", { call: true });
  const auth =
    note && note.user !== null && note.device !== null ? { user: note.user, device: note.device } : null;
  const threadId = note?.threadId ?? thread;
  const invoke = () =>
    definition.invoke(args, {
      auth,
      call: threadId ? callContext(auth, note, threadId) : note,
      signal: host.signal,
      retiring: host.retiring,
      proc: host.proc,
      withPrograms: host.withPrograms,
      contracts: host.contracts,
      op: (name, payload) => host.op(name, payload),
    });
  return definition.kind === "query" || definition.kind === "mutation"
    ? withServerContracts(host, invoke)
    : invoke();
}
