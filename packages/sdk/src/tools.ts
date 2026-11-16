import type { FunctionBuilder, MutationContext } from "./functions";
import type { DataModel } from "./schema";
import { v, validate, type Fields, type ObjectValue, type ValidatorDescription } from "./validators";
import type { JsonValue } from "./values";

export type JsonSchema = { [key: string]: JsonValue };
export type ToolOutput = { result: JsonValue; summary: string; model?: string; view?: string };
export type ToolDescription = { name: string; description: string; parameters: JsonSchema; view?: string };

type Tool<F extends Fields> = {
  description: string;
  args: F;
  view?: string;
  handler(ctx: MutationContext<DataModel>, args: ObjectValue<F>): ToolOutput | Promise<ToolOutput>;
};

export function tool<F extends Fields>(definition: Tool<F>): Tool<F> {
  return definition;
}

export function toJsonSchema(description: ValidatorDescription): JsonSchema {
  switch (description.kind) {
    case "any":
      return {};
    case "id":
      return { type: "string" };
    case "optional":
      return toJsonSchema(description.inner);
    case "literal":
      return { const: description.value };
    case "array":
      return { type: "array", items: toJsonSchema(description.item) };
    case "union":
      return { anyOf: description.members.map(toJsonSchema) };
    case "object":
      return objectSchema(description.fields);
    default:
      return { type: description.kind };
  }
}

function objectSchema(fields: Record<string, ValidatorDescription>): JsonSchema {
  const entries = Object.entries(fields);

  return {
    type: "object",
    properties: Object.fromEntries(entries.map(([key, value]) => [key, toJsonSchema(value)])),
    required: entries.filter(([, value]) => value.kind !== "optional").map(([key]) => key),
    additionalProperties: false,
  };
}

export function defineTools<M extends DataModel, T extends { [K in keyof T]: Tool<Fields> }>(
  builders: { query: FunctionBuilder<"query", M>; mutation: FunctionBuilder<"mutation", M> },
  tools: T,
) {
  const describe = builders.query({
    handler: (): ToolDescription[] =>
      Object.entries(tools as Record<string, Tool<Fields>>).map(([name, definition]) => ({
        name,
        description: definition.description,
        parameters: toJsonSchema(v.object(definition.args).description),
        ...(definition.view === undefined ? {} : { view: definition.view }),
      })),
  });

  const invoke = builders.mutation({
    args: { name: v.string(), args: v.any(), threadId: v.string() },
    handler: async (ctx, { name, args }): Promise<ToolOutput> => {
      if (!Object.hasOwn(tools, name)) throw new Error(`Unknown tool: ${name}`);

      const definition = tools[name as keyof T];
      validate(v.object(definition.args).description, args);
      const out = await definition.handler(
        ctx as unknown as MutationContext<DataModel>,
        args as ObjectValue<Fields>,
      );
      return {
        ...out,
        ...(definition.view === undefined ? {} : { view: definition.view }),
        model: out.model ?? JSON.stringify(out.result),
      };
    },
  });

  return { describe, invoke };
}
