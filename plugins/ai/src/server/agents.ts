/// <reference types="node" />
import { local } from "@tokamak/sdk";
import { agent, type Agent, type Info } from "../contracts";

/** What the agent row shows for an agent whose `info` failed: not usable, like a missing program. */
const UNKNOWN: Info = {
  installed: false,
  signedIn: false,
  install: "",
  signIn: "",
  models: [],
  speeds: [],
  modes: [],
};

/**
 * Every installed agent plugin with its answer to `info`, asked now on this
 * computer. The row calls this whenever it looks, so an install or sign-in
 * made meanwhile shows up. `ai` knows agents only through the contract.
 */
export const list = local({
  handler: async () =>
    Promise.all(
      (await agent.list()).map(async (provider) => ({
        id: provider.id,
        name: provider.name,
        ...(typeof provider.icon === "string" && { icon: provider.icon }),
        info: await infoOf(provider),
      })),
    ),
});

/**
 * The agent's answer to `info`, asked now; one that fails counts as not
 * installed. Lists an agent built before they existed leaves out count as empty.
 */
export function infoOf(provider: Agent): Promise<Info> {
  return provider.info().then(
    (info) => ({ ...info, speeds: info.speeds ?? [], modes: info.modes ?? [] }),
    () => UNKNOWN,
  );
}
