import { v } from "@tokamak/sdk";
import { action } from "./_functions";

export const list = action({ handler: ({ acp }) => acp.agents() });

export const checkFolder = action({
  args: { path: v.string() },
  handler: ({ acp }, args) => acp.checkFolder(args),
});
