import { action, query } from "@tokamak/sdk";

export const where = action({
  on: "caller",
  handler: (ctx) => ({ runner: typeof ctx.retiring !== "undefined" }),
});

export const list = query({ handler: (ctx) => ctx.machines.list() });
