import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({ lines: defineTable({ text: v.string() }) });
