import type { ActionContext, Id } from "@tokamak/sdk";
import { api } from "./_generated/api";
import { streamBuffer } from "./stream-buffer";
import { permissionWait } from "./permission-wait";
import { acpEvents } from "./acp-events";

// Keep the most recent history within the byte budget, without splitting Unicode.
export function historyPrefix(history: { role: string; content: string }[]): string {
  const text = history.map(message => `${message.role}: ${message.content}`).join("\n\n");
  const characters = Array.from(text);
  let start = characters.length;
  let bytes = 0;
  while (start > 0) {
    const character = characters[start - 1]!;
    const point = character.codePointAt(0)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > 32 * 1024) break;
    bytes += size;
    start--;
  }
  return characters.slice(start).join("");
}

type Started = {
  runId: Id<"runs">; messageId: Id<"messages">;
  history: { role: string; content: string }[];
};
type Backend = { agent: string; cwd: string; sessionId?: string };

export async function acpSend(ctx: ActionContext, args: { threadId: Id<"threads">; text: string }, started: Started, backend: Backend) {
  const { runId, messageId } = started;
  const buffer = streamBuffer(ctx, runId);
  let sessionId: string | undefined;
  let finished = false;
  let closed = false;
  let openingSession = true;
  const finish = async (outcome: "done" | "error" | "cancelled", error?: string) => ({
    runId, messageId,
    status: await ctx.runMutation(api.send.update, { runId, delta: buffer.pending(), outcome,
      ...(error === undefined ? {} : { error }) }) as "done" | "error" | "cancelled",
  });

  try {
    // Keep ownership of an open that completes after cancellation so it can be cancelled too.
    const opening = ctx.acp.open(backend).then(async opened => {
      sessionId = opened.sessionId;
      if (closed) await ctx.acp.cancel({ agent: backend.agent, sessionId });
      return opened;
    });
    const opened = await buffer.waitFor(opening);
    openingSession = false;
    await ctx.runMutation(api.send.session, { threadId: args.threadId, agent: backend.agent, cwd: backend.cwd, sessionId: opened.sessionId });
    const prefix = opened.restored ? "" : historyPrefix(started.history.slice(0, -1));
    const text = prefix ? `Previous conversation:\n${prefix}\n\nuser: ${args.text.trim()}` : args.text.trim();
    const iterator = ctx.acp.prompt({ agent: backend.agent, sessionId: opened.sessionId, text })[Symbol.asyncIterator]();
    const update = acpEvents(backend.agent, buffer);

    const permissions = permissionWait(ctx, runId, buffer);
    // Keep exactly one read outstanding while polling all pending permissions.
    let nextEvent = iterator.next();
    let pollAt = Date.now() + 250;
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        nextEvent,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, Math.min(100, pollAt - Date.now()))); }),
      ]).finally(() => clearTimeout(timer));
      if (!next) {
        await buffer.maintain();
        if (Date.now() >= pollAt) {
          await permissions.poll();
          pollAt = Date.now() + 250;
        }
        continue;
      }
      if (next.done) throw new Error("Agent ended without a stop reason");
      const event = next.value;
      if (event.type === "update") await update(event.update);
      if (event.type === "permission") {
        await permissions.request({
          type: "permission", requestId: event.requestId, callId: String(event.toolCall.toolCallId ?? ""),
          title: String(event.toolCall.title ?? "Permission requested"), options: event.options, status: "pending",
        });
      }
      if (event.type !== "done") {
        await buffer.maintain();
        nextEvent = iterator.next();
        // Observe failures even when processing an update fails before the next race.
        void nextEvent.catch(() => {});
        if (Date.now() >= pollAt) {
          await permissions.poll();
          pollAt = Date.now() + 250;
        }
        continue;
      }

      finished = true;
      if (event.stopReason === "refusal") return await finish("error", "Agent refused");
      if (event.stopReason === "cancelled") return await finish("cancelled");
      if (event.stopReason === "max_tokens" || event.stopReason === "max_turn_requests")
        buffer.append(`\n[Agent stopped: ${event.stopReason === "max_tokens" ? "token limit" : "turn request limit"}.]`);
      if (!["end_turn", "max_tokens", "max_turn_requests"].includes(event.stopReason))
        return await finish("error", `Unknown agent stop reason: ${event.stopReason}`);
      return await finish("done");
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return await finish("error", openingSession && /auth|sign.?in|log.?in/i.test(error)
      ? `Sign in to \`${backend.agent}\` in a terminal` : error);
  } finally {
    closed = true;
    if (sessionId && !finished) await ctx.acp.cancel({ agent: backend.agent, sessionId }).catch(() => {});
  }
}
