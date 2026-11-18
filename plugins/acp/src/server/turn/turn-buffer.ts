import { chatPort, type TurnContext } from "./chat-port";
// ACP owns pending bytes and timers; every chat write goes through the host.
import type { Id, ArgsOf } from "@tokamak/sdk";
import { api } from "plugin:chat/server";
import type { ToolPart } from "plugin:chat/server";
type Plan = NonNullable<ArgsOf<typeof api.updateRun>["plan"]>;

const HEARTBEAT_MS = 10_000;

export function turnBuffer(ctx: TurnContext, runId: Id<"runs">, token: string) {
  let pending = "";
  let flushDue = false;
  let heartbeatDue = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(flushTimer);
    clearTimeout(heartbeatTimer);
    flushDue = heartbeatDue = false;
    flushTimer = setTimeout(() => {
      flushDue = true;
    }, 100);
    heartbeatTimer = setTimeout(() => {
      heartbeatDue = true;
    }, HEARTBEAT_MS);
  };
  schedule();

  const update = async (tool?: ToolPart, plan?: Plan) => {
    const delta = pending;
    const status = await chatPort(ctx).updateRun({
      runId,
      token,
      delta,
      upsertTools: true,
      ...(tool ? { tool } : {}),
      ...(plan ? { plan } : {}),
    });
    pending = pending.slice(delta.length);
    schedule();
    return status;
  };

  async function maintain() {
    if ((pending && flushDue) || heartbeatDue) await update();
  }

  // Include the initial HTTP request: a quiet provider still owns a live run.
  async function waitFor<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then((value) => ({ value }));
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        settled,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 100);
        }),
      ]).finally(() => clearTimeout(timer));

      if (!(await chatPort(ctx).runIsRunning({ runId }))) throw new Error("Run cancelled");
      await maintain();
      if (result) return result.value;
    }
  }

  const close = () => {
    clearTimeout(flushTimer);
    clearTimeout(heartbeatTimer);
  };
  return {
    close,
    update,
    waitFor,
    maintain,
    pending: () => pending,
    append: (text: string) => {
      pending += text;
    },
  };
}
