import { HEARTBEAT_MS } from "./recovery";
import type {} from "@tokamak/sdk/web";
import { v, type Id } from "@tokamak/sdk";
import { action } from "./_functions";
import { api } from "./_generated/api";
import { discoverTools } from "./tools";
import type { ToolPart } from "./parts";
import { modelStream, safeErrorMessage } from "./model";

type Result = { runId: Id<"runs">; messageId: Id<"messages">; status: "done" | "error" | "cancelled" };

export const send = action({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async (ctx, args): Promise<Result> => {
    const { runId, messageId, history, model } = await ctx.runMutation(api.send.start, args);
    const controller = new AbortController();
    let pending = "";
    let flushedAt = Date.now();
    let writes = Promise.resolve();
    const update = (tool?: ToolPart) => {
      const write = async () => {
        const delta = pending;
        pending = "";
        await ctx.runMutation(api.send.update, { runId, delta, ...(tool ? { tool } : {}) });
        flushedAt = Date.now();
      };
      writes = writes.then(write);
      return writes;
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

    const finish = async (outcome: "done" | "error", error?: string): Promise<Result> => ({
      runId, messageId,
      status: await ctx.runMutation(api.send.update, { runId, delta: pending, outcome, ...(error === undefined ? {} : { error }) }) as Result["status"],
    });

    try {
      const { tools, targets } = await discoverTools(ctx, args.threadId,
        () => ctx.runQuery(api.send.running, { runId }), update);
      const source = await waitFor(modelStream(ctx, history, controller.signal, model, tools));
      const iterator = source.stream[Symbol.asyncIterator]();
      let next = iterator.next();
      for (;;) {
        const chunk = await waitFor(next);
        if (chunk?.done) break;
        if (chunk) {
          const part = chunk.value;
          if (part.type === "text-delta") pending += part.text;
          if (part.type === "tool-error") {
            const target = targets.get(part.toolName);
            if (target) await update({
              type: "tool", callId: part.toolCallId, ...target, args: part.input as import("@tokamak/sdk").JsonValue,
              status: "error", error: await safeErrorMessage(ctx, part.error),
            });
          }
          next = iterator.next();
        }
      }
      await writes;
      if (source.error()) throw source.error();
      return await finish("done");
    } catch (cause) {
      return await finish("error", await safeErrorMessage(ctx, cause));
    } finally {
      controller.abort();
    }
  },
});
