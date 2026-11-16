import { v, type Infer } from "@tokamak/sdk";

export const permissionPart = v.object({
  type: v.literal("permission"),
  requestId: v.string(),
  callId: v.string(),
  title: v.string(),
  options: v.array(v.object({ optionId: v.string(), name: v.string(), kind: v.string() })),
  status: v.union(v.literal("pending"), v.literal("answered"), v.literal("expired"), v.literal("cancelled")),
  optionId: v.optional(v.string()),
  answeredBy: v.optional(v.string()),
});
export type PermissionPart = Infer<typeof permissionPart>;

// The transaction that claims a part owns its outcome, even if cancellation follows.
export function claimPermission(part: PermissionPart, status: "answered" | "expired" | "cancelled") {
  if (part.status !== "pending") return part;
  if (status !== "answered") {
    delete part.optionId;
    delete part.answeredBy;
  }
  part.status = status;
  return part;
}
