import { contract, type MachineFailure } from "@tokamak/sdk";

export const place = contract<{ location(): { depth: number; runner: boolean } | MachineFailure }>("place");
