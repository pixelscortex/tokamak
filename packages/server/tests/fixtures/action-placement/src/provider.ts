import { action, internalAction, local, provide, v } from "@tokamak/sdk";
import { api } from "./_generated/api";
import { localPlace, place } from "./contracts";

export const provider = provide(place, {
  location: internalAction({
    on: "caller",
    handler: (ctx) => ({ runner: ctx.retiring !== undefined, depth: ctx.call.depth }),
  }),
});

export const contractCall = action({
  handler: (ctx) => place.get("ai", ctx).location(),
});

export const localProvider = provide(localPlace, {
  id: "fixture",
  location: local({ handler: (ctx) => ctx.call.depth }),
});

export const callLocalContract = action({
  on: "caller",
  handler: (ctx) => localPlace.get("fixture", ctx).location(),
});

export const callServerContract = action({
  on: "caller",
  handler: (ctx) => place.get("ai", ctx).location(),
});

export const refreshedProvider = action({
  on: "caller",
  args: { gate: v.string() },
  handler: async (ctx, { gate }) => {
    const before = await localPlace.get("external", ctx).location();
    await ctx.runMutation(api.work.store, { text: gate + ":ready" });
    for (;;) {
      const { rows } = await ctx.runQuery(api.work.rows, {});
      if (rows.some((row) => row.text === gate)) break;
    }
    return [before, await localPlace.get("external", ctx).location()];
  },
});
