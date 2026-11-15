import { HEARTBEAT_MS } from "./recovery";
import type {} from "@tokamak/sdk/web";
import { v, type Id } from "@tokamak/sdk";
import { action } from "./_functions";
import { api } from "./_generated/api";
import { discoverTools } from "./tools";
import { checkToolArgs, type ToolPart } from "./parts";
import { modelStream, safeErrorMessage } from "./model";

type Result = { runId: Id<"runs">; messageId: Id<"messages">; status: "done" | "error" | "cancelled" };

export const send = action({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async (ctx, args): Promise<Result> => {
    const { runId, messageId, history, model } = await ctx.runMutation(api.send.start, args);
    const controller = new AbortController();
    let pending = "";
    let flushedAt = Date.now();
    const activeTools = new Set<string>();
    const acknowledgements = new Map<string, {
      promise: Promise<unknown>; resolve: (status: unknown) => void; reject: (error: unknown) => void;
    }>();
    const acknowledgement = (callId: string) => {
      let entry = acknowledgements.get(callId);
      if (!entry) {
        let resolve!: (status: unknown) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
        // Validation may reject before execute starts waiting.
        void promise.catch(() => {});
        entry = { promise, resolve, reject };
        acknowledgements.set(callId, entry);
      }
      return entry;
    };
    const update = async (tool?: ToolPart) => {
      const delta = pending;
      const status = await ctx.runMutation(api.send.update, { runId, delta, ...(tool ? { tool } : {}) });
      pending = pending.slice(delta.length);
      flushedAt = Date.now();
      return status;
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
        () => ctx.runQuery(api.send.running, { runId }), callId => acknowledgement(callId).promise);
      const source = await waitFor(modelStream(ctx, history, controller.signal, model, tools));
      const iterator = source.stream[Symbol.asyncIterator]();
      let next = iterator.next();
      for (;;) {
        // execute waits for our tool-call acknowledgement, then runs independently.
        // Waiting for its next stream event keeps polling cancellation/heartbeats.
        const chunk = await waitFor(next);
        if (chunk?.done) break;
        if (chunk) {
          const part = chunk.value;
          if (part.type === "finish") {
            if (source.error()) throw source.error();
            return await finish("done");
          }
          if (part.type === "text-delta") pending += part.text;
          if (part.type === "tool-call") {
            const ack = acknowledgement(part.toolCallId);
            try {
              if (pending) await update();
              checkToolArgs(part.input);
              const target = targets.get(part.toolName);
              if (!target) throw new Error("Unknown tool");
              const status = await update({ type: "tool", callId: part.toolCallId, ...target,
                args: part.input as import("@tokamak/sdk").JsonValue, status: "running" });
              if (status === "running") activeTools.add(part.toolCallId);
              ack.resolve(status);
            } catch (error) { ack.reject(error); }
          }
          if (part.type === "tool-result" || part.type === "tool-error") {
            const target = targets.get(part.toolName);
            const error = part.type === "tool-error" ? await safeErrorMessage(ctx, part.error) : undefined;
            // A duplicate's rejection must not settle the original call.
            const duplicate = error?.includes(`Duplicate tool callId: ${part.toolCallId}`);
            // Invalid/oversized calls never get persisted, including their args.
            if (target && !duplicate && activeTools.delete(part.toolCallId)) {
              try {
                checkToolArgs(part.input);
                await update({ type: "tool", callId: part.toolCallId, ...target,
                  args: part.input as import("@tokamak/sdk").JsonValue,
                  ...(part.type === "tool-error"
                    ? { status: "error", error: error! }
                    : { ...(part.output as import("@tokamak/sdk").ToolOutput), status: "done" }),
                });
              } catch (error) {
                if (!(error instanceof Error && error.message === "Tool arguments exceed 16 KB")) throw error;
              }
            }
          }
          next = iterator.next();
        }
      }
      if (source.error()) throw source.error();
      return await finish("done");
    } catch (cause) {
      return await finish("error", await safeErrorMessage(ctx, cause));
    } finally {
      controller.abort();
      for (const ack of acknowledgements.values()) ack.reject(new Error("Run ended"));
    }
  },
});
