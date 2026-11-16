import { v, type ActionContext, type Id, type JsonValue } from "@tokamak/sdk";
import { query } from "./_functions";
import { api } from "./_generated/api";
import { permissionWait } from "./permission-wait";
import type { streamBuffer } from "./stream-buffer";
import type { ToolTarget } from "./tools";
import { DECLINED } from "./parts";

export const required = query({
  args: { threadId: v.id("threads") },
  handler: async ({ db }, { threadId }) => {
    const thread = await db.get(threadId);
    const messages = await db.query("messages").withIndex("by_threadId_createdAt", q => q.eq("threadId", threadId)).collect();
    return messages.some(message => message.role === "user" &&
      (message.authorRole === "guest" || (message.authorRole === undefined && message.authorId !== thread?.ownerId)));
  },
});

export async function toolApproval(
  ctx: ActionContext, threadId: Id<"threads">, runId: Id<"runs">, buffer: ReturnType<typeof streamBuffer>,
) {
  if (!await ctx.runQuery(api["tool-approval"].required, { threadId })) return;
  return async (callId: string, target: ToolTarget, args: JsonValue) => {
    // JSON escapes C0 controls; strip the remaining control and format characters.
    const argumentsText = JSON.stringify(args).replace(/[\u007f-\u009f\p{Cf}]/gu, "");
    const summary = argumentsText.length > 200
      ? `${argumentsText.slice(0, 200)}… (${argumentsText.length - 200} more characters)` : argumentsText;
    let outcome: string | null | undefined;
    const permissions = permissionWait(ctx, runId, buffer, async (_requestId, optionId) => { outcome = optionId; });
    const declined = new Error(DECLINED);
    try {
      await permissions.request({
        type: "permission", requestId: `tool:${callId}`, callId,
        title: `Run ${target.plugin} tool ${target.toolName}?\n${summary}`,
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "reject_once", name: "Deny", kind: "reject_once" },
        ],
        status: "pending",
      });
      while (outcome === undefined) {
        await permissions.poll();
        if (outcome === undefined) await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      if (!await ctx.runQuery(api.send.running, { runId })) throw declined;
      throw error;
    }
    if (outcome !== "allow_once") throw declined;
  };
}
