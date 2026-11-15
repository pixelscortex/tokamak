import type { Infer } from "@tokamak/sdk";
import { boundedError, checkToolArgs, jsonBytes, textPart, toolUpdate, type ToolPart } from "./parts";

export function applyToolUpdate(parts: (Infer<typeof textPart> | ToolPart)[], tool: Infer<typeof toolUpdate>) {
  const patch = { ...tool };
  if (patch.args !== undefined) checkToolArgs(patch.args);
  if (patch.error !== undefined) patch.error = boundedError(patch.error);
  if (patch.result !== undefined && jsonBytes(patch.result) > 8 * 1024) patch.result = { truncated: true };

  const existing = parts.find(part => part.type === "tool" && part.callId === patch.callId);
  if (existing?.type === "tool") {
    if (patch.status === "running") throw new Error(`Duplicate tool callId: ${patch.callId}`);
    if (existing.status !== "running") throw new Error("Tool is already settled");
    checkIdentity(patch, existing);

    const { callId: _callId, plugin: _plugin, toolName: _toolName, args: _args, ...completion } = patch;
    Object.assign(existing, completion);
    return;
  }

  if (patch.status !== "running") throw new Error("New tool part must be running");
  if (patch.plugin === undefined || patch.toolName === undefined || patch.args === undefined)
    throw new Error("New tool part requires plugin, toolName and args");
  parts.push({ type: "tool", ...patch } as ToolPart);
}

function checkIdentity(patch: Infer<typeof toolUpdate>, existing: ToolPart) {
  if ((patch.plugin !== undefined && patch.plugin !== existing.plugin) ||
      (patch.toolName !== undefined && patch.toolName !== existing.toolName)) {
    throw new Error("Tool identity is immutable");
  }
}
