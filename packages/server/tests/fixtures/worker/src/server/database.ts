import { mutation, query, v } from "@tokamak/sdk";
export const insert = mutation({
  args: { value: v.string() },
  handler: ({ db }, { value }) => db.insert("items", { value }),
});
export const get = query({ args: { id: v.id("items") }, handler: ({ db }, { id }) => db.get(id) });
