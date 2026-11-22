import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({
  membershipEvents: defineTable({ member: v.string(), event: v.string() }).index("by_member", ["member"]),
});
