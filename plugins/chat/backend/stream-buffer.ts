import type {} from "@tokamak/sdk/web";
import type { ActionContext, Id } from "@tokamak/sdk";
import { api } from "./_generated/api";
import { HEARTBEAT_MS } from "./recovery";
import type { ToolPart } from "./parts";

export function streamBuffer(ctx: ActionContext, runId: Id<"runs">) {
  let pending = "";
  let flushedAt = Date.now();

  const update = async (tool?: ToolPart) => {
    const delta = pending;
    const status = await ctx.runMutation(api.send.update, { runId, delta, ...(tool ? { tool } : {}) });
    pending = pending.slice(delta.length);
    flushedAt = Date.now();
    return status;
  };

  let heartbeatAt = flushedAt;

  // Include the initial HTTP request: a quiet provider still owns a live run.
  async function waitFor<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(value => ({ value }));
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        settled,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 100); }),
      ]).finally(() => clearTimeout(timer));

      if (!await ctx.runQuery(api.send.running, { runId })) throw new Error("Run cancelled");
      if (pending && Date.now() - flushedAt >= 100) {
        await update();
        heartbeatAt = flushedAt;
      }
      if (Date.now() - heartbeatAt >= HEARTBEAT_MS) {
        await ctx.runMutation(api.send.update, { runId, delta: "" });
        heartbeatAt = Date.now();
      }
      if (result) return result.value;
    }
  }

  return { update, waitFor, pending: () => pending, append: (text: string) => { pending += text; } };
}
