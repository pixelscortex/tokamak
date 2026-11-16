import type {} from "@tokamak/sdk/web";
import { v, type Id, type ActionContext } from "@tokamak/sdk";
import { action } from "./_functions";
import { api } from "./_generated/api";
import { acpSend } from "./acp";
import { discoverTools } from "./tools";
import { streamBuffer } from "./stream-buffer";
import { toolEvents } from "./tool-events";
import { toolAcknowledgements } from "./acknowledgements";
import { modelStream, safeErrorMessage } from "./model";

type Result = { runId: Id<"runs">; messageId: Id<"messages">; status: "done" | "error" | "cancelled" };

export const send = action({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async (ctx, args): Promise<Result> => {
    const active = await ctx.runQuery(api.runs.active, { threadId: args.threadId });
    if (active) throw new Error("Thread already has an active run");
    const started = await ctx.runMutation(api.send.start, args);
    if (started.backend?.kind === "acp") return acpSend(ctx, args, started, started.backend);
    const { runId, messageId, history, model } = started;
    const controller = new AbortController();
    const buffer = streamBuffer(ctx, runId);
    const acknowledgements = toolAcknowledgements();

    const finish = async (outcome: "done" | "error", error?: string): Promise<Result> => ({
      runId,
      messageId,
      status: (await ctx.runMutation(api.send.update, {
        runId,
        delta: buffer.pending(),
        outcome,
        ...(error === undefined ? {} : { error }),
      })) as Result["status"],
    });

    try {
      const { tools, targets } = await modelTools(ctx, args.threadId, runId, acknowledgements);
      const events = toolEvents(ctx, targets, buffer, acknowledgements);
      const source = await buffer.waitFor(modelStream(ctx, history, controller.signal, model, tools));
      const iterator = source.stream[Symbol.asyncIterator]();
      let next = iterator.next();
      for (;;) {
        // execute waits for our tool-call acknowledgement, then runs independently.
        // Waiting for its next stream event keeps polling cancellation/heartbeats.
        const chunk = await buffer.waitFor(next);
        if (chunk?.done) break;
        if (!chunk) continue;

        const part = chunk.value;
        if (part.type === "finish") {
          if (source.error()) throw source.error();
          return await finish("done");
        }
        if (part.type === "text-delta") buffer.append(part.text);
        if (part.type === "tool-call") await events.start(part);
        if (part.type === "tool-result" || part.type === "tool-error") await events.finish(part);
        next = iterator.next();
      }
      if (source.error()) throw source.error();
      return await finish("done");
    } catch (cause) {
      return await finish("error", await safeErrorMessage(ctx, cause));
    } finally {
      buffer.close();
      controller.abort();
      acknowledgements.close();
    }
  },
});

async function modelTools(
  ctx: ActionContext,
  threadId: Id<"threads">,
  runId: Id<"runs">,
  acknowledgements: ReturnType<typeof toolAcknowledgements>,
) {
  return discoverTools(
    ctx,
    threadId,
    () => ctx.runQuery(api.send.running, { runId }),
    (callId) => acknowledgements.get(callId).promise,
  );
}
