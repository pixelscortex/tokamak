import { pathToFileURL } from "node:url";
import {
  openChannel,
  type ContractEntry,
  type ContractScope,
  type Provider,
} from "../src/internal/contracts";
import type { AuthContext, FunctionDefinition } from "../src/functions";
import { callHost, type ChannelHandler, type HostBridge, type HostOperations } from "../src/host";
import type { JsonValue } from "../src/values";
import type { AgentTurnOpen } from "../src/agent-turn";
import { agentTurn } from "./agent-turn";

import { wireData } from "./wire-data";

type ProviderModule = { contractProviders?: Record<string, Provider<"local">> };
export type ContractInvocation = {
  plugin: string;
  owner: string;
  name: string;
  registration: string;
  method?: string;
  channel?: true;
};

function dataMethod(methods: true | readonly string[] | undefined, member: string) {
  return methods === true || methods?.includes(member) === true;
}

function checkedProvider(module: ProviderModule, { plugin, owner, name, registration }: ContractInvocation) {
  const provider = module.contractProviders?.[registration];
  if (
    !provider ||
    provider.contract.name !== name ||
    provider.contract.place !== "local" ||
    (provider.contract.owner ?? plugin) !== owner
  )
    throw new Error(`Missing local contract registration: ${owner}/${name} ${registration}`);
  return provider;
}

function localMethod(value: unknown) {
  const method = value as FunctionDefinition | null | undefined;
  return method?.kind === "local" ? method.invokeLocal : undefined;
}

export function dataContracts(root: ProviderModule) {
  return async (target: ContractInvocation, args: JsonValue, bridge: HostBridge): Promise<JsonValue> => {
    const provider = checkedProvider(root, target);
    const { method, owner, name } = target;
    const definition = provider.implementation;
    const declared = provider.contract.dataMethods;
    if (method === undefined) {
      if (declared !== true) throw new Error(`Cannot describe live contract ${owner}/${name} remotely`);
      const methods = Object.entries(definition)
        .filter(([, value]) => typeof value === "function" || localMethod(value))
        .map(([member]) => member);
      const data = Object.fromEntries(
        Object.entries(definition).filter(([member]) => !methods.includes(member)),
      );
      return wireData({ data, methods }, `Local contract ${owner}/${name}.describe result`);
    }
    const label = `Local contract ${owner}/${name}.${method}`;
    if (!Object.hasOwn(definition, method) || !dataMethod(declared, method))
      throw new Error(`${label} is not a plain-data method`);
    if (!Array.isArray(args)) throw new Error(`${label} arguments must be an array`);
    const value = definition[method];
    const local = localMethod(value);
    const auth = await callHost(bridge, "auth.current", {});
    if (!auth) throw new Error("Local contracts require a signed-in caller");
    if (local && args.length > 1) throw new Error(`${label} expects at most one argument`);
    // Agent plugins keep providing start(ctx, Run). Only the QuickJS
    // provider dispatcher constructs that object, inside its own scope.
    if (owner === "ai" && name === "agent" && method === "start") {
      if (!target.channel || args.length !== 1) throw new Error(`${label} requires a turn channel`);
      const result = await agentTurn(args[0] as unknown as AgentTurnOpen, bridge, (run, scoped) => {
        const start = bindProvider(definition, scoped, auth)[method];
        if (typeof start !== "function") throw new Error(`${label} is not a method`);
        return start(run);
      });
      return wireData(result === undefined ? null : result, `${label} result`);
    }
    if (target.channel) throw new Error(`${label} does not accept a channel`);
    const implementation = bindProvider(definition, bridge, auth);
    const handler = implementation[method];
    if (typeof handler !== "function") throw new Error(`${label} is not a method`);
    const result = await handler(...args);
    return wireData(result === undefined ? null : result, `${label} result`);
  };
}

