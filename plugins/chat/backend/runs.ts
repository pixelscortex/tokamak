import { interruptStale } from "./recovery";
import { v } from "@tokamak/sdk";
import { OWNER, mutation, query } from "./_functions";

export const running = query({
  handler: async ({ db }) => {
    const runs = await db.query("runs").withIndex("by_status", q => q.eq("status", "running")).collect();
    return runs.map(run => ({ runId: run._id, threadId: run.threadId, model: run.model }));
  },
});

export const active = query({
  args: { threadId: v.id("threads") },
  handler: async ({ db }, { threadId }) => {
    const runs = await db.query("runs").withIndex("by_threadId", q => q.eq("threadId", threadId)).collect();
    return runs.find(run => run.status === "running") ?? null;
  },
});

export const cancel = mutation({
  args: { runId: v.id("runs") },
  handler: async ({ db }, { runId }) => {
    const run = await db.get(runId);
    if (!run || run.status !== "running") return null;

    const message = await db.get(run.messageId);
    if (message) await db.patch(run.messageId, {
      status: "cancelled",
      parts: message.parts.map(part => part.type === "tool" && part.status === "running"
        ? { ...part, status: "error" as const, error: "cancelled" } : part),
    });
    await db.patch(run.threadId, { updatedAt: Date.now() });
    return db.patch(runId, { status: "cancelled", cancelledBy: OWNER, finishedAt: Date.now() });
  },
});

// Queries stay read-only; clients sweep when observing running runs.
export const recover = mutation({
  handler: async ({ db }) => {
    const runs = await db.query("runs").withIndex("by_status", q => q.eq("status", "running")).collect();
    await interruptStale(db, runs);
    return null;
  },
});
