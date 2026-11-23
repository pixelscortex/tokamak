import { pathToFileURL } from "node:url";
import { type ContractEntry, type ContractScope, type Provider } from "../src/internal/contracts";
import type { AuthContext, FunctionDefinition } from "../src/functions";
import { callHost, type HostBridge } from "../src/host";

type ProviderModule = { contractProviders?: Record<string, Provider<"local">> };

export function workerContracts(
  root: ProviderModule,
  load: (path: string) => Promise<ProviderModule> = (path) => import(pathToFileURL(path).href),
) {
  return function bind(bridge: HostBridge, host: (plugin?: string) => HostBridge): ContractScope {
    return {
      async list(key) {
        if (key.place !== "local") throw new Error("Server contracts run in server functions");
        const candidates = await callHost(bridge, "local.contracts", {
          name: key.name,
          ...(key.owner === undefined ? {} : { owner: key.owner }),
        });
        const auth = await callHost(bridge, "auth.current", {});
        if (!auth) throw new Error("Local contracts require a signed-in caller");
        const entries = new Map<string, ContractEntry>();
        for (const { plugin: candidate, registration, path, own, owner } of candidates) {
          const module = own ? root : await load(path);
          const provider = module.contractProviders?.[registration];
          if (
            !provider ||
            provider.contract.name !== key.name ||
            provider.contract.place !== "local" ||
            (provider.contract.owner ?? candidate) !== owner
          )
            throw new Error(`Missing local contract registration: ${registration}`);
          const definition = provider.implementation;
          const id = definition.id ?? candidate;
          if (typeof id !== "string" || !id || entries.has(id))
            throw new Error(`Invalid or duplicate provider id for ${key.name}: ${id}`);
          entries.set(id, {
            id,
            implementation: bindProvider(definition, host(own ? undefined : candidate), auth),
          });
        }
        return [...entries.values()];
      },
    };
    function bindProvider(definition: object, bridge: HostBridge, auth: AuthContext) {
      const implementation: object = Object.freeze(
        Object.fromEntries(
          Object.entries(definition).map(([member, value]) => {
            if (typeof value === "function")
              return [member, (...args: unknown[]) => Reflect.apply(value, implementation, args)];
            const method = value as FunctionDefinition | null | undefined;
            if (method?.kind === "local" && method.invokeLocal)
              return [member, (input: unknown = {}) => method.invokeLocal!(input, bridge, auth)];
            return [member, value];
          }),
        ),
      );
      return implementation;
    }
  };
}
