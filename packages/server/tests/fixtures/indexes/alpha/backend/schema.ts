// Base schema for the schema_indexes.rs regressions. The tests derive changed
// generations by replacing exact lines of this file in a private build copy,
// so keep each declaration on its own line.
import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({
  todos: defineTable({ owner: v.string(), text: v.string(), done: v.boolean(), created: v.number() })
    .index("by_owner_created", ["owner", "created"])
    .unique("by_owner_text", ["owner", "text"]),
  notes: defineTable({ topic: v.string(), body: v.string() })
    .index("by_topic", ["topic"]),
});
