import { functionName, v, type ActionContext } from "@tokamak/sdk";
import { action } from "../_functions";
import type { BackendApi } from "../../shared/backends";
export const list = action({
  handler: listBackends,
});
export async function listBackends(ctx: ActionContext) {
  const options = [];
  for (const provider of await ctx.providers<BackendApi>("chat.backend")) {
    const plugin = provider.backend.describe[functionName].split("/")[0]!;
    for (const option of await ctx.use(provider).backend.describe({})) options.push({ ...option, plugin });
  }
  return options;
}
export const configure = action({
  args: { plugin: v.string(), backendId: v.string(), settings: v.any() },
  handler: async (ctx, args) => {
    const provider = (await ctx.providers<BackendApi>("chat.backend")).find(
      (provider) => provider.backend.turn[functionName].split("/")[0] === args.plugin,
    );
    if (!provider) throw new Error(`Backend plugin unavailable: ${args.plugin}`);
    return ctx.use(provider).backend.configure({ backendId: args.backendId, settings: args.settings });
  },
});
