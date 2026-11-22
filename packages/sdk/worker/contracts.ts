import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import {
  contractScope,
  serverContracts,
  type ContractEntry,
  type ContractScope,
  type Provider,
} from "../src/internal/contracts";
import type { AuthContext, FunctionDefinition } from "../src/functions";
import { callHost, type HostBridge } from "../src/host";

export function workerContracts(
  root: { contractProviders?: Record<string, Provider<"local">> },
  kind: "local" | "action",
) {
  const storage = new AsyncLocalStorage<ContractScope>();
  Object.defineProperty(globalThis, contractScope, { value: () => storage.getStore() });
  return function run<T>(host: (plugin?: string) => HostBridge, invoke: () => Promise<T>): Promise<T> {
    if (kind === "action") return storage.run(serverContracts(host()), invoke);
    function scope(plugin?: string): ContractScope {
      const bridge = host(plugin);
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
            const module = own
              ? root
              : ((await storage.exit(() => import(pathToFileURL(path).href))) as typeof root);
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
              implementation: bindProvider(
                definition,
                host(own ? undefined : candidate),
                auth,
                scope(own ? undefined : candidate),
              ),
            });
          }
          return [...entries.values()];
        },
      };
    }
    function bindProvider(definition: object, bridge: HostBridge, auth: AuthContext, owner: ContractScope) {
      const implementation: object = Object.freeze(
        Object.fromEntries(
          Object.entries(definition).map(([member, value]) => {
            if (typeof value === "function")
              return [
                member,
                (...args: unknown[]) => storage.run(owner, () => Reflect.apply(value, implementation, args)),
              ];
            const method = value as FunctionDefinition | null | undefined;
            if (method?.kind === "local" && method.invokeLocal)
              return [
                member,
                (input: unknown = {}) => storage.run(owner, () => method.invokeLocal!(input, bridge, auth)),
              ];
            return [member, value];
          }),
        ),
      );
      return implementation;
    }
    return storage.run(scope(), invoke);
  };
}
