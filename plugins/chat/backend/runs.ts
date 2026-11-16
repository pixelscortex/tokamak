import { canSee } from "./access";
import { interruptResponse } from "./run-messages";
import { interruptStale } from "./recovery";
import { v } from "@tokamak/sdk";
import { mutation, query } from "./_functions";

export const running = query({
  guest: true,
  handler: async (ctx) => {
    const { db } = ctx;
    const runs = await db.query("runs").withIndex("by_status", q => q.eq("status", "running")).collect();
    const visible = [];
    for (const run of runs) if (await canSee(ctx, run.threadId)) visible.push(run);

    // Starter names let every viewer label the busy strip without members:list.
    const names = new Map<string, string>();
    for (const run of visible) {
      if (names.has(run.startedBy)) continue;
      const member = await db.query("members").withIndex("by_member", q => q.eq("memberId", run.startedBy)).first();
      names.set(run.startedBy, member?.name ?? (run.startedBy === "owner" ? "Owner" : "Guest"));
    }

    return visible.map(run => ({
      runId: run._id, threadId: run.threadId, model: run.model, waiting: run.waiting ?? false,
      startedBy: run.startedBy, starterName: names.get(run.startedBy)!,
    }));
  },
});

export const active = query({
  guest: true,
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    if (!await canSee(ctx, threadId)) return null;
    const { db } = ctx;
    const runs = await db.query("runs").withIndex("by_threadId", q => q.eq("threadId", threadId)).collect();
    return runs.find(run => run.status === "running") ?? null;
  },
});

export const cancel = mutation({
  guest: true,
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const { db, caller } = ctx;
    const run = await db.get(runId);
    if (!run) return null;
    if (!await canSee(ctx, run.threadId) || (caller.role !== "owner" && run.startedBy !== caller.memberId)) throw new Error("Only the run starter or owner can cancel");
    if (run.status !== "running") return null;

    await interruptResponse(db, run, "cancelled", "cancelled");
    await db.patch(run.threadId, { updatedAt: Date.now() });
    return db.patch(runId, { status: "cancelled", waiting: false, cancelledBy: caller.memberId, finishedAt: Date.now() });
  },
});

// Queries stay read-only; clients sweep when observing running runs.
export const recover = mutation({
  guest: true,
  handler: async (ctx) => {
    const { db } = ctx;
    const runs = await db.query("runs").withIndex("by_status", q => q.eq("status", "running")).collect();
    const visible = [];
    for (const run of runs) if (await canSee(ctx, run.threadId)) visible.push(run);
    await interruptStale(db, visible);
    return null;
  },
});
