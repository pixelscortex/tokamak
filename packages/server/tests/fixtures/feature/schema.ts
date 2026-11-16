// Startup metadata comes from the same schema the real SDK bundler exports.
import { defineSchema, defineTable, v } from "@tokamak/sdk";
export default defineSchema({ items: defineTable({ value: v.any() }) });
