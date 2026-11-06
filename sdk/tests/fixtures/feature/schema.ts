// A real feature schema shared by backend authoring and generated API type tests.
import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({
  tasks: defineTable({
    title: v.string(),
    done: v.boolean(),
    priority: v.number(),
    note: v.optional(v.string()),
  }),
  projects: defineTable({ title: v.string() }),
});
