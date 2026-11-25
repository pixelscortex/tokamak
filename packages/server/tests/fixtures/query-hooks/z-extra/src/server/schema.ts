import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({ events: defineTable({ name: v.string() }) });
