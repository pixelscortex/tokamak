import type {} from "@tokamak/sdk/web";
import { v, type Id } from "@tokamak/sdk";
import { action } from "./_functions";
import { api } from "./_generated/api";
import { DEFAULT_MODEL, modelStream } from "./model";

type Result = { runId: Id<"runs">; messageId: Id<"messages">; status: "done" | "error" | "cancelled" };

export const send = action({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async (ctx, args): Promise<Result> => {
    const { runId, messageId, history } = await ctx.runMutation(api.send.start, { ...args, model: DEFAULT_MODEL });
    const controller = new AbortController();
    let pending = "";
    let flushedAt = Date.now();
    const finish = async (outcome: "done" | "error", error?: string): Promise<Result> => ({
      runId, messageId,
      status: await ctx.runMutation(api.send.update, { runId, delta: pending, outcome, ...(error === undefined ? {} : { error }) }) as Result["status"],
    });

    try {
      const source = await modelStream(ctx, history, controller.signal);
      const iterator = source.stream[Symbol.asyncIterator]();
      let next = iterator.next();
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const chunk = await Promise.race([
          next,
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 100); }),
        ]).finally(() => clearTimeout(timer));
        if (!await ctx.runQuery(api.send.running, { runId })) return { runId, messageId, status: "cancelled" };
        if (chunk?.done) break;
        if (chunk) {
          pending += chunk.value;
          next = iterator.next();
        }
        if (pending && Date.now() - flushedAt >= 100) {
          await ctx.runMutation(api.send.update, { runId, delta: pending });
          pending = "";
          flushedAt = Date.now();
        }
      }
      if (source.error()) throw source.error();
      return await finish("done");
    } catch (cause) {
      return await finish("error", cause instanceof Error ? cause.message : String(cause));
    } finally {
      controller.abort();
    }
  },
});
