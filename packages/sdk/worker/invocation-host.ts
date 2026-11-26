import type { ActionSignal, HostBridge } from "../src/host";
import type { ContractScope } from "../src/internal/contracts";
import type { LocalProcess } from "../src/local";

interface Programs {
  start: LocalProcess;
  close(signal?: "SIGKILL"): Promise<void>;
}

/** Give each bridge its own program owner, including bridges for other plugins. */
export function invocationHost(
  signal: ActionSignal,
  op: (plugin: string | undefined) => HostBridge["op"],
  createPrograms?: () => Programs,
  contracts?: (bridge: HostBridge, provider: (plugin?: string) => HostBridge) => ContractScope,
  channel?: HostBridge["channel"],
  retiring?: ActionSignal,
) {
  const outer = createPrograms?.();
  const scopes = new Set<Programs>();
  let closing = false;

  function host(plugin?: string, programs = outer): HostBridge {
    return {
      signal,
      retiring: plugin === undefined ? retiring : undefined,
      proc: programs?.start,
      channel: plugin === undefined ? channel : undefined,
      get contracts() {
        return contracts?.(this, (candidate) => host(candidate, programs));
      },
      withPrograms:
        createPrograms &&
        (async (run) => {
          if (closing || signal.aborted) throw new Error("Caller action cancelled");
          if (programs !== outer) throw new Error("Program scopes cannot nest");
          const inner = createPrograms();
          scopes.add(inner);
          try {
            return await run(() => inner.close("SIGKILL"), host(plugin, inner));
          } finally {
            const reaping = inner.close().finally(() => scopes.delete(inner));
            void reaping.catch(() => {});
          }
        }),
      op: op(plugin),
    };
  }

  return {
    host,
    async close() {
      closing = true;
      await Promise.all([outer?.close(), ...Array.from(scopes, (inner) => inner.close())]);
    },
  };
}
