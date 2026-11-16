import type { ActionContext, JsonValue, ToolOutput } from "@tokamak/sdk";
import type { TextStreamPart, ToolSet } from "ai";
import { checkToolArgs, TOOL_ARGS_ERROR } from "./parts";
import { safeErrorMessage } from "./model";
import type { ToolTarget } from "./tools";
import type { streamBuffer } from "./stream-buffer";
import type { toolAcknowledgements } from "./acknowledgements";

type Part = TextStreamPart<ToolSet>;

export function toolEvents(
  ctx: ActionContext,
  targets: Map<string, ToolTarget>,
  buffer: ReturnType<typeof streamBuffer>,
  acknowledgements: ReturnType<typeof toolAcknowledgements>,
) {
  const { update, pending } = buffer;
  const activeTools = new Set<string>();

  async function start(part: Extract<Part, { type: "tool-call" }>) {
    const ack = acknowledgements.get(part.toolCallId);
    try {
      if (pending()) await update();
      checkToolArgs(part.input);
      const target = targets.get(part.toolName);
      if (!target) throw new Error("Unknown tool");
      const status = await update({
        type: "tool",
        callId: part.toolCallId,
        ...target,
        args: part.input as JsonValue,
        status: "running",
      });
      if (status === "running") activeTools.add(part.toolCallId);
      ack.resolve(status);
    } catch (error) {
      ack.reject(error);
    }
  }

  async function finish(part: Extract<Part, { type: "tool-result" | "tool-error" }>) {
    const target = targets.get(part.toolName);
    const error = part.type === "tool-error" ? await safeErrorMessage(ctx, part.error) : undefined;
    // A duplicate's rejection must not settle the original call.
    const duplicate = error?.includes(`Duplicate tool callId: ${part.toolCallId}`);
    // Invalid/oversized calls never get persisted, including their args.
    if (!target || duplicate || !activeTools.delete(part.toolCallId)) return;

    try {
      checkToolArgs(part.input);
      await update({
        type: "tool",
        callId: part.toolCallId,
        ...target,
        args: part.input as JsonValue,
        ...(part.type === "tool-error"
          ? { status: "error", error: error! }
          : { ...(part.output as ToolOutput), status: "done" }),
      });
    } catch (error) {
      if (!(error instanceof Error && error.message === TOOL_ARGS_ERROR)) throw error;
    }
  }

  return { start, finish };
}
