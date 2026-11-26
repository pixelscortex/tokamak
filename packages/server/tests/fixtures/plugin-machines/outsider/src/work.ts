import { action, point, query, v, type MachineId } from "@tokamak/sdk";
import { probe } from "./contracts";

export const where = action({
  on: "caller",
  handler: (ctx) => ({ runner: typeof ctx.retiring !== "undefined" }),
});

export const hookedAction = action({ on: "caller", handler: (): string => "owner" });

export const hookedPoint = action({
  on: "caller",
  args: { rejectOwner: v.boolean() },
  handler(ctx, { rejectOwner }) {
    if (rejectOwner) throw new Error("The owner started before checking its point hooks");
    return point(ctx, "gate", "owner" as string);
  },
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
