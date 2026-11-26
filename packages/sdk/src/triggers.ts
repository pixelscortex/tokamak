import { createFunctions, invokeFunction, mutation, type MutationContext } from "./functions";
import type { HostBridge } from "./host";
import type { DataModel, ModelFromSchema, SchemaDefinition } from "./schema";
import type { TableDocument, TableReference } from "./validators";
import type { Id, JsonObject, JsonValue } from "./values";

const triggerBrand = Symbol("tokamak.trigger");

export type TriggerChange<Doc extends { _id: string }> = { id: Doc["_id"] } & (
  | { operation: "insert"; oldDoc: null; newDoc: Doc }
  | { operation: "update"; oldDoc: Doc; newDoc: Doc }
  | { operation: "delete"; oldDoc: Doc; newDoc: null }
);

interface TriggerDefinition {
  readonly [triggerBrand]: true;
  readonly table: string;
  invoke(change: JsonValue, host: HostBridge): Promise<JsonValue>;
}

type TriggerBuilder<M extends DataModel, Local extends string = never> = <
  T extends TableReference<string> | Local,
>(
  table: T,
  handler: (
    ctx: MutationContext<M>,
    change: TriggerChange<
      T extends TableReference<string>
        ? TableDocument<T>
        : M[T & keyof M] & { _id: Id<T & string>; _creationTime: number }
    >,
  ) => void | Promise<void>,
) => TriggerDefinition;

function triggerBuilder<M extends DataModel, Local extends string>(
  schema?: SchemaDefinition,
): TriggerBuilder<M, Local> {
  return (table, handler) => {
    const build = schema ? createFunctions(schema).mutation : mutation;
    return Object.freeze({
      [triggerBrand]: true as const,
      table: typeof table === "string" ? table : (table as TableReference<string>).qualifiedName,
      invoke(change: JsonValue, host: HostBridge) {
        const definition = build({
          handler: async (ctx) => {
            await handler(ctx as unknown as MutationContext<M>, change as never);
            return null;
          },
        });
        return invokeFunction({ trigger: definition }, { name: "trigger", args: {} }, host);
      },
    });
  };
}

export const trigger = triggerBuilder<Record<string, JsonObject>, never>();

export function createTrigger<S extends SchemaDefinition>(
  schema: S,
): TriggerBuilder<ModelFromSchema<S>, Extract<keyof S["tables"], string>> {
  return triggerBuilder(schema);
}

export function createTriggerRegistry(modules: Record<string, object>) {
  return Object.fromEntries(
    Object.entries(modules).flatMap(([module, exports]) =>
      Object.entries(exports).flatMap(([name, value]) =>
        value?.[triggerBrand] === true ? [[`${module}:${name}`, value as TriggerDefinition] as const] : [],
      ),
    ),
  );
}

type TriggerRegistry = ReturnType<typeof createTriggerRegistry>;

export function triggerMetadata(triggers: TriggerRegistry) {
  return Object.entries(triggers).map(([name, { table }]) => ({ name, table }));
}

export function invokeTrigger(
  triggers: TriggerRegistry,
  request: { name: string; change: JsonValue },
  host: HostBridge,
) {
  if (!Object.hasOwn(triggers, request.name)) throw new Error(`Unknown trigger: ${request.name}`);
  return triggers[request.name].invoke(request.change, host);
}
