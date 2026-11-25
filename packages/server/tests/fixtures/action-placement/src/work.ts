import { action, fail, internalQuery, isFailure, mutation, query, v } from "@tokamak/sdk";
import { readProjectFile } from "./read-project";
import { api } from "./_generated/api";
import { internal } from "./_generated/internal";

export const store = mutation({
  args: { text: v.string() },
  handler: ({ db }, { text }) => db.insert("lines", { text }),
});

export const settleRetired = mutation({
  handler: async ({ db }) => {
    const text = "before reload";
    await db.insert("lines", { text });
    return text;
  },
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
  args: { repeat: v.optional(v.boolean()) },
  handler: async (ctx, { repeat }) => {
    const process = ctx.proc([
      "/bin/sh",
      "-c",
      repeat ? "echo $$; while /bin/sleep 1; do echo tick; done" : "echo $$; exec /bin/sleep 30",
    ]);
    for await (const pid of process.stdout) {
      await ctx.runMutation(api.work.store, { text: pid });
    }
    return process.exited;
  },
});

export const marker = query({ handler: (): string => "unhooked" });

export const hookedQuery = action({
  on: "caller",
  handler: (ctx) => ctx.runQuery(api.work.marker, {}),
});

export const failureValue = action({
  handler: () => fail("runnerCapabilityUnavailable", "privateFunctions"),
});

export const useFailureValue = action({
  on: "caller",
  handler: async (ctx) => isFailure(await ctx.runAction(api.work.failureValue, {})),
});

export const connectedProgress = action({
  on: "caller",
  handler: async (ctx) => {
    const process = ctx.proc(["/bin/sh", "-c", "echo $$; echo first; echo second; exec /bin/sleep 30"]);
    for await (const text of process.stdout) {
      await ctx.runMutation(api.work.store, { text });
    }
    return process.exited;
  },
});
