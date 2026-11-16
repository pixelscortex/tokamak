import type {} from "@tokamak/sdk/web";
import { v, type ActionContext, type MutationContext, type Id } from "@tokamak/sdk";
import { api } from "./_generated/api";
import { mutation, query, type Model } from "./_functions";
import { canSee } from "./access";
import { interruptResponse } from "./run-messages";

export const STALE_AFTER_MS = 60_000;
export const HEARTBEAT_MS = 10_000;

export const snapshot = query({
  args: { threadId: v.optional(v.id("threads")) },
  handler: async (ctx, { threadId }) => {
    const runs = await ctx.db.query("runs").withIndex("by_status", q => q.eq("status", "running")).collect();
    const visible = [];
    for (const run of runs) {
      if ((!threadId || run.threadId === threadId) && await canSee(ctx, run.threadId))
        visible.push({ runId: run._id, heartbeat: run.heartbeat ?? 0 });
    }
    return visible;
  },
});

export const interrupt = mutation({
  args: { observed: v.array(v.object({ runId: v.id("runs"), heartbeat: v.number() })) },
  handler: (ctx, { observed }) => interruptObserved(ctx, observed),
});

export async function interruptObserved(ctx: MutationContext<Model>, observed: { runId: Id<"runs">; heartbeat: number }[]) {
  const { db } = ctx;
  for (const { runId, heartbeat } of observed) {
    const run = await db.get(runId);
    if (!run || run.status !== "running" || (run.heartbeat ?? 0) !== heartbeat || !await canSee(ctx, run.threadId)) continue;
    const now = Date.now();
    await db.patch(runId, { status: "error", waiting: false, error: "Interrupted", finishedAt: now });
    await interruptResponse(db, run, "error", "Interrupted");
    await db.patch(run.threadId, { updatedAt: now });
  }
  return null;
}

export async function recoverRuns(ctx: ActionContext, threadId?: Id<"threads">): Promise<null> {
  const observed = await ctx.runQuery(api.recovery.snapshot, threadId ? { threadId } : {});
  if (!observed.length) return null;
  // Timers measure elapsed time independently of wall-clock jumps.
  // An unchanged heartbeat counter also detects actions lost on restart.
  await new Promise<void>(resolve => setTimeout(resolve, STALE_AFTER_MS));
  return ctx.runMutation(api.recovery.interrupt, { observed });
}
