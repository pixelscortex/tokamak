import { agents } from "./client";
import { checkFolder as folder } from "./discovery";
import { v } from "@tokamak/sdk";
import { action } from "@tokamak/sdk";

export const list = action({ handler: () => agents.agents() });

export const checkFolder = action({
  args: { path: v.string() },
  handler: (_, args) => folder(args),
});
