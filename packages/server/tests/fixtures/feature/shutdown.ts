// TKM7 shutdown regression: an awaited write remains uncommitted while real
// synchronous JS occupies the worker. Shutdown must drain it, not abort storage.
import { mutation, v } from "@tokamak/sdk";

export const slowInsert = mutation({
  args: { iterations: v.number(), dryRun: v.optional(v.boolean()) },
  handler: async ({ db }, { iterations, dryRun }) => {
    const id = dryRun ? null : await db.insert("items", { value: "accepted before shutdown" });
    // The driver calibrates finite work with its live clock; backend time is
    // frozen, so a clock-based busy wait would never finish during replay.
    let work = 0;
    for (let i = 0; i < iterations; i++) work = (Math.imul(work ^ i, 1664525) + 1013904223) | 0;
    return dryRun ? work : id;
  },
});
