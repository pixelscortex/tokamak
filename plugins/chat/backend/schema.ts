import { defineSchema, defineTable, v } from "@tokamak/sdk";

import { textPart, toolPart, planPart } from "./parts";
import { permissionPart } from "./permission-part";
import { backend } from "./backend";

export default defineSchema({
  threads: defineTable({
    model: v.optional(v.string()), backend: v.optional(backend),
    ownerId: v.string(), title: v.string(), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_updatedAt", ["updatedAt"]),
  messages: defineTable({
    threadId: v.id("threads"),
    authorId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    parts: v.array(v.union(textPart, toolPart, planPart, permissionPart)),
    status: v.union(v.literal("streaming"), v.literal("complete"), v.literal("error"), v.literal("cancelled")),
    error: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_threadId_createdAt", ["threadId", "createdAt"]),
  runs: defineTable({
    threadId: v.id("threads"), messageId: v.id("messages"),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("error"), v.literal("cancelled")),
    waiting: v.optional(v.boolean()), startedBy: v.string(), cancelledBy: v.optional(v.string()),
    error: v.optional(v.string()), updatedAt: v.optional(v.number()),
    model: v.string(), startedAt: v.number(), finishedAt: v.optional(v.number()),
  }).index("by_threadId", ["threadId"]).index("by_status", ["status"]),
});
