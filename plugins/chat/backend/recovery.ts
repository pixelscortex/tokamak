import { interruptResponse } from "./run-messages";
import type { DatabaseWriter, Doc } from "@tokamak/sdk";
import type { Model } from "./_functions";

export const STALE_AFTER_MS = 60_000;
export const HEARTBEAT_MS = 10_000;

export async function interruptStale(db: DatabaseWriter<Model>, runs: Doc<Model, "runs">[]) {
  const now = Date.now();
  for (const run of runs) {
    if (run.status !== "running" || now - (run.updatedAt ?? run.startedAt) < STALE_AFTER_MS) continue;

    await db.patch(run._id, { status: "error", error: "Interrupted", finishedAt: now });
    await interruptResponse(db, run, "error", "Interrupted");
    await db.patch(run.threadId, { updatedAt: now });
  }
}
