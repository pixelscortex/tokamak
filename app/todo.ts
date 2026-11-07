/** Built-in functions take the same validated, transactional SDK path as plugins.
 * Toggle reads and writes in one transaction so two views never own local truth. */
import { createFunctions, v } from "@tokamak/sdk";
import { assertReadable, MAX_TITLE_UNITS } from "./_limits";
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
  handler: async ({ db }, { title }) => {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Enter a task title");
    if (trimmed.length > MAX_TITLE_UNITS) {
      throw new Error(`Task titles must be at most ${MAX_TITLE_UNITS} UTF-16 code units`);
    }
    const id = await db.insert("todos", { title: trimmed, done: false });
    // Check the actual post-insert snapshot, including generated metadata.
    // Throwing rolls back this entire SDK mutation, never a partially saved add.
    // The shared server coordinator serializes handlers across ALL sessions;
    // concurrent adds cannot both approve stale global-budget snapshots here.
    assertReadable(await db.query("todos").collect());
    return id;
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
