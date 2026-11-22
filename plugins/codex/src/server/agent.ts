/// <reference path="./svg.d.ts" />
import { local, provide } from "@tokamak/sdk";
import * as ai from "plugin:ai/contracts";
import { codexInfo } from "./info";
import { codexTurn } from "./turn";
// The agent's mark, vendored from LobeHub icons (MIT; see icons/LICENSE.md).
import icon from "./icons/openai.svg" with { type: "text" };

const info = local({ handler: codexInfo });
const start = local({ handler: codexTurn });

export default provide(ai.agent, { id: "codex", name: "Codex", icon, info, start });
