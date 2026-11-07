// Headless milestone example: ordinary SDK feature code, not server-side
// application special cases. The same bundle can be supplied to Backend in-process.
import { mutation, query, v } from "@tokamak/sdk";

export const list = query({
  handler: ({ db }) => db.query("todos").collect(),
});

export const add = mutation({
  args: { text: v.string() },
  handler: ({ db }, { text }) => db.insert("todos", { text, done: false }),
});
