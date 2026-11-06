// Nontrivial feature exercises typed CRUD and reusable, immutable query plans.
import { createFunctions, v } from "@tokamak/sdk";
import schema from "./schema";
import { normalizeTitle } from "./_helpers/title";

const { query, mutation } = createFunctions(schema);

export const add = mutation({
  args: { title: v.string(), priority: v.number(), note: v.optional(v.string()) },
  handler: (ctx, args) =>
    ctx.db.insert("tasks", {
      title: normalizeTitle(args.title),
      done: false,
      priority: args.priority,
      ...(args.note === undefined ? {} : { note: args.note }),
    }),
});

export const edit = mutation({
  args: { id: v.id("tasks"), done: v.boolean() },
  handler: (ctx, { id, done }) => ctx.db.patch(id, { done }),
});

export const replace = mutation({
  args: { id: v.id("tasks"), title: v.string() },
  handler: (ctx, { id, title }) => ctx.db.replace(id, { title, done: false, priority: 0 }),
});

export const remove = mutation({
  args: { id: v.id("tasks") },
  handler: (ctx, { id }) => ctx.db.delete(id),
});

export const get = query({ args: { id: v.id("tasks") }, handler: (ctx, { id }) => ctx.db.get(id) });

export const search = query({
  args: { done: v.boolean(), priority: v.number() },
  handler: async (ctx, { done, priority }) => {
    const base = ctx.db.query("tasks").where("done", "=", done);
    const narrow = base.where("priority", "=", priority).order("desc");
    return {
      recent: await narrow.take(2),
      first: await narrow.first(),
      all: await base.collect(),
      earliest: await base.order("asc").first(),
      empty: await base.take(0),
    };
  },
});

export const noResult = mutation({ handler: async () => {} });

export const constant = 17;
