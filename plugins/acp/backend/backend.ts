import { action, v, type JsonValue } from "@tokamak/sdk";
import { acpSend } from "./acp";

export const describe = action({
  handler: ({ acp }) => acp.agents().map((agent) => ({ ...agent, folder: true })),
});

// Settings validation belongs to the provider; chat treats them as opaque JSON.
export const configure = action({
  args: { backendId: v.string(), settings: v.any() },
  handler: async ({ acp }, { backendId, settings }) => {
    if (!acp.agents().some((agent) => agent.id === backendId)) throw new Error("Unknown agent");
    // An empty folder means the home folder, so a new thread works without setup.
    const cwd = await acp.checkFolder({ path: String((settings as { cwd?: unknown })?.cwd ?? "") });
    return { cwd };
  },
});

export const turn = action({
  args: {
    runId: v.id("runs"),
    token: v.string(),
    messageId: v.id("messages"),
    threadId: v.id("threads"),
    backendId: v.string(),
    text: v.string(),
    history: v.array(v.object({ role: v.string(), content: v.string() })),
    settings: v.any(),
    state: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const settings = args.settings as { cwd?: JsonValue };
    const state = args.state as { sessionId?: string } | undefined;
    const cwd = await ctx.acp.checkFolder({ path: typeof settings?.cwd === "string" ? settings.cwd : "" });
    return acpSend(ctx, args, args, {
      agent: args.backendId,
      cwd,
      ...(state?.sessionId ? { sessionId: state.sessionId } : {}),
    });
  },
});
