import { api } from "plugin:chat/server";
import type { ActionContext, PluginCalls } from "@tokamak/sdk";

export type ChatPort = Pick<
  PluginCalls<typeof api, "query" | "mutation">,
  | "updateRun"
  | "runIsRunning"
  | "saveBackendState"
  | "requestPermission"
  | "permissionState"
  | "claimPermission"
  | "permissionUndelivered"
>;
export type TurnContext = ActionContext | { chat: ChatPort; signal?: ActionContext["signal"] };
export function chatPort(ctx: TurnContext): ChatPort {
  return "chat" in ctx ? ctx.chat : ctx.use(api);
}
