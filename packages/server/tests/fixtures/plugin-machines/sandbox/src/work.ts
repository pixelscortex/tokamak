import { readFile } from "node:fs/promises";
import { action, createApi, createFunctions, v, type FunctionReference, type MachineId } from "@tokamak/sdk";
import { api } from "./_generated/api";
import schema from "./schema";

const { query, mutation } = createFunctions(schema);
const other = createApi<{ work: { where: FunctionReference<"action", {}, { runner: boolean }> } }>(
  "machine-outsider",
);

export const create = action({
  args: { name: v.string() },
  handler: async (ctx, { name }) => ({
    ...(await ctx.machines.create({ name })),
    server: await ctx.server.url(),
  }),
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

export const store = mutation({
  args: { text: v.string() },
  handler: ({ db }, { text }) => db.insert("lines", { text }),
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
    return {
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
  handler: async (ctx) => {
    const child = ctx.proc(["/bin/sh", "-c", "echo waiting; exec /bin/sleep 30"]);
    for await (const text of child.stdout) await ctx.runMutation(api.work.store, { text });
    return child.exited;
  },
});
