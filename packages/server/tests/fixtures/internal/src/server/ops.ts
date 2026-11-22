import { createFunctions, defineSchema, defineTable, fail, v } from "@tokamak/sdk";
import { internal } from "./_generated/internal";

export const schema = defineSchema({ entries: defineTable({ title: v.string() }) });
const { action, query, mutation, internalQuery, internalMutation, internalAction } = createFunctions(schema);

export const read = internalQuery({
  handler: (ctx) => ctx.db.query("entries").collect(),
});

export const save = internalMutation({
  args: { title: v.string() },
  handler: (ctx, { title }) => ctx.db.insert("entries", { title }),
});

export const format = internalAction({
  args: { title: v.string() },
  handler: (_, { title }) => (title.length > 3 ? fail("TooLong", { max: 3 }) : title.toUpperCase()),
});

export const discard = internalMutation({
  args: { title: v.string() },
  handler: async (ctx, { title }) => {
    await ctx.runMutation(internal.ops.save, { title });
    return fail("Declined", { title });
  },
});

export const list = query({
  handler: async (ctx) => (await ctx.runQuery(internal.ops.read, {})).map((row) => row.title),
});

export const watchEntries = query({
  handler: async (ctx) => ({
    titles: (await ctx.runQuery(internal.ops.read, {})).map((row) => row.title),
    // Make a rerun observable even when it reads the same rows.
    revision: [Math.random(), Math.random()],
  }),
});

export const add = action({
  args: { title: v.string(), decline: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const title = await ctx.runAction(internal.ops.format, { title: args.title });
    if (typeof title !== "string") return title;
    await ctx.runMutation(internal.ops.save, { title });
    if (args.decline) return fail("Declined", { title });
    return { title };
  },
});

export const addTogether = mutation({
  args: { title: v.string(), abort: v.optional(v.boolean()), decline: v.optional(v.boolean()) },
  handler: async (ctx, { title, abort, decline }) => {
    if (decline) {
      await ctx.db.insert("entries", { title });
      return fail("Declined", { title });
    }
    await ctx.runMutation(internal.ops.save, { title });
    if (abort) throw new Error("Fixture aborted");
    return (await ctx.runQuery(internal.ops.read, {})).map((row) => row.title);
  },
});

export const addAroundFailure = mutation({
  args: { recover: v.boolean() },
  handler: async (ctx, { recover }) => {
    await ctx.db.insert("entries", { title: "before" });
    const [result] = await Promise.all([
      ctx.runMutation(internal.ops.discard, { title: "nested discard" }),
      ctx.runMutation(internal.ops.save, { title: "sibling" }),
    ]);
    if (!recover) return result;
    await ctx.db.insert("entries", { title: `after ${result.kind}` });
    return (await ctx.runQuery(internal.ops.read, {})).map((row) => row.title);
  },
});
