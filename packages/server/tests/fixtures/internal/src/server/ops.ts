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

export const list = query({
  handler: async (ctx) => (await ctx.runQuery(internal.ops.read, {})).map((row) => row.title),
});

export const add = action({
  args: { title: v.string() },
  handler: async (ctx, args) => {
    const title = await ctx.runAction(internal.ops.format, args);
    if (typeof title !== "string") return title;
    await ctx.runMutation(internal.ops.save, { title });
    return { title };
  },
});

export const addTogether = mutation({
  args: { title: v.string(), abort: v.optional(v.boolean()) },
  handler: async (ctx, { title, abort }) => {
    await ctx.runMutation(internal.ops.save, { title });
    if (abort) throw new Error("Fixture aborted");
    return (await ctx.runQuery(internal.ops.read, {})).map((row) => row.title);
  },
});
