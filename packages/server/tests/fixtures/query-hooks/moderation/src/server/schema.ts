import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({
  bans: defineTable({ name: v.string() }),
  benchWrites: defineTable({ name: v.string() }),
});
