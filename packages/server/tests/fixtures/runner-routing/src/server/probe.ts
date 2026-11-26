import { action, mutation, provide, query, v, type JsonValue } from "@tokamak/sdk";
import { identity } from "../contracts";
import { api } from "./_generated/api";

export const provider = provide(identity, {
  current: action({ on: "caller", handler: (ctx) => ctx.auth }),
});

// Exercise caller forwarding through a provider invocation, as well as entry to the local action.
export const identify = action({
  on: "caller",
  handler: (ctx) => identity.get("fixture-runner-routing", ctx).current(),
});

export const rows = query({
  handler: async (ctx) => (await ctx.db.query("lines").collect()).map(({ text }) => text),
});

export const append = mutation({
  args: { text: v.string() },
  handler: (ctx, { text }) => ctx.db.insert("lines", { text }),
});

export const copyLine = action({
  on: "caller",
  handler: async (ctx): Promise<JsonValue[]> => {
    const lines = await ctx.runQuery(api.probe.rows, {});
    await ctx.runMutation(api.probe.append, { text: `Copy of: ${lines.join(", ")}` });
    return lines;
  },
});
