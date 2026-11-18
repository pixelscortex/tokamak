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

export const localChatPort = (ctx: ActionContext): ChatPort => ctx.use(api);
