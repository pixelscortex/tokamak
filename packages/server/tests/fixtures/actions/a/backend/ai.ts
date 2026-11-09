/// <reference lib="dom" />
/// <reference types="node" />
import { action, v } from "@tokamak/sdk";
import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

export const stream = action({
  args: { baseURL: v.string(), abort: v.boolean(), ack: v.string(), observed: v.string() },
  handler: async (_ctx, args) => {
    const controller = new AbortController();
    const provider = createOpenAI({ baseURL: args.baseURL, apiKey: "local-mock-only" });
    let failure = "";
    const result = streamText({
      model: provider.chat("mock"), prompt: "offline regression", maxRetries: 0,
      abortSignal: controller.signal,
      onError: ({ error }) => { failure = String(error); },
    });
    const deltas: string[] = [];
    for await (const delta of result.textStream) {
      deltas.push(delta);
      if (args.abort && deltas.length === 2) { controller.abort(); break; }
      await (await fetch(args.ack)).text();
    }
    // Abort must close HTTP before returning and retiring this world.
    const observed = args.abort ? await (await fetch(args.observed)).text() : "complete";
    if (failure) throw new Error(failure);
    return { deltas, aborted: controller.signal.aborted, observed };
  },
});
