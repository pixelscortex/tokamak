import type {} from "@tokamak/sdk/web";
import { listBackends } from "../backends/backends";
import { v, type Id } from "@tokamak/sdk";
import { action } from "../_functions";
import { api } from "../_generated/api";
import { functionName } from "@tokamak/sdk";
import type { BackendApi } from "../../shared/backends";

type Result = { runId: Id<"runs">; messageId: Id<"messages">; status: "done" | "error" | "cancelled" };

// Show people the reason, not the JS stack the host appends to messages.
function readableError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    message
      .split(/\n|\s+at\s+\S+\s+\(/)[0]!
      .replace(/^Error:\s*/, "")
      .trim() || "The agent failed"
  );
}

export const send = action({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async (ctx, args): Promise<Result> => {
    if (ctx.user.id !== "local") throw new Error("Agents run from the desktop app on your own computer.");
    const current = (await ctx.runQuery(api.threads.list, {})).find((thread) => thread._id === args.threadId);
    if (!current) throw new Error("Thread no longer exists");
    const active = await ctx.runQuery(api.runs.active, { threadId: args.threadId });
    if (
      active &&
      (active.owner?.id ?? "local") === ctx.user.id &&
      (active.backendId === undefined ||
        (active.backendId === current.backend?.backendId && active.backendPlugin === current.backend.plugin))
    )
      throw new Error("Thread already has an active run");
    const options = await listBackends(ctx);
    if (
      !current.backend ||
      !options.some(
        (option) => option.plugin === current.backend!.plugin && option.id === current.backend!.backendId,
      )
    )
      throw new Error("No agents found. Install `claude-agent-acp` or `codex-acp` (see README)");
    // Web crypto is action-only; mutation replay stores the supplied capability.
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const started = await ctx.runMutation(api.send.start, { ...args, token });
    if (!started.started) throw new Error("Local turn did not start");
    const backend = started.backend;
    try {
      const provider = (await ctx.providers<BackendApi>("chat.backend")).find(
        (provider) => provider.backend.turn[functionName].split("/")[0] === backend.plugin,
      );
      if (!provider) throw new Error(`Backend plugin unavailable: ${backend.plugin}`);
      const result = await ctx.use(provider).backend.turn({
        ...args,
        runId: started.runId,
        token,
        messageId: started.messageId,
        history: started.history,
        backendId: backend.backendId,
        settings: backend.settings ?? {},
        ...(backend.state === undefined ? {} : { state: backend.state }),
      });
      // A provider must settle the run; a buggy provider cannot leave it running.
      if (!(await ctx.runQuery(api.send.running, { runId: started.runId })))
        return { runId: started.runId, messageId: started.messageId, status: result.status };
      const status = await ctx.runMutation(api.send.update, {
        runId: started.runId,
        token,
        delta: "",
        outcome: result.status,
      });
      return { runId: started.runId, messageId: started.messageId, status: status as Result["status"] };
    } catch (cause) {
      if (!(await ctx.runQuery(api.send.running, { runId: started.runId })))
        return { runId: started.runId, messageId: started.messageId, status: "cancelled" };
      const status = await ctx.runMutation(api.send.update, {
        runId: started.runId,
        token,
        delta: "",
        outcome: "error",
        error: readableError(cause),
      });
      return { runId: started.runId, messageId: started.messageId, status: status as Result["status"] };
    }
  },
});
