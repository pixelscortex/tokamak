import { v } from "@tokamak/sdk";
export const backend = v.object({
  kind: v.literal("plugin"),
  plugin: v.string(),
  backendId: v.string(),
  settings: v.optional(v.any()),
  state: v.optional(v.any()),
});
