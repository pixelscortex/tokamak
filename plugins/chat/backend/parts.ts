import { v, type Infer } from "@tokamak/sdk";

export const textPart = v.object({ type: v.literal("text"), text: v.string() });
export const toolPart = v.object({
  type: v.literal("tool"), callId: v.string(), plugin: v.string(), toolName: v.string(),
  args: v.any(), status: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
  result: v.optional(v.any()), summary: v.optional(v.string()), model: v.optional(v.string()),
  view: v.optional(v.string()), error: v.optional(v.string()),
});
export type ToolPart = Infer<typeof toolPart>;

export const toolUpdate = v.object({
  type: v.optional(v.literal("tool")),
  callId: v.string(), plugin: v.optional(v.string()), toolName: v.optional(v.string()),
  args: v.optional(v.any()), status: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
  result: v.optional(v.any()), summary: v.optional(v.string()), model: v.optional(v.string()),
  view: v.optional(v.string()), error: v.optional(v.string()),
});

// Count UTF-8 bytes without requiring Web APIs in mutations.
export function jsonBytes(value: unknown): number {
  let bytes = 0;
  for (const character of JSON.stringify(value) ?? "null") {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function checkToolArgs(args: unknown) {
  if (jsonBytes(args) > 16 * 1024) throw new Error("Tool arguments exceed 16 KB");
}

export function boundedError(error: string): string {
  // Each UTF-16 code unit needs at most three UTF-8 bytes.
  return error.slice(0, 680);
}

export function interruptTools(parts: (Infer<typeof textPart> | ToolPart)[], error: string) {
  return parts.map(part => part.type === "tool" && part.status === "running"
    ? { ...part, status: "error" as const, error } : part);
}
