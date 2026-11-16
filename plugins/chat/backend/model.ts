import type {} from "@tokamak/sdk/web";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, stepCountIs, type ToolSet, type ModelMessage } from "ai";
import type { ActionContext } from "@tokamak/sdk";

// The provider boundary: another backend can later supply the same text stream.
export async function modelStream(
  ctx: ActionContext,
  messages: ModelMessage[],
  signal: AbortSignal,
  model: string,
  tools: ToolSet,
) {
  const apiKey = await ctx.env("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  const baseURL = (await ctx.env("OPENROUTER_BASE_URL")) || "https://openrouter.ai/api/v1";
  const provider = createOpenAI({ apiKey, baseURL });
  let failure: unknown;
  const result = streamText({
    model: provider.chat(model),
    messages,
    tools,
    stopWhen: stepCountIs(5),
    abortSignal: signal,
    maxRetries: 0,
    onError: ({ error }) => {
      failure = error;
    },
  });
  return { stream: result.fullStream, error: () => failure };
}

// Provider errors can echo request headers, so never store the key verbatim.
export async function safeErrorMessage(ctx: ActionContext, cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  // A missing grant is itself the error being reported, so it must not throw again.
  const apiKey = await ctx.env("OPENROUTER_API_KEY").catch(() => undefined);

  return apiKey ? message.replaceAll(apiKey, "[redacted]") : message;
}
