import { local, provide } from "@tokamak/sdk";
import * as ai from "plugin:ai/contracts";
import { codexInfo } from "./info";
import { codexTurn } from "./turn";

const info = local({ handler: codexInfo });
const start = local({ handler: codexTurn });

export default provide(ai.agent, { id: "codex", name: "Codex", info, start });
