/** Shared by the native picker and backend; verified against OpenRouter's catalogue. */
export const DEFAULT_MODEL = "openrouter/free";
export const CHAT_MODELS = [
  DEFAULT_MODEL,
  "inclusionai/ling-3.2-flash:free",
  "liquid/lfm-3-1.7b:free",
  "google/gemma-4-26b-a4b-it:free",
] as const;

export function currentModel(thread?: {
  model?: string;
  backend?: { kind: "model"; model: string } | { kind: "acp"; agent: string };
}): string {
  const backend = thread?.backend;
  return backend?.kind === "acp" ? `acp:${backend.agent}` : backend?.model ?? thread?.model ?? DEFAULT_MODEL;
}
