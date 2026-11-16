import { v } from "@tokamak/sdk";
import { OWNER, mutation, query } from "./_functions";
import { permissionPart } from "./permission-part";

export const TIMEOUT_MS = 30 * 60_000;

// Internal steps; only answer is exposed to the desktop, none to other plugins.
export const request = mutation({
  args: { runId: v.id("runs"), part: permissionPart },
  handler: async ({ db }, { runId, part }) => {
    const run = await db.get(runId);
    if (!run || run.status !== "running") return false;
    const message = await db.get(run.messageId);
    if (!message) return false;
    await db.patch(message._id, { parts: [...message.parts, part] });
    await db.patch(runId, { waiting: true, updatedAt: Date.now() });
    return true;
  },
});

export const state = query({
  args: { messageId: v.id("messages"), requestId: v.string() },
  handler: async ({ db }, { messageId, requestId }) =>
    (await db.get(messageId))?.parts.find(part => part.type === "permission" && part.requestId === requestId) ?? null,
});

export const answer = mutation({
  args: { messageId: v.id("messages"), requestId: v.string(), optionId: v.string() },
  handler: async ({ db }, { messageId, requestId, optionId }) => {
    const message = await db.get(messageId);
    if (!message) throw new Error("Permission no longer exists");
    const runs = await db.query("runs").withIndex("by_threadId", q => q.eq("threadId", message.threadId)).collect();
    const run = runs.find(run => run.messageId === messageId && run.status === "running");
    const thread = await db.get(message.threadId);
    if (!run || (run.startedBy !== OWNER && thread?.ownerId !== OWNER)) throw new Error("Only the run starter or thread owner can answer");
    const part = message.parts.find(part => part.type === "permission" && part.requestId === requestId);
    if (part?.type !== "permission" || part.status !== "pending") throw new Error("Permission is no longer pending");
    if (!part.options.some(option => option.optionId === optionId)) throw new Error("Unknown permission option");
    // Reserve the answer atomically; the action marks it answered after responding.
    if (part.optionId !== undefined) throw new Error("Permission already answered");
    part.optionId = optionId;
    part.answeredBy = OWNER;
    await db.patch(messageId, { parts: message.parts });
    return null;
  },
});

// Close the timeout race with answer: an already reserved option wins.
export const expire = mutation({
  args: { runId: v.id("runs"), requestId: v.string() },
  handler: async ({ db }, { runId, requestId }) => {
    const run = await db.get(runId);
    if (!run || run.status !== "running") return null;
    const message = await db.get(run.messageId);
    const part = message?.parts.find(part => part.type === "permission" && part.requestId === requestId);
    if (part?.type !== "permission" || part.status !== "pending") return null;
    if (part.optionId !== undefined) return part.optionId;
    part.status = "expired";
    await db.patch(message!._id, { parts: message!.parts });
    await db.patch(runId, { waiting: false });
    return null;
  },
});

export const settle = mutation({
  args: { runId: v.id("runs"), requestId: v.string(), status: v.union(v.literal("answered"), v.literal("expired"), v.literal("cancelled")) },
  handler: async ({ db }, { runId, requestId, status }) => {
    const run = await db.get(runId);
    if (!run) return null;
    const message = await db.get(run.messageId);
    if (message) await db.patch(message._id, { parts: message.parts.map(part =>
      part.type === "permission" && part.requestId === requestId && part.status === "pending" ? { ...part, status } : part) });
    await db.patch(runId, { waiting: false });
    return null;
  },
});
