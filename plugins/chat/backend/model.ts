import type {} from "@tokamak/sdk/web";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ModelMessage } from "ai";
import type { ActionContext } from "@tokamak/sdk";

export const DEFAULT_MODEL = "openrouter/free";

// The provider boundary: another backend can later supply the same text stream.
export async function modelStream(ctx: ActionContext, messages: ModelMessage[], signal: AbortSignal) {
  const apiKey = await ctx.env("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  const baseURL = await ctx.env("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1";
  const provider = createOpenAI({ apiKey, baseURL });
  let failure: unknown;
  const result = streamText({
    model: provider.chat(DEFAULT_MODEL), messages, abortSignal: signal, maxRetries: 0,
    onError: ({ error }) => { failure = error; },
  });
  return { stream: result.textStream, error: () => failure };
}
