import { action, query, v, type MachineId } from "@tokamak/sdk";
import { probe } from "./contracts";

export const where = action({
  on: "caller",
  handler: (ctx) => ({ runner: typeof ctx.retiring !== "undefined" }),
});

export const list = query({ handler: (ctx) => ctx.machines.list() });

export const outsideProvider = action({
  on: "caller",
  handler: (ctx) => probe.get("machine-provider", ctx).read({}),
});

export const create = action({
  handler: (ctx) => ctx.machines.create({ name: "Contract machine", member: ctx.auth.user.id }),
});

export const waitOnline = action({
  args: { id: v.string() },
  handler: (ctx, { id }) => ctx.machines.waitOnline(id as MachineId),
});

export const remove = action({
  args: { id: v.string() },
  handler: (ctx, { id }) => ctx.machines.remove(id as MachineId),
});
