import { action, createApi, mutation, query, v, type ApiFromModule } from "@tokamak/sdk";
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

const self = createApi<{ ops: ApiFromModule<typeof import("./ops")> }>("a");
export const waitForRemoval = action({
  handler: async (ctx): Promise<never> => {
    await ctx.runMutation(self.ops.privateWrite, {});
    for (;;) await ctx.runQuery(self.ops.list, {});
  },
});
