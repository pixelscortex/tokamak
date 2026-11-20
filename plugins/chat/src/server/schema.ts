import { defineSchema, defineTable, v } from "@tokamak/sdk";

import { textPart, toolPart, planPart } from "./messages/parts";
import { permissionPart } from "./messages/permission-part";
import { backend } from "./backends/backend";

export default defineSchema({
  threads: defineTable({
    backend: v.optional(backend),
    starterFolder: v.optional(v.string()),
    title: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_updatedAt", ["updatedAt"]),
  openRequests: defineTable({
    userId: v.string(),
    threadId: v.id("threads"),
    shown: v.boolean(),
  }).index("by_userId", ["userId"]),
  messages: defineTable({
    threadId: v.id("threads"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    author: v.optional(v.object({ id: v.string(), name: v.string() })),
    askedBy: v.optional(v.object({ id: v.string(), name: v.string() })),
    parts: v.array(v.union(textPart, toolPart, planPart, permissionPart)),
    status: v.union(
      v.literal("streaming"),
      v.literal("complete"),
      v.literal("error"),
      v.literal("cancelled"),
    ),
    error: v.optional(v.string()),
    // The agent that produced an assistant message, recorded when its run starts so
    // the reply keeps its label after the thread switches agents. Absent on user
    // messages and on rows written before this field existed.
    agent: v.optional(v.object({ plugin: v.string(), backendId: v.string() })),
    createdAt: v.number(),
  }).index("by_threadId_createdAt", ["threadId", "createdAt"]),
  runs: defineTable({
    token: v.optional(v.union(v.string(), v.null())),
    backendPlugin: v.optional(v.string()),
    backendId: v.optional(v.string()),
    owner: v.optional(v.object({ id: v.string(), name: v.string() })),
    requestId: v.optional(v.string()),
    sequence: v.optional(v.number()),
    threadId: v.id("threads"),
    messageId: v.id("messages"),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("error"), v.literal("cancelled")),
    waiting: v.optional(v.boolean()),
    error: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
    heartbeat: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    observations: v.optional(
      v.array(
        v.object({ sweepId: v.string(), tick: v.number(), heartbeat: v.number(), unchanged: v.number() }),
      ),
    ),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_threadId", ["threadId"])
    .index("by_status", ["status"])
    .index("by_status_expiresAt", ["status", "expiresAt"]),
});
