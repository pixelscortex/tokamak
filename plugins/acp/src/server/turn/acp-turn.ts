import { agents, type AgentClient } from "../agents/client";
import { chat } from "../../../../chat/src/server/api";
import type { ActionContext, Id } from "@tokamak/sdk";
import { acpEvents } from "../events/acp-events";
import { permissionWait } from "../../../../chat/src/server/api";
import type { streamBuffer } from "../../../../chat/src/server/api";

export async function readAcpTurn(
  ctx: ActionContext,
  agent: string,
  runId: Id<"runs">,
  token: string,
  buffer: ReturnType<typeof streamBuffer>,
  events: ReturnType<AgentClient["prompt"]>,
  client: AgentClient = agents,
) {
  const iterator = events[Symbol.asyncIterator]();
  const update = acpEvents(agent, buffer);
  const permissions = permissionWait(ctx, runId, token, buffer, async (requestId, optionId) => {
    try {
      await client.respond({ requestId, optionId });
    } catch (error) {
      if (!String(error).includes("Unknown ACP permission request")) throw error;
      await ctx.use(chat).permissions.undelivered({ runId, token, requestId });
    }
  });
  let pollAt = Date.now() + 250;

  async function maintain() {
    await buffer.maintain();
    if (Date.now() < pollAt) return;
    await permissions.poll();
    pollAt = Date.now() + 250;
  }

  // Keep exactly one read outstanding while polling all pending permissions.
  let nextEvent = iterator.next();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      nextEvent,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, Math.min(100, pollAt - Date.now())));
      }),
    ]).finally(() => clearTimeout(timer));
    if (!next) {
      await maintain();
      continue;
    }
    if (next.done) throw new Error("Agent ended without a stop reason");
    const event = next.value;
    if (event.type === "done") return event.stopReason;
    if (event.type === "update") await update(event.update);
    if (event.type === "permission") {
      await permissions.request({
        type: "permission",
        requestId: event.requestId,
        callId: String(event.toolCall.toolCallId ?? ""),
        title: String(event.toolCall.title ?? "Permission requested"),
        options: event.options,
        status: "pending",
      });
    }
    await buffer.maintain();
    nextEvent = iterator.next();
    // Observe failures even if polling fails before the next race.
    void nextEvent.catch(() => {});
    if (Date.now() >= pollAt) {
      await permissions.poll();
      pollAt = Date.now() + 250;
    }
  }
}
