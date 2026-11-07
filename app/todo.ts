/** Built-in functions take the same validated, transactional SDK path as plugins.
 * Toggle reads and writes in one transaction so two views never own local truth. */
import { createFunctions, v } from "@tokamak/sdk";
import schema from "./schema";

const { query, mutation } = createFunctions(schema);

export const list = query({
  handler: ({ db }) => db.query("todos").collect(),
});

export const add = mutation({
  args: { title: v.string() },
  handler: async ({ db }, { title }) => {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Enter a task title");
    return db.insert("todos", { title: trimmed, done: false });
  },
});

export const toggle = mutation({
  args: { id: v.id("todos") },
  handler: async ({ db }, { id }) => {
    const todo = await db.get(id);
    if (!todo) throw new Error("Task no longer exists");
    return db.patch(id, { done: !todo.done });
  },
});

export const remove = mutation({
  args: { id: v.id("todos") },
  handler: ({ db }, { id }) => db.delete(id),
});
