import { v, type Infer } from "@tokamak/sdk";

export const permissionPart = v.object({
  type: v.literal("permission"), requestId: v.string(), callId: v.string(), title: v.string(),
  options: v.array(v.object({ optionId: v.string(), name: v.string(), kind: v.string() })),
  status: v.union(v.literal("pending"), v.literal("answered"), v.literal("expired"), v.literal("cancelled")),
  optionId: v.optional(v.string()), answeredBy: v.optional(v.string()),
});
export type PermissionPart = Infer<typeof permissionPart>;
