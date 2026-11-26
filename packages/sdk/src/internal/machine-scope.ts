import type { HostBridge } from "../host";

export interface MachineScope {
  readonly host: HostBridge;
  readonly besideServer?: <T>(operation: () => Promise<T>) => Promise<T>;
}

// Kept off the context object, so plugin code cannot reach the host bridge
// through it. One entry per context, released with it.
const scopes = new WeakMap<object, MachineScope>();

export function bindMachineScope<T extends object>(ctx: T, scope: MachineScope): T {
  scopes.set(ctx, scope);
  return ctx;
}

export function machineScopeOf(ctx: object): MachineScope {
  const scope = scopes.get(ctx);
  if (!scope) throw new TypeError("machines(ctx) needs the ctx of a Tokamak function");
  return scope;
}
