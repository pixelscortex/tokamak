import { createApi, mutation, query, v, type ApiFromModule } from "@tokamak/sdk";
const b = createApi<{ ops: ApiFromModule<typeof import("../../b/backend/ops")> }>("b");
export const list = query({ handler: (ctx) => ctx.db.query("items").collect() });
export const both = mutation({
  args: { fail: v.boolean() },
  handler: async (ctx, args) => {
    await ctx.db.insert("items", { source: "a" });
    try {
      await ctx.use(b).ops.add(args);
    } catch {
      /* native failure still aborts */
    }
    return null;
  },
});
export const combined = query({
  handler: async (ctx) => ({
    a: await ctx.db.query("items").collect(),
    b: await ctx.use(b).ops.list({}),
  }),
});
export const illegal = query({
  handler: async (ctx) => {
    // @ts-expect-error A query's typed plugin context must not expose mutations.
    return ctx.use(b).ops.add({ fail: false });
  },
});
export const cycle = query({ handler: async (ctx): Promise<null> => ctx.use(b).ops.cycle({}) });

// Private writes must remain available to clients and the owning plugin only.
export const privateWrite = mutation({
  handler: async (ctx) => {
    await ctx.db.insert("items", { source: "private a" });
    return null;
  },
});
