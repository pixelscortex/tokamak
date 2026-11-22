import { local, provide, type LocalContext } from "@tokamak/sdk";
import * as ai from "plugin:ai/contracts";
import { killAfter, minimumVersion, open, parse, signedIn, speeds, streamArgs, usableVersion } from "./wire";
import { turn } from "./turn";

const updateRequired = `Claude needs Claude Code ${minimumVersion} or later.`;

const info = local({
  handler: async (ctx): Promise<ai.Info> => {
    const setup = { install: "curl -fsSL https://claude.ai/install.sh | bash", signIn: "claude auth login" };
    const version = await usableVersion(ctx);
    if (version !== "ready") {
      return {
        installed: false,
        signedIn: false,
        ...setup,
        ...(version === "old" && { install: "claude update", updateRequired }),
        models: [],
        modes: [],
        speeds: [],
      };
    }
    const ready = await signedIn(ctx);
    return {
      installed: true,
      signedIn: ready,
      ...setup,
      ...(ready ? await choices(ctx) : { models: [], speeds: [] }),
      modes: [],
    };
  },
});

async function choices(ctx: LocalContext): Promise<Pick<ai.Info, "models" | "speeds">> {
  // No user message is sent: initialize reveals model aliases and supported
  // effort levels without purchasing a turn. Avoid loading MCP servers just
  // to open the picker; keep Claude's account and gateway settings.
  const wire = open(ctx, [
    ...streamArgs(),
    "--strict-mcp-config",
    "--model",
    "opus",
    "--settings",
    JSON.stringify({ fastMode: true }),
  ]);
  const cancelKill = killAfter(wire.proc, 5_000);
  try {
    const id = wire.control("initialize");
    for await (const line of wire.proc.stdout) {
      const message = parse(line);
      if (message?.type !== "control_response" || !message.response || message.response.request_id !== id)
        continue;
      const response = message.response.response;
      const models = response?.models;
      if (Array.isArray(models) && models.length) {
        const offered = models
          .filter((model) => typeof model?.value === "string" && typeof model.displayName === "string")
          .map((model) => ({
            id: model.value,
            name: model.displayName,
            efforts: Array.isArray(model.supportedEffortLevels)
              ? model.supportedEffortLevels.filter((level) => typeof level === "string")
              : [],
          }));
        // Opus can use fast mode, but account or provider policy can disable it.
        const fast = response?.fast_mode_state;
        return {
          models: offered,
          speeds: fast === "on" || fast === "cooldown" ? [speeds.standard, speeds.fast] : [],
        };
      }
      break;
    }
  } finally {
    cancelKill();
    await wire.close();
  }
  // A model discovery failure should not stop a signed-in user from using
  // the Claude default. Selecting it lets the CLI consult the user's settings.
  return { models: [{ id: "default", name: "Default", efforts: [] }], speeds: [] };
}

const start = local({
  handler: async (ctx, run: ai.Run) => {
    const version = await usableVersion(ctx);
    if (version !== "ready") throw new Error(version === "old" ? updateRequired : "Claude isn't installed.");
    return turn(ctx, run);
  },
});

export default provide(ai.agent, { id: "claude", name: "Claude", info, start });
