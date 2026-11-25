import { functionKind, functionName, type ArgsOf, type HookReference, type ResultOf } from "./api";
import {
  action,
  mutation,
  query,
  createFunctions,
  invokeFunction,
  type CallerActionContext,
  type Failure,
  type MutationContext,
  type FunctionKind,
  type QueryContext,
} from "./functions";
import type { HostBridge } from "./host";
import type { DataModel, ModelFromSchema, SchemaDefinition } from "./schema";
import { jsonSnapshot, type JsonObject, type JsonValue } from "./values";
import { Visibility } from "./visibility";

const hookBrand = Symbol("tokamak.hook");

type Reference = HookReference<FunctionKind, unknown, unknown>;
type HookKind = "query" | "mutation" | "action";
type Context<T extends Reference, M extends DataModel> =
  T extends HookReference<"action", unknown, unknown>
    ? CallerActionContext
    : T extends HookReference<"mutation", unknown, unknown>
      ? MutationContext<M>
      : QueryContext<M>;
type OwnerOf<T> =
  T extends HookReference<FunctionKind, unknown, unknown, Visibility, infer Owner> ? Owner : never;
type HookStage = "before" | "after";
type MaybePromise<T> = T | Promise<T>;

type HookHandlers<T extends Reference, M extends DataModel> = {
  before?: (ctx: Context<T, M>, args: ArgsOf<T>) => MaybePromise<ArgsOf<T> | Failure<string, JsonValue>>;
  after?: T extends { readonly pointBeforeOnly: true }
    ? never
    : (ctx: Context<T, M>, result: ResultOf<T>, args: ArgsOf<T>) => MaybePromise<ResultOf<T>>;
};

interface HookDefinition<T extends Reference = Reference> {
  readonly [hookBrand]: true;
  readonly reference: T;
  readonly kind: HookKind;
  readonly target: string;
  readonly before: boolean;
  readonly after: boolean;
  invoke(stage: HookStage, input: JsonObject, host: HostBridge, targetKind?: HookKind): Promise<JsonValue>;
}

type HookBuilder<M extends DataModel> = <T extends Reference>(
  target: T &
    (T extends HookReference<HookKind, unknown, unknown>
      ? string extends OwnerOf<T>
        ? { readonly error: "hooks must target another plugin" }
        : unknown
      : { readonly error: "only queries, mutations and actions can be hooked" }),
  handlers: HookHandlers<NoInfer<T>, M>,
) => HookDefinition<T>;

function hookBuilder<M extends DataModel>(schema?: SchemaDefinition): HookBuilder<M> {
  return (reference, handlers) => {
    const target = reference[functionName];
    const kind = reference[functionKind] ?? "query";
    if (kind === "local") throw new Error("Only queries, mutations and actions can be hooked");
    const functions = schema ? createFunctions(schema) : { query, mutation, action };
    return Object.freeze({
      [hookBrand]: true as const,
      reference,
      kind,
      target,
      before: !!handlers.before,
      after: !!handlers.after,
      invoke(stage: HookStage, input: JsonObject, host: HostBridge, targetKind = kind) {
        const handler = async (context: unknown) => {
          type Ctx = Parameters<NonNullable<typeof handlers.before>>[0];
          const ctx = context as Ctx;
          const value = await (stage === "before"
            ? handlers.before!(ctx, input.args as never)
            : handlers.after!(ctx as never, input.result as never, input.args as never));
          return target.includes("#") && value !== undefined
            ? jsonSnapshot(value, "point hook result", Infinity, true)
            : value;
        };
        const definition =
          targetKind === "action"
            ? functions.action({ handler })
            : targetKind === "mutation"
              ? functions.mutation({ handler })
              : functions.query({ handler });
        return invokeFunction({ hook: definition }, { name: "hook", args: {} }, host);
      },
    });
  };
}

export const hook = hookBuilder<Record<string, JsonObject>>();

export function createHook<S extends SchemaDefinition>(schema: S): HookBuilder<ModelFromSchema<S>> {
  return hookBuilder(schema);
}

export function createHookRegistry(modules: Record<string, object>, kinds: Record<string, HookKind> = {}) {
  return Object.fromEntries(
    Object.entries(modules).flatMap(([module, exports]) =>
      Object.entries(exports).flatMap(([name, value]) =>
        value?.[hookBrand] === true
          ? [
              [
                `${module}:${name}`,
                { ...value, kind: kinds[`${module}:${name}`] ?? value.kind } as HookDefinition,
              ] as const,
            ]
          : [],
      ),
    ),
  );
}

export type HookRegistry = ReturnType<typeof createHookRegistry>;

export function hookMetadata(hooks: HookRegistry) {
  return Object.entries(hooks).map(([name, { target, kind, before, after }]) => ({
    name,
    target,
    kind,
    before,
    after,
  }));
}

export function invokeHook(
  hooks: HookRegistry,
  request: { name: string; target?: string; stage: HookStage; args: JsonValue; result?: JsonValue },
  host: HostBridge,
) {
  const hook = Object.hasOwn(hooks, request.name) ? hooks[request.name] : undefined;
  if (!hook?.[request.stage] || (request.target !== undefined && request.target !== hook.target)) {
    throw new Error(`Unknown hook stage: ${request.name}`);
  }
  return hook.invoke(request.stage, request, host, hook.kind);
}
