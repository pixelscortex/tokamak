// Same logical table and index names as alpha, with different fields and
// uniqueness. Both plugins must load into one database without colliding.
import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({
  todos: defineTable({ owner: v.string(), text: v.string(), created: v.number() })
    .index("by_owner_created", ["text"])
    .unique("by_owner_text", ["created"]),
});
