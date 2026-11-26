/// <reference types="node" />
/// <reference path="./svg.d.ts" />
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { agentInfoCache } from "@tokamak/sdk/agent-turn";
import { withAgentLaunch } from "@tokamak/sdk/agent-launch";
import { action, provide } from "@tokamak/sdk";
import * as ai from "plugin:ai/contracts";
import { codexInfo } from "./info";
import { codexTurn } from "./turn";
// The agent's mark, vendored from LobeHub icons (MIT; see icons/LICENSE.md).
import icon from "./icons/openai.svg" with { type: "text" };

const discovery = agentInfoCache(codexInfo, async () => {
  const path = join(
    process.env.CODEX_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".codex"),
    "auth.json",
  );
  const stamp = await stat(path).catch(() => undefined);
  return stamp ? `${path}:${stamp.ino}:${stamp.mtimeMs}:${stamp.size}` : path;
});
const info = action({
  on: "caller",
  handler: (ctx, { setupDeadline }: { setupDeadline?: number }) =>
    setupDeadline === undefined ? discovery.read(ctx) : codexInfo(ctx, setupDeadline),
});
const start = action({
  on: "caller",
  handler: async (ctx, run: ai.Run) => {
    try {
      if (!run.launchSettings) return await codexTurn(ctx, run);
      return await withAgentLaunch(run.launchSettings, "codex", ({ env, args }) =>
        codexTurn(ctx, run, {
          env,
          // This turn must not fall back to a login in the system keyring.
          args: [...args, "-c", 'cli_auth_credentials_store="file"'],
        }),
      );
    } catch (error) {
      if (!run.launchSettings) discovery.invalidate();
      throw error;
    }
  },
});

export default provide(ai.agent, { id: "codex", name: "Codex", icon, info, start });
