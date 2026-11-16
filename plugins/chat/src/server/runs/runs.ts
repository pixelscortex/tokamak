import { interruptResponse } from "./run-messages";
import { v } from "@tokamak/sdk";
import { mutation, query } from "../_functions";

export const running = query({
  handler: async (ctx) => {
    const visible = await ctx.db
      .query("runs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
    return visible.map((run) => ({
      runId: run._id,
      threadId: run.threadId,
      waiting: run.waiting ?? false,
    }));
  },
});

export const active = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const { db } = ctx;
    const runs = await db
      .query("runs")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .collect();
    const run = runs.find((run) => run.status === "running");
    if (!run) return null;
    const { token: _token, ...visible } = run;
    return visible;
  },
});

export const cancel = mutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const { db } = ctx;
    const run = await db.get(runId);
    if (!run) return null;
    if (run.status !== "running") return null;

    await interruptResponse(db, run, "cancelled", "cancelled");
    await db.patch(run.threadId, { updatedAt: Date.now() });
    return db.patch(runId, {
      status: "cancelled",
      token: null,
      waiting: false,
      finishedAt: Date.now(),
    });
  },
});

// Three observations span two intervals on the desktop's 30-second timer.
export const observe = mutation({
  args: { sweepId: v.string(), tick: v.number() },
  handler: async ({ db }, { sweepId, tick }) => {
    if (!Number.isSafeInteger(tick) || tick < 0) throw new Error("Invalid sweep tick");
    const runs = await db
      .query("runs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
    for (const run of runs) {
      const previous = run.observations?.find((observation) => observation.sweepId === sweepId);
      if (previous && tick <= previous.tick) continue;
      const heartbeat = run.heartbeat ?? 0;
      const unchanged = previous ? (previous.heartbeat === heartbeat ? previous.unchanged + 1 : 0) : 1;
      if (unchanged < 3) {
        const observations = (run.observations ?? []).filter(
          (observation) => observation.sweepId !== sweepId,
        );
        observations.push({ sweepId, tick, heartbeat, unchanged });
        if (observations.length > 4) {
          const oldest = observations.reduce((a, b) => (a.tick <= b.tick ? a : b));
          observations.splice(observations.indexOf(oldest), 1);
        }
        await db.patch(run._id, { observations });
        continue;
      }
      const now = Date.now();
      await db.patch(run._id, {
        status: "error",
        token: null,
        waiting: false,
        error: "Interrupted",
        finishedAt: now,
      });
      await interruptResponse(db, run, "error", "Interrupted");
      await db.patch(run.threadId, { updatedAt: now });
    }
    return null;
  },
});
