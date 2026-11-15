import { HEARTBEAT_MS } from "./recovery";
import type {} from "@tokamak/sdk/web";
import { v, type Id } from "@tokamak/sdk";
import { action } from "./_functions";
import { api } from "./_generated/api";
import { modelStream, safeErrorMessage } from "./model";

type Result = { runId: Id<"runs">; messageId: Id<"messages">; status: "done" | "error" | "cancelled" };

export const send = action({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async (ctx, args): Promise<Result> => {
    const { runId, messageId, history, model } = await ctx.runMutation(api.send.start, args);
    const controller = new AbortController();
    let pending = "";
    let flushedAt = Date.now();
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
          await ctx.runMutation(api.send.update, { runId, delta: pending });
          pending = "";
          flushedAt = Date.now();
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
      const source = await waitFor(modelStream(ctx, history, controller.signal, model));
      const iterator = source.stream[Symbol.asyncIterator]();
      let next = iterator.next();
      for (;;) {
        const chunk = await waitFor(next);
        if (chunk?.done) break;
        if (chunk) {
          pending += chunk.value;
          next = iterator.next();
        }
      }
      if (source.error()) throw source.error();
      return await finish("done");
    } catch (cause) {
      return await finish("error", await safeErrorMessage(ctx, cause));
    } finally {
      controller.abort();
    }
  },
});
