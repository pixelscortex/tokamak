import type { JsonObject } from "@tokamak/sdk";
import type { ToolPart } from "../../chat/stream";
import type { streamBuffer } from "../../chat/stream";

function contentText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const value = block as Record<string, unknown>;
      if (value.type === "content") return contentText(value.content);
      if (value.type === "text") return String(value.text ?? "");
      return value.type === "image" ? "[image]" : "[resource]";
    })
    .join("");
}

export function acpEvents(agent: string, buffer: ReturnType<typeof streamBuffer>) {
  const tools = new Map<string, ToolPart>();

  return async (update: JsonObject) => {
    if (update.sessionUpdate === "agent_message_chunk") buffer.append(contentText(update.content));
    if (update.sessionUpdate === "plan") {
      await buffer.update(undefined, {
        type: "plan",
        entries: update.entries as { content: string; status: string; priority: string }[],
      });
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;

    const callId = String(update.toolCallId);
    let tool = tools.get(callId);
    if (update.sessionUpdate === "tool_call") {
      tool = {
        type: "tool",
        callId,
        plugin: `acp:${agent}`,
        toolName: String(update.name ?? update.kind ?? "other"),
        args: update.rawInput ?? {},
        summary: String(update.title ?? ""),
        status: "running",
      };
      tools.set(callId, tool);
      await buffer.update(tool);
      return;
    }
    if (!tool) return;

    updateTool(tool, update);
    await buffer.update(tool);
  };
}

function updateTool(tool: ToolPart, update: JsonObject) {
  if (update.title !== undefined) tool.summary = String(update.title);
  if (update.status === "completed") tool.status = "done";
  if (update.status === "failed") tool.status = "error";
  const result = { ...(tool.result as object) } as JsonObject;
  for (const key of ["content", "locations", "rawOutput"]) {
    if (update[key] !== undefined) result[key] = update[key];
  }
  tool.result = result;
  if (update.content !== undefined) tool.model = contentText(update.content);
}
