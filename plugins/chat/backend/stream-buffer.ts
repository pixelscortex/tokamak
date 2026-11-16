import type {} from "@tokamak/sdk/web";
import type { ActionContext, Id, Infer } from "@tokamak/sdk";
import { api } from "./_generated/api";
import { HEARTBEAT_MS } from "./recovery";
import type { planPart, ToolPart } from "./parts";

export function streamBuffer(ctx: ActionContext, runId: Id<"runs">) {
  let pending = "";
  let flushDue = false;
  let heartbeatDue = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(flushTimer);
    clearTimeout(heartbeatTimer);
    flushDue = heartbeatDue = false;
    flushTimer = setTimeout(() => { flushDue = true; }, 100);
    heartbeatTimer = setTimeout(() => { heartbeatDue = true; }, HEARTBEAT_MS);
  };
  schedule();

  const update = async (tool?: ToolPart, plan?: Infer<typeof planPart>) => {
    const delta = pending;
    const status = await ctx.runMutation(api.send.update, { runId, delta, ...(tool ? { tool } : {}), ...(plan ? { plan } : {}) });
    pending = pending.slice(delta.length);
    schedule();
    return status;
  };

  async function maintain() {
    if ((pending && flushDue) || heartbeatDue) await update();
  }

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
      await maintain();
      if (result) return result.value;
    }
  }

  const close = () => { clearTimeout(flushTimer); clearTimeout(heartbeatTimer); };
  return { close, update, waitFor, maintain, pending: () => pending, append: (text: string) => { pending += text; } };
}
