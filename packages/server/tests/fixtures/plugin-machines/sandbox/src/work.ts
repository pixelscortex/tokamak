import { readFile } from "node:fs/promises";
import {
  action,
  createApi,
  createFunctions,
  fail,
  internalAction,
  isFailure,
  provide,
  v,
  type FunctionReference,
  type MachineId,
} from "@tokamak/sdk";
import { api } from "./_generated/api";
import { internal } from "./_generated/internal";
import schema from "./schema";
import * as auth from "plugin:auth/contracts";

const { query, mutation } = createFunctions(schema);
const other = createApi<{ work: { where: FunctionReference<"action", {}, { runner: boolean }> } }>(
  "machine-outsider",
);

export const create = action({
  args: { name: v.string(), member: v.optional(v.string()) },
  handler: async (ctx, { name, member }) => {
    const machine = await ctx.machines.create({ name, ...(member === undefined ? {} : { member }) });
    if (isFailure(machine)) return machine;
    return { ...machine, server: await ctx.server.url() };
  },
});

export const remove = action({
  args: { id: v.string() },
  handler: (ctx, { id }) => ctx.machines.remove(id as MachineId),
});

export const waitOnline = action({
  args: { id: v.string(), timeoutMs: v.number() },
  handler: (ctx, { id, timeoutMs }) => ctx.machines.waitOnline(id as MachineId, { timeoutMs }),
});

export const list = query({ handler: (ctx) => ctx.machines.list() });

export const all = internalAction({ handler: (ctx) => ctx.machines.listAll() });

export const unboundCount = action({
  handler: async (ctx) =>
    (await ctx.runAction(internal.work.all, {})).filter((entry) => !entry.member).length,
});

export const listAll = action({ handler: (ctx) => ctx.machines.listAll() });

export const management = action({
  args: { operation: v.string(), id: v.string() },
  handler: async (ctx, { operation, id }) => {
    const machine = id as MachineId;
    if (operation === "create") await ctx.machines.create({ name: "Unexpected machine" });
    if (operation === "remove") await ctx.machines.remove(machine);
    if (operation === "waitOnline") await ctx.machines.waitOnline(machine);
    if (operation === "listAll") await ctx.machines.listAll();
    if (operation === "url") await ctx.server.url();
    return null;
  },
});

export const callNote = action({ on: "caller", handler: (ctx) => ctx.call });

export const anonymous = provide(auth.method, {
  id: "machine-probe",
  name: "Machine probe",
  form: { id: "text" },
  signIn: internalAction({
    args: { id: v.string() },
    handler: async (ctx, { id }) => {
      if (!(await ctx.machines.listAll()).some((entry) => entry.id === id)) return fail("MissingMachine");
      const result = await ctx.runAction(api.work.callNote, {}, { on: id as MachineId });
      if (isFailure(result)) return fail(result.kind);
      return fail(result.user === null ? "AnonymousRunner" : "UnexpectedCaller");
    },
  }),
});

export const store = mutation({
  args: { text: v.string() },
  handler: ({ db }, { text }) => db.insert("lines", { text }),
});

export const createAfterReload = action({
  handler: async (ctx) => {
    await ctx.runMutation(api.work.store, { text: "ready to reload" });
    for (;;) {
      const { rows } = await ctx.runQuery(api.work.rows, {});
      if (rows.some(({ text }) => text === "reload finished")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return ctx.machines.create({ name: "After reload" });
  },
});

export const rows = query({
  handler: async ({ db, call }) => ({ rows: await db.query("lines").collect(), call }),
});

const args = { file: v.string(), thread: v.id("threads") };
export const run = action({
  on: "caller",
  args,
  handler: async (ctx, { file }) => {
    const child = ctx.proc(["/bin/echo", "from the Runner"]);
    const output = [];
    for await (const line of child.stdout) output.push(line);
    const id = await ctx.runMutation(api.work.store, { text: await readFile(file, "utf8") });
    const { rows, call: queryCall } = await ctx.runQuery(api.work.rows, {});
    const machines = await ctx.machines.list();
    return {
      machines,
      output,
      status: await child.exited,
      row: rows.find((row) => row._id === id),
      auth: ctx.auth,
      call: ctx.call,
      queryCall,
    };
  },
});

export const delegate = action({
  args: { ...args, id: v.string() },
  handler: (ctx, { id, ...args }) => ctx.runAction(api.work.run, args, { on: id as MachineId }),
});

export const delegateOther = action({
  args: { id: v.string() },
  handler: (ctx, { id }) => ctx.runAction(other.work.where, {}, { on: id as MachineId }),
});

export const personalDefault = action({
  on: "device:alice" as MachineId,
  handler: (ctx) => ({ runner: typeof ctx.retiring !== "undefined", call: ctx.call }),
});

export const interrupted = action({
  on: "caller",
  args: { marker: v.optional(v.string()) },
  handler: async (ctx, { marker = "waiting" }) => {
    const child = ctx.proc(["/bin/sh", "-c", "echo started; exec /bin/sleep 30"]);
    for await (const _ of child.stdout) await ctx.runMutation(api.work.store, { text: marker });
    return child.exited;
  },
});
