/// <reference path="./svg.d.ts" />
import { local, provide, type LocalContext } from "@tokamak/sdk";
import * as ai from "plugin:ai/contracts";
import { killAfter, minimumVersion, open, parse, signedIn, speeds, streamArgs, usableVersion } from "./wire";
import { turn } from "./turn";
// The agent's mark, vendored from LobeHub icons (MIT; see icons/LICENSE.md).
import icon from "./icons/claude.svg" with { type: "text" };

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

/**
 * A model's name as people know it, never an alias's label: the default
 * ("Default (recommended)", "Use the default model (currently Opus 5.5)")
 * reads "Opus 5.5", and an alias ("Opus", "Opus 5.5 · Best for…") reads
 * "Opus 5.5". Other names are kept ("Claude Fable 5.2"; the window drops
 * "Claude").
 */
export function modelName(model: { displayName: string; description?: unknown }): string {
  const description = typeof model.description === "string" ? model.description : "";
  const current = /\(currently ([^)]+)\)/.exec(description)?.[1]?.trim();
  if (current) return current;
  const head = description.split(" · ")[0]?.trim();
  if (
    head &&
    head !== model.displayName &&
    head.toLowerCase().startsWith(`${model.displayName.toLowerCase()} `)
  )
    return head;
  return model.displayName.replace(/\s*\(recommended\)$/i, "");
}

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
            name: modelName(model),
            efforts: Array.isArray(model.supportedEffortLevels)
              ? model.supportedEffortLevels.filter((level) => typeof level === "string")
              : [],
          }))
          // An alias of the model the default already is ("opus" while the default is Opus 5.5)
          // would read the same as the default; the first keeps the name.
          .filter((model, index, all) => all.findIndex((other) => other.name === model.name) === index);
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

export default provide(ai.agent, { id: "claude", name: "Claude", icon, info, start });
