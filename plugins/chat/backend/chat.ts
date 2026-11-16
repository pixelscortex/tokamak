import type {} from "@tokamak/sdk/web";
import { v, type Id, type ActionContext } from "@tokamak/sdk";
import { action } from "./_functions";
import { api } from "./_generated/api";
import { functionName } from "@tokamak/sdk";
import type { BackendApi } from "../backends";
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
    // Web crypto is action-only; mutation replay stores the supplied capability.
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const started = await ctx.runMutation(api.send.start, { ...args, token });
    if (started.backend?.kind === "plugin") {
      const backend = started.backend;
      try {
        const provider = (await ctx.providers<BackendApi>("chat.backend")).find(
          (provider) => provider.backend.turn[functionName].split("/")[0] === backend.plugin,
        );
        if (!provider) throw new Error(`Backend plugin unavailable: ${backend.plugin}`);
        const result = await ctx.use(provider).backend.turn({
          ...args,
          runId: started.runId,
          token,
          messageId: started.messageId,
          history: started.history,
          backendId: backend.backendId,
          settings: backend.settings ?? {},
          ...(backend.state === undefined ? {} : { state: backend.state }),
        });
        // A provider must settle the run; a buggy provider cannot leave it running.
        if (!(await ctx.runQuery(api.send.running, { runId: started.runId })))
          return { runId: started.runId, messageId: started.messageId, status: result.status };
        const status = await ctx.runMutation(api.send.update, {
          runId: started.runId,
          token,
          delta: "",
          outcome: result.status,
        });
        return { runId: started.runId, messageId: started.messageId, status: status as Result["status"] };
      } catch (cause) {
        if (!(await ctx.runQuery(api.send.running, { runId: started.runId })))
          return { runId: started.runId, messageId: started.messageId, status: "cancelled" };
        const status = await ctx.runMutation(api.send.update, {
          runId: started.runId,
          token,
          delta: "",
          outcome: "error",
          error: String(cause),
        });
        return { runId: started.runId, messageId: started.messageId, status: status as Result["status"] };
      }
    }
    const { runId, messageId, history, model } = started;
    const controller = new AbortController();
    const buffer = streamBuffer(ctx, runId, token);
    const acknowledgements = toolAcknowledgements();

    const finish = async (outcome: "done" | "error", error?: string): Promise<Result> => {
      if (!(await ctx.runQuery(api.send.running, { runId })))
        return { runId, messageId, status: "cancelled" };
      return {
        runId,
        messageId,
        status: (await ctx.runMutation(api.send.update, {
          runId,
          token,
          delta: buffer.pending(),
          outcome,
          ...(error === undefined ? {} : { error }),
        })) as Result["status"],
      };
    };

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
