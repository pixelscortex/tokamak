import { action, internalQuery, mutation, query, v } from "@tokamak/sdk";
import { readProjectFile } from "./read-project";
import { api } from "./_generated/api";
import { internal } from "./_generated/internal";

export const store = mutation({
  args: { text: v.string() },
  handler: ({ db }, { text }) => db.insert("lines", { text }),
});

export const rows = query({
  handler: async ({ db, call }) => ({ rows: await db.query("lines").collect(), call }),
});

export const run = action({
  on: "caller",
  args: { file: v.string(), thread: v.id("threads") },
  handler: async (ctx, { file }) => {
    const child = ctx.proc(["/bin/echo", "started"]);
    const output = [];
    for await (const line of child.stdout) output.push(line);
    const text = await readProjectFile(file);
    const id = await ctx.runMutation(api.work.store, { text });
    const { rows, call: queryCall } = await ctx.runQuery(api.work.rows, {});
    const hash = await ctx.crypto.hashPassword("placement");
    return {
      verified: await ctx.crypto.verifyPassword("placement", hash),
      environment: await ctx.env("FIXTURE_ACTION_PLACEMENT"),
      output,
      status: await child.exited,
      saved: rows.some((row) => row._id === id && row.text === text),
      call: ctx.call,
      queryCall,
      auth: ctx.auth,
    };
  },
});

export const callerDefault = action({
  on: "caller",
  handler: (ctx) => ({ runner: typeof ctx.retiring !== "undefined", depth: ctx.call.depth }),
});

export const serverDefault = action({
  handler: (ctx) => ({ runner: "retiring" in ctx && ctx.retiring !== undefined, depth: ctx.call.depth }),
});

export const read = action({
  on: "caller",
  args: { file: v.string() },
  handler: (_ctx, { file }) => readProjectFile(file),
});

export const privateRead = internalQuery({ handler: ({ call }) => call.depth });

export const callPrivate = action({
  on: "caller",
  handler: (ctx) => ctx.runQuery(internal.work.privateRead, {}),
});

export const wait = action({
  on: "caller",
  handler: async (ctx) => {
    const process = ctx.proc(["/bin/sleep", "30"]);
    await ctx.runMutation(api.work.store, { text: "waiting to be cancelled" });
    return process.exited;
  },
});
