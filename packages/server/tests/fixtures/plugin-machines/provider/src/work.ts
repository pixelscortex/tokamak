import { provide } from "@tokamak/sdk";
import { probe } from "plugin:machine-outsider/contracts";

export const provider = provide(probe, { read: async () => "provider" });
