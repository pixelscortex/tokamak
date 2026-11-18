/** Isolated server budget-recovery fixture. */
import { mutation } from "@tokamak/sdk";

export const endless = mutation({
  handler: (): null => {
    while (true) {
      /* Deliberate CPU loop, not a never-resolving Promise. */
    }
  },
});
export const healthy = mutation({
  handler: () => "next mutation succeeded",
});
