import { createApi, mutation, query, v, type ApiFromModule } from "@tokamak/sdk";
const a = createApi<{ ops: ApiFromModule<typeof import("../../a/backend/ops")> }>("a");
export const list = query({ handler: ctx => ctx.db.query("items").collect() });
export const add = mutation({
  args: { fail: v.boolean() },
  handler: async (ctx, args) => {
    await ctx.db.insert("items", { source: "b" });
    if (args.fail) throw new Error("child failure");
    return null;
  },
});
export const cycle = query({ handler: async (ctx): Promise<null> => ctx.use(a).ops.cycle({}) });
export const providers = query({ handler: async ctx =>
  (await ctx.providers<typeof a>("cycle")).length,
});
export const denied = mutation({ handler: async (ctx): Promise<null> => {
  await ctx.db.insert("items", { source: "must roll back" });
  try { await ctx.use(a).ops.both({ fail: false }); } catch { /* host denial is fatal */ }
  return null;
} });
