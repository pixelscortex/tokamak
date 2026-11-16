import { action, v, type JsonValue } from "@tokamak/sdk";
import { agents } from "./agents/client";
import { checkFolder } from "./agents/discovery";
import { acpSend } from "./turn/acp";

export const describe = action({
  handler: () => agents.agents().map((agent) => ({ ...agent, folder: true })),
});

// Settings validation belongs to the provider; chat treats them as opaque JSON.
export const configure = action({
  args: { backendId: v.string(), settings: v.any() },
  handler: async (_, { backendId, settings }) => {
    if (!agents.agents().some((agent) => agent.id === backendId)) throw new Error("Unknown agent");
    // The host grants an explicit picker folder before this action runs.
    if (!String((settings as { cwd?: unknown })?.cwd ?? "").trim())
      throw new Error("Select an agent folder before starting a conversation");
    const cwd = await checkFolder({ path: String((settings as { cwd?: unknown })?.cwd ?? "") });
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
    const cwd = await checkFolder({ path: typeof settings?.cwd === "string" ? settings.cwd : "" });
    return acpSend(ctx, args, args, {
      agent: args.backendId,
      cwd,
      ...(state?.sessionId ? { sessionId: state.sessionId } : {}),
    });
  },
});
