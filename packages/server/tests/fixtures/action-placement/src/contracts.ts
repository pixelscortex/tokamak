import type { Run, TurnResult } from "@tokamak/sdk/agent-turn";
import { contract, type MachineFailure } from "@tokamak/sdk";

export const place = contract<{ location(): { depth: number; runner: boolean } | MachineFailure }>("place");

export const localPlace = contract<{ id: string; location(): Promise<number> }>("localPlace", {
  place: "local",
  dataMethods: true,
});

export const agent = contract<{ id: string; start(run: Run): Promise<TurnResult> }>("agent", {
  place: "local",
  dataMethods: true,
});
