import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({ threads: defineTable({ title: v.string() }) });
