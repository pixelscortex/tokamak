import { v } from "@tokamak/sdk";
export const backend = v.object({
  kind: v.literal("plugin"),
  plugin: v.string(),
  backendId: v.string(),
  settings: v.optional(v.any()),
  state: v.optional(v.any()),
});

export function folderSetting(settings: unknown): string | undefined {
  if (settings && typeof settings === "object" && "cwd" in settings && typeof settings.cwd === "string")
    return settings.cwd || undefined;
}
