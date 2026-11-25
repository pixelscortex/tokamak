import { functionName, type ArgsOf, type FunctionReference, type ResultOf } from "./api";
import {
  query,
  createFunctions,
  invokeFunction,
  type Failure,
  type FunctionKind,
  type QueryContext,
} from "./functions";
import type { HostBridge } from "./host";
import type { DataModel, ModelFromSchema, SchemaDefinition } from "./schema";
import type { JsonObject, JsonValue } from "./values";
import { Visibility } from "./visibility";

const hookBrand = Symbol("tokamak.hook");

type Reference = FunctionReference<FunctionKind, unknown, unknown>;
type PublicQuery = FunctionReference<"query", unknown, unknown, typeof Visibility.Public>;
type OwnerOf<T> =
  T extends FunctionReference<FunctionKind, unknown, unknown, Visibility, infer Owner> ? Owner : never;
type HookStage = "before" | "after";
type MaybePromise<T> = T | Promise<T>;

type HookHandlers<T extends Reference, M extends DataModel> = {
  before?: (ctx: QueryContext<M>, args: ArgsOf<T>) => MaybePromise<ArgsOf<T> | Failure<string, JsonValue>>;
  after?: (ctx: QueryContext<M>, result: ResultOf<T>, args: ArgsOf<T>) => MaybePromise<ResultOf<T>>;
};

interface HookDefinition<T extends Reference = Reference> {
  readonly [hookBrand]: true;
  readonly reference: T;
  readonly target: string;
  readonly before: boolean;
  readonly after: boolean;
  invoke(stage: HookStage, input: JsonObject, host: HostBridge): Promise<JsonValue>;
}

type HookBuilder<M extends DataModel> = <T extends Reference>(
  target: T &
    (T extends PublicQuery
      ? string extends OwnerOf<T>
        ? { readonly error: "hooks must target a public query of another plugin" }
        : unknown
      : T extends FunctionReference<"query", unknown, unknown>
        ? { readonly error: "hooks on internal and plugin-only functions are not supported yet" }
        : { readonly error: "hooks on mutations and actions are not supported yet" }),
  handlers: HookHandlers<NoInfer<T>, M>,
) => HookDefinition<T>;

function hookBuilder<M extends DataModel>(schema?: SchemaDefinition): HookBuilder<M> {
  return (reference, handlers) => {
    const target = reference[functionName];
    const build = schema ? createFunctions(schema).query : query;
    // Use the normal query context, with the hooking plugin's schema and host.
    return Object.freeze({
      [hookBrand]: true as const,
      reference,
      target,
      before: !!handlers.before,
      after: !!handlers.after,
      invoke(stage: HookStage, input: JsonObject, host: HostBridge) {
        const run =
          stage === "before"
            ? (ctx: QueryContext<M>) => handlers.before!(ctx, input.args as never)
            : (ctx: QueryContext<M>) => handlers.after!(ctx, input.result as never, input.args as never);
        const definition = build({ handler: (ctx) => run(ctx as unknown as QueryContext<M>) });
        return invokeFunction({ hook: definition }, { name: "hook", args: {} }, host);
      },
    });
  };
}

export const hook = hookBuilder<Record<string, JsonObject>>();

export function createHook<S extends SchemaDefinition>(schema: S): HookBuilder<ModelFromSchema<S>> {
  return hookBuilder(schema);
}

export function createHookRegistry(modules: Record<string, object>) {
  return Object.fromEntries(
    Object.entries(modules).flatMap(([module, exports]) =>
      Object.entries(exports).flatMap(([name, value]) =>
        value?.[hookBrand] === true ? [[`${module}:${name}`, value as HookDefinition] as const] : [],
      ),
    ),
  );
}

export type HookRegistry = ReturnType<typeof createHookRegistry>;

export function hookMetadata(hooks: HookRegistry) {
  return Object.entries(hooks).map(([name, { target, before, after }]) => ({ name, target, before, after }));
}

export function invokeHook(
  hooks: HookRegistry,
  request: { name: string; stage: HookStage; args: JsonValue; result?: JsonValue },
  host: HostBridge,
) {
  if (!Object.hasOwn(hooks, request.name) || !hooks[request.name][request.stage]) {
    throw new Error(`Unknown hook stage: ${request.name}`);
  }
  return hooks[request.name].invoke(request.stage, request, host);
}
