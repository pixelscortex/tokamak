import { canSee } from "./access";
import { interruptResponse } from "./run-messages";
import { v, type Caller, type DatabaseReader } from "@tokamak/sdk";
import type { Model } from "./_functions";
import { mutation, query } from "./_functions";

export const running = query({
  guest: true,
  handler: async (ctx) => {
    const { db } = ctx;
    const visible = await visibleRuns(ctx);

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

// Three observations span two intervals on the desktop's 30-second timer.
export const observe = mutation({
  args: { sweepId: v.string(), tick: v.number() },
  handler: async ({ db }, { sweepId, tick }) => {
    if (!Number.isSafeInteger(tick) || tick < 0) throw new Error("Invalid sweep tick");
    const runs = await db.query("runs").withIndex("by_status", q => q.eq("status", "running")).collect();
    for (const run of runs) {
      const previous = run.observation;
      if (previous?.sweepId === sweepId && tick <= previous.tick) continue;
      const heartbeat = run.heartbeat ?? 0;
      const unchanged = previous?.sweepId === sweepId && tick === previous.tick + 1 && previous.heartbeat === heartbeat
        ? previous.unchanged + 1 : 1;
      if (unchanged < 3) {
        await db.patch(run._id, { observation: { sweepId, tick, heartbeat, unchanged } });
        continue;
      }
      const now = Date.now();
      await db.patch(run._id, { status: "error", waiting: false, error: "Interrupted", finishedAt: now });
      await interruptResponse(db, run, "error", "Interrupted");
      await db.patch(run.threadId, { updatedAt: now });
    }
    return null;
  },
});

async function visibleRuns(ctx: { db: DatabaseReader<Model>; caller: Caller }) {
  const runs = await ctx.db.query("runs").withIndex("by_status", q => q.eq("status", "running")).collect();
  const visible = [];
  for (const run of runs) if (await canSee(ctx, run.threadId)) visible.push(run);
  return visible;
}
