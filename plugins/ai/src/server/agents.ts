/// <reference types="node" />
import { local } from "@tokamak/sdk";
import { localProviders } from "@tokamak/sdk/agent-turn";
import { agent, type Agent, type Info } from "../contracts";
import { MAX_ICON_LENGTH } from "../shared/icon";

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
  handler: async (ctx) => {
    const { providers, incompatible } = await localProviders(agent, ctx);
    const available = await Promise.all(
      providers.map(async (provider) => ({
        id: provider.id,
        name: provider.name,
        ...(typeof provider.icon === "string" &&
          provider.icon.length <= MAX_ICON_LENGTH && { icon: provider.icon }),
        info: await infoOf(provider),
      })),
    );
    return [
      ...available,
      ...incompatible.map((plugin): (typeof available)[number] => ({
        id: plugin,
        name: plugin,
        info: {
          ...UNKNOWN,
          updateRequired: `${plugin} was built for a different version of ai's agent contract; rebuild or update it.`,
        },
      })),
    ];
  },
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
