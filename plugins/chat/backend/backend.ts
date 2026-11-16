import { v } from "@tokamak/sdk";
export const backend = v.union(
  v.object({ kind: v.literal("model"), model: v.string() }),
  v.object({
    kind: v.literal("plugin"),
    plugin: v.string(),
    backendId: v.string(),
    settings: v.optional(v.any()),
    state: v.optional(v.any()),
  }),
);
