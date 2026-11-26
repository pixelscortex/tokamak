import { directory } from "../contracts";
import { createFunctions, v } from "@tokamak/sdk";
import schema from "./schema";
import { api } from "./_generated/api";
import { internal } from "./_generated/internal";

const functions = createFunctions(schema);
const { query, mutation } = functions;

export const list = query({
  args: { text: v.string(), mode: v.optional(v.string()), thread: v.optional(v.id("threads")) },
  async handler(ctx, { text, mode }) {
    if (mode === "blocked") throw new Error("TARGET HANDLER RAN");
    return (await ctx.db.query("users").collect())
      .filter((user) => user.name.includes(text))
      .map(({ name }) => ({ name, detail: "" }));
  },
});

export const add = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) => ctx.db.insert("users", { name }),
});

type Profile = {
  title?: string;
  alias: string | null;
  status: "active" | "pending";
  labels: string[];
  extras: Record<string, unknown>;
  location: [string, number?, ...boolean[]];
};

export const profile = query({
  args: { mode: v.string() },
  handler: (): Profile => ({ alias: null, status: "pending", labels: [], extras: {}, location: ["old"] }),
});

export const explicit = query({
  returns: v.object({ status: v.union(v.literal("active"), v.literal("pending")) }),
  handler: () => ({ status: "pending" }),
});

export const rows = query({
  handler: async (ctx): Promise<{ name: string }[]> => ctx.db.query("users").collect(),
});

export const ping = query({ handler: () => null });

export const viaContract = query({
  async handler(ctx): Promise<{ name: string; detail: string }[]> {
    const [provider] = await directory.list(ctx);
    return provider.list({ text: " Ali " });
  },
});

export const guarded = mutation({
  args: { name: v.string(), mode: v.optional(v.string()) },
  returns: v.string(),
  async handler({ db }, { name, mode }) {
    await db.insert("users", { name });
    if (mode === "owner-fails") throw new Error("owner failed");
    return name;
  },
});

export const saveHidden = functions.internalMutation({
  args: { name: v.string() },
  handler: ({ db }, { name }) => db.insert("users", { name }),
});

export const useHidden = mutation({
  args: { name: v.string() },
  handler: (ctx, args) => ctx.runMutation(internal.users.saveHidden, args),
});

export const catchGuarded = mutation({
  async handler(ctx) {
    try {
      await ctx.runMutation(api.users.guarded, { name: "hidden-error", mode: "after-fails" });
    } catch {
      await ctx.db.insert("users", { name: "caught" });
    }
    return null;
  },
});

export const catchQueryHook = mutation({
  async handler(ctx) {
    try {
      await ctx.runQuery(api.users.list, { text: "", mode: "blocked" });
    } catch {
      await ctx.db.insert("users", { name: "query-fallback" });
    }
    return null;
  },
});
