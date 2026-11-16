import { defineSchema, defineTable, v } from "@tokamak/sdk";
export default defineSchema({ records: defineTable({ title: v.string(), done: v.boolean() }) });
