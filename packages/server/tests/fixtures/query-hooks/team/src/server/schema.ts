import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({ users: defineTable({ name: v.string() }) });
