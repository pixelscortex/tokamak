/** Built-in functions take the same validated, transactional SDK path as plugins.
 * Toggle reads and writes in one transaction so two views never own local truth. */
import { createFunctions, v } from "@tokamak/sdk";
import { assertReadable } from "./_limits";
import { createTodo } from "./createTodo";
import schema from "./schema";

const { query, mutation } = createFunctions(schema);

export const list = query({
  handler: async ({ db }) => {
    const todos = await db.query("todos").collect();
    assertReadable(todos);
    return todos;
  },
});

export const add = mutation({
  args: { title: v.string() },
  handler: ({ db }, { title }) => createTodo(db, title),
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

export const get = query({
  args: { id: v.id("todos") },
  handler: ({ db }, { id }) => db.get(id),
});
