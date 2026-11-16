import type { ActionContext, Id } from "@tokamak/sdk";
import { chat as api } from "../server";
const TIMEOUT_MS = 30 * 60_000;
import type { PermissionPart } from "./permission-part";
import type { streamBuffer } from "./stream-buffer";

export function permissionWait(
  ctx: ActionContext,
  runId: Id<"runs">,
  token: string,
  buffer: ReturnType<typeof streamBuffer>,
  respond: (requestId: string, optionId: string | null) => Promise<void>,
) {
  const pending = new Map<string, number>();

  return {
    async request(part: PermissionPart) {
      await buffer.update();
      if (!(await ctx.use(api).permissions.request({ runId, token, part }))) throw new Error("Run cancelled");
      pending.set(part.requestId, Date.now() + TIMEOUT_MS);
    },
    async poll() {
      const state = await ctx.use(api).permissions.state({ runId });
      for (const [requestId, deadline] of pending) {
        const part = state.parts.find((part) => part.requestId === requestId);
        const expired = Date.now() >= deadline;
        if (state.running && part?.status === "pending" && part.optionId === undefined && !expired) continue;
        if (!state.running) {
          pending.delete(requestId);
          await respond(requestId, null);
          continue;
        }
        let outcome;
        try {
          outcome = await ctx.use(api).permissions.claim({ runId, token, requestId, expired });
        } catch (error) {
          if (await ctx.use(api).send.running({ runId })) throw error;
          pending.delete(requestId);
          await respond(requestId, null);
          continue;
        }
        if (!outcome) continue;
        pending.delete(requestId);
        await respond(requestId, outcome.optionId);
      }
      if (!state.running) throw new Error("Run cancelled");
      await buffer.maintain();
    },
  };
}
