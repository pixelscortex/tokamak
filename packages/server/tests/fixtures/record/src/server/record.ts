import { createFunctions, v } from "@tokamak/sdk";
import schema from "./schema";
import { createRecord } from "./createRecord";
const { query, mutation } = createFunctions(schema);
export const list = query({ handler: ({ db }) => db.query("records").collect() });
export const add = mutation({
  args: { title: v.string() },
  handler: ({ db }, { title }) => createRecord(db, title),
});
export const get = query({ args: { id: v.id("records") }, handler: ({ db }, { id }) => db.get(id) });
export const toggle = mutation({
  args: { id: v.id("records") },
  handler: async ({ db }, { id }) => db.patch(id, { done: !(await db.get(id))!.done }),
});
export const remove = mutation({ args: { id: v.id("records") }, handler: ({ db }, { id }) => db.delete(id) });
