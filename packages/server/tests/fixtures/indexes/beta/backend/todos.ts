// Second plugin for the isolation regression in schema_indexes.rs.
import { createFunctions, v } from "@tokamak/sdk";
import schema from "./schema";

const { query, mutation } = createFunctions(schema);

export const add = mutation({
  args: { owner: v.string(), text: v.string(), created: v.number() },
  handler: (ctx, value) => ctx.db.insert("todos", value),
});
export const byText = query({
  handler: (ctx) => ctx.db.query("todos").withIndex("by_owner_created").collect(),
});
