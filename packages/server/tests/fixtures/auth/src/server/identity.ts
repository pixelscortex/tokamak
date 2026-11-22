import { action, createApi, mutation, query, type ApiFromModule } from "@tokamak/sdk";

export const read = query({
  handler: (ctx) => ({ auth: ctx.auth }),
});
export const write = mutation({
  handler: (ctx) => ({ auth: ctx.auth }),
});
const api = createApi<{ identity: ApiFromModule<{ read: typeof read; write: typeof write }> }>("auth-test");
export const run = action({
  handler: async (ctx) => ({
    auth: ctx.auth,
    read: await ctx.runQuery(api.identity.read, {}),
    write: await ctx.runMutation(api.identity.write, {}),
  }),
});
