import type { ActionSignal } from "./host";

export interface MachineHub {
  url: string;
  token: string;
}
export interface MachineConfiguration {
  machineId: string;
  name: string;
  hubs: MachineHub[];
}
/** Independent service lifetime; no invocation-bound database authority. */
export interface MachineContext {
  readonly signal: ActionSignal;
  configuration(): Promise<MachineConfiguration>;
}
