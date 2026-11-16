import type {} from "@tokamak/sdk/web";
import type { ActionContext, Id } from "@tokamak/sdk";
import { api } from "./_generated/api";
import { TIMEOUT_MS } from "./permissions";
import type { PermissionPart } from "./permission-part";
import type { streamBuffer } from "./stream-buffer";

export async function waitForPermission(ctx: ActionContext, runId: Id<"runs">, messageId: Id<"messages">,
  part: PermissionPart, buffer: ReturnType<typeof streamBuffer>) {
  await buffer.update();
  const active = await ctx.runMutation(api.permissions.request, { runId, part });
  let status: "answered" | "expired" | "cancelled" = "cancelled";
  let optionId: string | null = null;
  try {
    const deadline = Date.now() + TIMEOUT_MS;
    while (active) {
      // waitFor supplies cancellation polling and heartbeats during quiet waits.
      const current = await buffer.waitFor(ctx.runQuery(api.permissions.state, { messageId, requestId: part.requestId }));
      if (current?.type !== "permission" || current.status !== "pending") break;
      if (current.optionId !== undefined) {
        optionId = current.optionId;
        status = "answered";
        break;
      }
      if (Date.now() >= deadline) {
        optionId = await ctx.runMutation(api.permissions.expire, { runId, requestId: part.requestId });
        status = optionId === null ? "expired" : "answered";
        break;
      }
      await buffer.waitFor(new Promise<void>(resolve => setTimeout(resolve, 100)));
    }
  } finally {
    try { await ctx.acp.respond({ requestId: part.requestId, optionId }); }
    catch (cause) {
      if (status === "answered") status = "expired";
      throw cause;
    } finally { await ctx.runMutation(api.permissions.settle, { runId, requestId: part.requestId, status }); }
  }
}
