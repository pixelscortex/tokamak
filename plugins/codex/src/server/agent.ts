/// <reference types="node" />
/// <reference path="./svg.d.ts" />
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { agentInfoCache } from "@tokamak/sdk/agent-turn";
import { local, provide } from "@tokamak/sdk";
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
const info = local({ handler: discovery.read });
const start = local({
  handler: async (ctx, run: ai.Run) => {
    try {
      return await codexTurn(ctx, run);
    } catch (error) {
      discovery.invalidate();
      throw error;
    }
  },
});

export default provide(ai.agent, { id: "codex", name: "Codex", icon, info, start });