export function workerContracts(
  root: ProviderModule,
  load: (path: string) => Promise<ProviderModule> = (path) => import(pathToFileURL(path).href),
) {
  // A plain provider's static metadata is scoped to its build. Once discovered,
  // looking up a different provider doesn't depend on this process being up.
  type Description = HostOperations["local.contract.describe"]["result"];
  const descriptions = new Map<string, { build?: string; value: Description }>();
  return function bind(bridge: HostBridge, host: (plugin?: string) => HostBridge): ContractScope {
    return {
      async list(key, selected, onIncompatible) {
        if (key.place !== "local") throw new Error("Server contracts run in server functions");
        const catalog = await callHost(bridge, "local.contracts", {
          name: key.name,
          ...(key.owner === undefined ? {} : { owner: key.owner }),
        });
        const auth = await callHost(bridge, "auth.current", {});
        if (!auth) throw new Error("Local contracts require a signed-in caller");
        const entries = new Map<string, ContractEntry>();
        const unavailable: { plugin: string; lastId: JsonValue | undefined; error: unknown }[] = [];
        const candidates = catalog.filter((candidate) => !candidate.incompatible);
        for (const candidate of catalog) {
          if (!candidate.incompatible) continue;
          onIncompatible?.(candidate.plugin);
          unavailable.push({
            plugin: candidate.plugin,
            lastId: undefined,
            error: new Error(
              `${candidate.plugin} was built for a different version of ${key.owner ?? "the owner"}'s ${key.name} contract; rebuild or update it.`,
            ),
          });
        }
        const resolve = async ({
          plugin,
          registration,
          path,
          own,
          owner,
          dataMethods,
          build,
        }: (typeof candidates)[number]) => {
          const target = { plugin, owner, name: key.name, registration };
          const remote =
            (method: string) =>
            (...args: unknown[]) =>
              callHost(bridge, "local.contract.call", {
                ...target,
                method,
                args: wireData(
                  args,
                  `Local contract ${owner}/${key.name}.${method} arguments`,
                ) as JsonValue[],
              });
          let implementation: Readonly<Record<string, unknown>>;
          if (!own && dataMethods === true) {
            const cacheKey = JSON.stringify([plugin, owner, key.name, registration]);
            const cached = descriptions.get(cacheKey);
            try {
              const value =
                cached && cached.build === build
                  ? cached.value
                  : await callHost(bridge, "local.contract.describe", target);
              descriptions.set(cacheKey, { build, value });
              implementation = Object.freeze({
                ...value.data,
                ...Object.fromEntries(value.methods.map((method) => [method, remote(method)])),
                ...(bridge.channel && {
                  [openChannel](method: string, args: unknown, receive: ChannelHandler) {
                    if (!value.methods.includes(method))
                      throw new Error(`Unknown local contract method ${method}`);
                    const label = `Local contract ${owner}/${key.name}.${method}`;
                    return bridge.channel!.open(
                      { ...target, method, args: [wireData(args, `${label} arguments`)] },
                      receive,
                    );
                  },
                }),
              });
            } catch (error) {
              unavailable.push({ plugin, lastId: cached?.value.data.id, error });
              return;
            }
          } else {
            try {
              const module = own ? root : await load(path);
              const { implementation: definition } = checkedProvider(module, target);
              implementation = bindProvider(definition, host(own ? undefined : plugin), auth, (member) =>
                !own && dataMethod(dataMethods, member) ? remote(member) : undefined,
              );
            } catch (error) {
              // A mixed provider can fail to import too. Other agents are still usable.
              if (!dataMethods || own) throw error;
              unavailable.push({ plugin, lastId: undefined, error });
              return;
            }
          }
          return { plugin, implementation };
        };
        const resolved = [];
        if (candidates.some((candidate) => candidate.dataMethods === true))
          resolved.push(...(await Promise.all(candidates.map(resolve))));
        else for (const candidate of candidates) resolved.push(await resolve(candidate));
        for (const entry of resolved) {
          if (!entry) continue;
          const { plugin, implementation } = entry;
          const id = implementation.id ?? plugin;
          if (typeof id !== "string" || !id || entries.has(id))
            throw new Error(`Invalid or duplicate provider id for ${key.name}: ${id}`);
          entries.set(id, { id, implementation });
        }
        if (selected !== undefined && !entries.has(selected) && unavailable.length) {
          const named = unavailable.find(({ plugin, lastId }) => selected === (lastId ?? plugin));
          if (named) throw named.error;
          // On first discovery an unavailable provider hasn't told us its
          // implementation id yet. Report the discovery failures instead of
          // claiming that the requested id does not exist.
          throw new Error(
            `Could not resolve ${key.name} provider ${selected}: ${unavailable.map(({ plugin, error }) => `${plugin}: ${error}`).join("; ")}`,
          );
        }
        return [...entries.values()];
      },
    };
  };
}

function bindProvider(
  definition: object,
  bridge: HostBridge,
  auth: AuthContext,
  remote?: (member: string) => ((...args: unknown[]) => Promise<JsonValue>) | undefined,
) {
  const implementation: Readonly<Record<string, unknown>> = Object.freeze(
    Object.fromEntries(
      Object.entries(definition).map(([member, value]) => {
        const routed = remote?.(member);
        if (routed && (typeof value === "function" || localMethod(value))) return [member, routed];
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
