import { defineSchema, defineTable, v } from "@tokamak/sdk";

export default defineSchema({
  threads: defineTable({
    ownerId: v.string(), title: v.string(), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_updatedAt", ["updatedAt"]),
  messages: defineTable({
    threadId: v.id("threads"),
    authorId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    parts: v.array(v.object({ type: v.literal("text"), text: v.string() })),
    status: v.union(v.literal("streaming"), v.literal("complete"), v.literal("error"), v.literal("cancelled")),
    error: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_threadId_createdAt", ["threadId", "createdAt"]),
  runs: defineTable({
    threadId: v.id("threads"), messageId: v.id("messages"),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("error"), v.literal("cancelled")),
    startedBy: v.string(), cancelledBy: v.optional(v.string()),
    model: v.string(), startedAt: v.number(), finishedAt: v.optional(v.number()),
  }).index("by_threadId", ["threadId"]).index("by_status", ["status"]),
});
