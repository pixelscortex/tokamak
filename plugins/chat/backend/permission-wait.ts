import type { ActionContext, Id } from "@tokamak/sdk";
import { api } from "./_generated/api";
import { TIMEOUT_MS } from "./permissions";
import type { PermissionPart } from "./permission-part";
import type { streamBuffer } from "./stream-buffer";

export function permissionWait(ctx: ActionContext, runId: Id<"runs">, buffer: ReturnType<typeof streamBuffer>) {
  const pending = new Map<string, number>();

  // The host drops a request once the turn ends; an answer that arrives later
  // is not an error for the run, only an answer that never took effect.
  async function deliver(requestId: string, optionId: string | null) {
    try {
      await ctx.acp.respond({ requestId, optionId });
    } catch (error) {
      if (!String(error).includes("Unknown ACP permission request")) throw error;
      await ctx.runMutation(api.permissions.undelivered, { runId, requestId });
    }
  }

  return {
    async request(part: PermissionPart) {
      await buffer.update();
      if (!await ctx.runMutation(api.permissions.request, { runId, part })) throw new Error("Run cancelled");
      pending.set(part.requestId, Date.now() + TIMEOUT_MS);
    },
    async poll() {
      const state = await ctx.runQuery(api.permissions.state, { runId });
      for (const [requestId, deadline] of pending) {
        const part = state.parts.find(part => part.requestId === requestId);
        const expired = Date.now() >= deadline;
        if (state.running && part?.status === "pending" && part.optionId === undefined && !expired) continue;
        const outcome = await ctx.runMutation(api.permissions.claim, { runId, requestId, expired });
        if (!outcome) continue;
        pending.delete(requestId);
        await deliver(requestId, outcome.optionId);
      }
      if (!state.running) throw new Error("Run cancelled");
      await buffer.maintain();
    },
  };
}
