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
