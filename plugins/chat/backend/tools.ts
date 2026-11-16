import { functionName, type ActionContext, type FunctionReference, type ToolDescription, type ToolOutput, type JsonValue } from "@tokamak/sdk";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { checkToolArgs } from "./parts";

type ToolsApi = { tools: {
  describe: FunctionReference<"query", Record<string, never>, ToolDescription[]>;
  invoke: FunctionReference<"mutation", { name: string; args: JsonValue; threadId: string }, ToolOutput>;
} };
export type ToolTarget = { plugin: string; toolName: string };

export async function discoverTools(
  ctx: ActionContext, threadId: string, running: () => Promise<boolean>,
  acknowledged: (callId: string) => Promise<unknown>,
  approve?: (callId: string, target: ToolTarget, args: JsonValue) => Promise<void>,
) {
  const tools: ToolSet = {};
  const targets = new Map<string, ToolTarget>();
  let lock = Promise.resolve();
  const seen = new Set<string>();
  for (const provider of await ctx.providers<ToolsApi>("chat.tools")) {
    const plugin = provider.tools.describe[functionName].split("/")[0]!;
    for (const description of await ctx.runQuery(provider.tools.describe, {})) {
      const name = `${plugin}__${description.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      if (Object.hasOwn(tools, name)) throw new Error(`Duplicate model tool name: ${name}`);
      const target = { plugin, toolName: description.name };
      targets.set(name, target);
      tools[name] = dynamicTool({
        description: description.description, inputSchema: jsonSchema(description.parameters),
        toModelOutput: ({ output }) => {
          const out = output as ToolOutput;
          return { type: "text", value: out.model ?? JSON.stringify(out.result) };
        },
        execute: (args, { toolCallId }) => {
          if (seen.has(toolCallId)) throw new Error(`Duplicate tool callId: ${toolCallId}`);
          seen.add(toolCallId);
          const execute = async () => {
            checkToolArgs(args);
            if (!await running()) throw new Error("cancelled");
            if (await acknowledged(toolCallId) !== "running") throw new Error("cancelled");
            await approve?.(toolCallId, target, args as JsonValue);
            if (!await running()) throw new Error("cancelled");
            const out = await ctx.runMutation(provider.tools.invoke, { name: description.name, args: args as JsonValue, threadId });
            return out;
          };
          const result = lock.then(execute);
          lock = result.then(() => {}, () => {});
          return result;
        },
      });
    }
  }
  return { tools, targets };
}
