/// <reference types="node" />
import { local } from "@tokamak/sdk";
import { AGENT_INFO_MAX_AGE_MS, localProviderIdentity, localProviders } from "@tokamak/sdk/agent-turn";
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

const turnInfo = new WeakMap<object, { info: Info; until: number }>();
const refreshAfterFailure = new Set<string>();

export async function infoAfterStartFailure(provider: Agent): Promise<Info | undefined> {
  const key = localProviderIdentity(provider);
  if (key) turnInfo.delete(key);
  refreshAfterFailure.add(provider.id);
  // A failed probe must not turn an unrelated start error into "not installed".
  return readInfo(provider, true).catch(() => undefined);
}

/** The picker probes for account changes; turns reuse only an opted-in, fresh answer for this build. */
export async function infoOf(provider: Agent, forTurn = false): Promise<Info> {
  const key = localProviderIdentity(provider);
  const cached = key && turnInfo.get(key);
  if (forTurn && cached && cached.until > Date.now()) return cached.info;
  return readInfo(provider, !forTurn && refreshAfterFailure.delete(provider.id)).catch(() => {
    if (key) turnInfo.delete(key);
    return UNKNOWN;
  });
}

async function readInfo(provider: Agent, fresh = false): Promise<Info> {
  const key = localProviderIdentity(provider);
  const { cacheUntil, ...answer } = await provider.info(fresh ? { fresh } : {});
  const info = { ...answer, speeds: answer.speeds ?? [], modes: answer.modes ?? [] };
  if (key) {
    const now = Date.now();
    if (info.installed && info.signedIn && typeof cacheUntil === "number" && cacheUntil > now)
      turnInfo.set(key, { info, until: Math.min(cacheUntil, now + AGENT_INFO_MAX_AGE_MS) });
    else turnInfo.delete(key);
  }
  return info;
}
