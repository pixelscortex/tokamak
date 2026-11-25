import { action } from "@tokamak/sdk";

export const ready = action({ handler: () => "workspace ready" });
