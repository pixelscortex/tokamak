import {
  action,
  createApi,
  functionName,
  mutation,
  query,
  v,
  type StoredDocument,
  type ApiFromModule,
  type FunctionReference,
} from "@tokamak/sdk";
// Include a forged private reference to test the host's capability checks.
const a = createApi<{
  ops: {
    cycle: FunctionReference<"query", {}, null>;
    list: FunctionReference<"query", {}, StoredDocument[]>;
    privateWrite: FunctionReference<"mutation", {}, null>;
  };
}>("a");
export const list = query({ handler: (ctx) => ctx.db.query("items").collect() });
export const add = mutation({
  args: { fail: v.boolean() },
  handler: async (ctx, args) => {
    await ctx.db.insert("items", { source: "b" });
    if (args.fail) throw new Error("child failure");
    return null;
  },
});
export const cycle = query({ handler: async (ctx): Promise<null> => ctx.use(a).ops.cycle({}) });
export const providers = query({ handler: async (ctx) => (await ctx.providers<typeof a>("cycle")).length });
export const denied = mutation({
  args: { provider: v.optional(v.boolean()) },
  handler: async (ctx, { provider }): Promise<null> => {
    await ctx.db.insert("items", { source: "must roll back" });
    const target = provider
      ? (await ctx.providers<typeof a>("cycle")).find(
          (api) => api.ops.privateWrite[functionName] === "a/ops:privateWrite",
        )!
      : a;
    try {
      await ctx.use(target).ops.privateWrite({});
    } catch {
      /* host denial is fatal */
    }
    return null;
  },
});

const self = createApi<{ ops: ApiFromModule<typeof import("./ops")> }>("b");
export const ownPrivate = mutation({
  handler: async (ctx): Promise<null> => ctx.use(self).ops.privateWrite({}),
});
export const privateWrite = mutation({
  handler: async (ctx) => {
    await ctx.db.insert("items", { source: "private b" });
    return null;
  },
});

export const providerList = query({
  handler: async (ctx): Promise<StoredDocument[]> => {
    const provider = (await ctx.providers<typeof a>("cycle")).find(
      (api) => api.ops.list[functionName] === "a/ops:list",
    )!;
    return ctx.use(provider).ops.list({});
  },
});

export const waitForSecondRow = action({
  handler: async (ctx): Promise<string> => {
    await ctx.runMutation(self.ops.add, { fail: false });
    for (;;) {
      if ((await ctx.runQuery(self.ops.list, {})).length >= 2) return "old action finished";
    }
  },
});
