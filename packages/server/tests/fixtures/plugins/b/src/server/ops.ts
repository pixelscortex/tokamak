import { createApi, mutation, query, v, type ApiFromModule } from "@tokamak/sdk";
export const list = query({ handler: (ctx) => ctx.db.query("items").collect() });
export const add = mutation({
  args: { fail: v.boolean() },
  handler: async (ctx, args) => {
    await ctx.db.insert("items", { source: "b" });
    if (args.fail) throw new Error("child failure");
    return null;
  },
});
const self = createApi<{ ops: ApiFromModule<typeof import("./ops")> }>("b");
// Still exercises the runtime call-cycle guard without a dependency cycle.
export const cycle = query({ handler: async (ctx): Promise<null> => ctx.use(self).ops.cycle({}) });
export const ownPrivate = mutation({
  handler: async (ctx): Promise<null> => ctx.use(self).ops.privateWrite({}),
});
export const privateWrite = mutation({
  handler: async (ctx) => {
    await ctx.db.insert("items", { source: "private b" });
    return null;
  },
});
