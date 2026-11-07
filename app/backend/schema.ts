/** Todo's data model is application code; reusable hosts know only SDK data ops. */
import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({
  todos: defineTable({ title: v.string(), done: v.boolean() }),
});
