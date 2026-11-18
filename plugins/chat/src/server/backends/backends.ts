import { functionName, v, type ActionContext } from "@tokamak/sdk";
import { api } from "../_generated/api";
import { action, query, usesMachineLink } from "../_functions";
import type { BackendApi } from "../../shared/backends";
export const list = action({
  handler: listBackends,
});
export async function listBackends(ctx: ActionContext) {
  const remote = await ctx.runQuery(api.machines.agents, {});
  const options = [];
  for (const provider of await ctx.providers<BackendApi>("chat.backend")) {
    const plugin = provider.backend.describe[functionName].split("/")[0]!;
    for (const option of await ctx.use(provider).backend.describe({})) options.push({ ...option, plugin });
  }
  return [...options, ...remote];
}
export const configure = action({
  args: { plugin: v.string(), backendId: v.string(), settings: v.any() },
  handler: async (ctx, args) => {
    const provider = (await ctx.providers<BackendApi>("chat.backend")).find(
      (provider) => provider.backend.turn[functionName].split("/")[0] === args.plugin,
    );
    if (!provider) {
      if (
        (await ctx.runQuery(api.machines.agents, {})).some(
          (a) => a.plugin === args.plugin && a.id === args.backendId,
        )
      )
        return {};
      throw new Error("Your machine is not connected or has no agents.");
    }
    return ctx.use(provider).backend.configure({ backendId: args.backendId, settings: args.settings });
  },
});

export const available = query({
  handler: async (ctx) => ((await usesMachineLink(ctx)) ? ctx.use(api).machines.agents({}) : null),
});
