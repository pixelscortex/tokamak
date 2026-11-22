import { createApi, type FunctionReference, mutation, query, v } from "@tokamak/sdk";
import { api as b } from "plugin:b/server";
export const list = query({ handler: (ctx) => ctx.db.query("items").collect() });
export const both = mutation({
  args: { fail: v.boolean() },
  handler: async (ctx, args) => {
    await ctx.db.insert("items", { source: "a" });
    try {
      await ctx.use(b).add(args);
    } catch {
      /* native failure still aborts */
    }
    return null;
  },
});
export const combined = query({
  handler: async (ctx) => ({
    a: await ctx.db.query("items").collect(),
    b: await ctx.use(b).list({}),
  }),
});
export const illegal = query({
  handler: async (ctx) => {
    // @ts-expect-error A query's typed plugin context must not expose mutations.
    return ctx.use(b).add({ fail: false });
  },
});
export const cycle = query({ handler: async (ctx): Promise<null> => ctx.use(b).cycle({}) });

// Private writes must remain available to clients and the owning plugin only.
export const privateWrite = mutation({
  handler: async (ctx) => {
    await ctx.db.insert("items", { source: "private a" });
    return null;
  },
});

const forged = createApi<{ ops: { privateWrite: FunctionReference<"mutation", {}, null> } }>("b");
export const denied = mutation({
  handler: async (ctx) => {
    await ctx.db.insert("items", { source: "must roll back" });
    try {
      await ctx.use(forged).ops.privateWrite({});
    } catch {
      // A host denial still aborts the transaction.
    }
    return null;
  },
});
