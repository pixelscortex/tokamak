import { v } from "@tokamak/sdk";
import { mutation, query } from "./_functions";
import { claimPermission, permissionPart } from "./permission-part";

// Generic backend permission lifecycle; answer is exposed to the desktop.
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
  args: { runId: v.id("runs") },
  handler: async ({ db }, { runId }) => {
    const run = await db.get(runId);
    const message = run && (await db.get(run.messageId));
    return {
      running: run?.status === "running",
      parts: message?.parts.filter((part) => part.type === "permission") ?? [],
    };
  },
});

export const answer = mutation({
  args: { messageId: v.id("messages"), requestId: v.string(), optionId: v.string() },
  handler: async ({ db }, { messageId, requestId, optionId }) => {
    const message = await db.get(messageId);
    if (!message) throw new Error("Permission no longer exists");
    const runs = await db
      .query("runs")
      .withIndex("by_threadId", (q) => q.eq("threadId", message.threadId))
      .collect();
    const run = runs.find((run) => run.messageId === messageId && run.status === "running");
    if (!run) throw new Error("Run is no longer active");
    const part = message.parts.find((part) => part.type === "permission" && part.requestId === requestId);
    if (part?.type !== "permission" || part.status !== "pending")
      throw new Error("Permission is no longer pending");
    if (!part.options.some((option) => option.optionId === optionId))
      throw new Error("Unknown permission option");
    // Reserve the answer atomically; the action claims it before responding.
    if (part.optionId !== undefined) throw new Error("Permission already answered");
    part.optionId = optionId;
    await db.patch(messageId, { parts: message.parts });
    return null;
  },
});

// Atomically arbitrate answer delivery against timeout and run cancellation.
export const claim = mutation({
  args: { runId: v.id("runs"), requestId: v.string(), expired: v.boolean() },
  handler: async ({ db }, { runId, requestId, expired }) => {
    const run = await db.get(runId);
    if (!run) return null;
    const message = await db.get(run.messageId);
    const part = message?.parts.find((part) => part.type === "permission" && part.requestId === requestId);
    if (part?.type !== "permission") return null;
    if (part.status === "pending") {
      if (run.status === "running" && part.optionId === undefined && !expired) return null;
      claimPermission(
        part,
        run.status !== "running" ? "cancelled" : part.optionId !== undefined ? "answered" : "expired",
      );
      await db.patch(message!._id, { parts: message!.parts });
      await db.patch(runId, {
        waiting: message!.parts.some((part) => part.type === "permission" && part.status === "pending"),
      });
    }
    return { status: part.status, optionId: part.status === "answered" ? part.optionId! : null };
  },
});

// The agent ended the turn before an answer reached it: the host already
// answered the request "cancelled", so the stored answer never took effect.
export const undelivered = mutation({
  args: { runId: v.id("runs"), requestId: v.string() },
  handler: async ({ db }, { runId, requestId }) => {
    const run = await db.get(runId);
    const message = run && (await db.get(run.messageId));
    const part = message?.parts.find((part) => part.type === "permission" && part.requestId === requestId);
    if (part?.type !== "permission" || part.status !== "answered") return null;

    part.status = "expired";
    await db.patch(message!._id, { parts: message!.parts });
    return null;
  },
});
