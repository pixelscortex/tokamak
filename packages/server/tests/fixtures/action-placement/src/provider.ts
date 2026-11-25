import { action, internalAction, local, provide } from "@tokamak/sdk";
import { localPlace, place } from "./contracts";

export const provider = provide(place, {
  location: internalAction({
    on: "caller",
    handler: (ctx) => ({ runner: ctx.retiring !== undefined, depth: ctx.call.depth }),
  }),
});

export const contractCall = action({
  handler: (ctx) => place.get("ai", ctx).location(),
});

export const localProvider = provide(localPlace, {
  id: "fixture",
  location: local({ handler: (ctx) => ctx.call.depth }),
});

export const callLocalContract = action({
  on: "caller",
  handler: (ctx) => localPlace.get("fixture", ctx).location(),
});

export const callServerContract = action({
  on: "caller",
  handler: (ctx) => place.get("ai", ctx).location(),
});
