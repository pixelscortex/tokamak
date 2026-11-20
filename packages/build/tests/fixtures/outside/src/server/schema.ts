import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({ notes: defineTable({ text: v.string() }) });
