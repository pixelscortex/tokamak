import { v } from "@tokamak/sdk";

export const backend = v.union(
  v.object({ kind: v.literal("model"), model: v.string() }),
  v.object({ kind: v.literal("acp"), agent: v.string(), cwd: v.string(), sessionId: v.optional(v.string()) }),
);
