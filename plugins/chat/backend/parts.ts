import { claimPermission, permissionPart } from "./permission-part";
import { v, type Infer } from "@tokamak/sdk";

const toolCompletion = {
  status: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
  result: v.optional(v.any()), summary: v.optional(v.string()), model: v.optional(v.string()),
  view: v.optional(v.string()), error: v.optional(v.string()),
};

export const textPart = v.object({ type: v.literal("text"), text: v.string() });
export const toolPart = v.object({
  type: v.literal("tool"), callId: v.string(), plugin: v.string(), toolName: v.string(),
  args: v.any(), ...toolCompletion,
});
export const planPart = v.object({
  type: v.literal("plan"),
  entries: v.array(v.object({ content: v.string(), status: v.string(), priority: v.string() })),
});
export type Part = Infer<typeof textPart> | Infer<typeof toolPart> | Infer<typeof planPart> | Infer<typeof permissionPart>;
export type ToolPart = Infer<typeof toolPart>;

export const toolUpdate = v.object({
  type: v.optional(v.literal("tool")),
  callId: v.string(), plugin: v.optional(v.string()), toolName: v.optional(v.string()),
  args: v.optional(v.any()), ...toolCompletion,
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

export const TOOL_ARGS_ERROR = "Tool arguments exceed 16 KB";

export function checkToolArgs(args: unknown) {
  if (jsonBytes(args) > 16 * 1024) throw new Error(TOOL_ARGS_ERROR);
}

export function boundedError(error: string): string {
  // Each UTF-16 code unit needs at most three UTF-8 bytes.
  return error.slice(0, 680);
}

export function interruptTools(parts: Part[], error: string) {
  return parts.map(part => part.type === "permission" && part.status === "pending"
    ? claimPermission({ ...part }, error === "cancelled" ? "cancelled" : "expired")
    : part.type === "tool" && part.status === "running"
    ? { ...part, status: "error" as const, error } : part);
}

export function appendText(parts: Part[], text: string) {
  const last = parts.at(-1);
  if (last?.type === "text") last.text += text;
  else parts.push({ type: "text", text });
}
