import { action, mutation, query, v } from "@tokamak/sdk";
import { readFile } from "node:fs/promises";
import { api } from "./_generated/api";

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
    const text = await readFile(file, "utf8");
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
