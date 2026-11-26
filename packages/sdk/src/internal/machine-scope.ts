import type { HostBridge } from "../host";

export const machineScope = Symbol.for("tokamak.machine.scope");

export interface MachineScope {
  readonly host: HostBridge;
  readonly besideServer?: <T>(operation: () => Promise<T>) => Promise<T>;
}
