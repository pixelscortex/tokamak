import { v } from "@tokamak/sdk";
import { OWNER, mutation, query } from "./_functions";

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

    await db.patch(run.messageId, { status: "cancelled" });
    await db.patch(run.threadId, { updatedAt: Date.now() });
    return db.patch(runId, { status: "cancelled", cancelledBy: OWNER, finishedAt: Date.now() });
  },
});
