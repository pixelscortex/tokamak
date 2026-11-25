import { action, internalAction, provide } from "@tokamak/sdk";
import { place } from "./contracts";

export const provider = provide(place, {
  location: internalAction({
    on: "caller",
    handler: (ctx) => ({ runner: ctx.retiring !== undefined, depth: ctx.call.depth }),
  }),
});

export const contractCall = action({
  handler: (ctx) => place.get("action-placement", ctx).location(),
});
