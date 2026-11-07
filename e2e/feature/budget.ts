/** Scenario 5 only. Never discovered by app/backend or embedded in the app. */
import { mutation } from "@tokamak/sdk";

export const endless = mutation({
  handler: (): null => {
    while (true) { /* Deliberate CPU loop, not a never-resolving Promise. */ }
  },
});
export const healthy = mutation({
  handler: () => "next mutation succeeded",
});
