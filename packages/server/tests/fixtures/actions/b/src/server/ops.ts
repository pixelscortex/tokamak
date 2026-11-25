/// <reference lib="dom" />
import { action, mutation, query, v, createApi } from "@tokamak/sdk";
import { actionLoop, callLoop } from "../contracts";
import { readCall, writeCall } from "plugin:record/server";

export const publicRead = query({ handler: () => "public" });
export const callerQuery = query({ handler: (ctx) => ctx.auth.user });
export const callerMutation = mutation({ handler: (ctx) => ctx.auth.user });
export const callerAction = action({ handler: (ctx) => ctx.auth.user });
export const waitThroughReload = action({
  handler: async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    return ctx.runQuery(b.ops.publicRead, {});
  },
});
const b = createApi<{ ops: { publicRead: import("@tokamak/sdk").FunctionReference<"query", {}, string> } }>(
  "b",
);
export const privateRead = query({ handler: () => "private" });
export const privateWrite = mutation({ handler: (ctx) => ctx.db.insert("private", { value: "denied" }) });
export const deniedFetch = action({
  args: { url: v.string() },
  handler: async (_ctx, { url }) => (await fetch(url)).text(),
});

// Return caught fetch errors so the regressions observe the JavaScript contract.
export const dns = action({
  args: { count: v.number(), host: v.string() },
  handler: async (_ctx, { count, host }) =>
    Promise.all(
      Array.from({ length: count }, async () => {
        try {
          await fetch(`http://${host}/`);
          return { name: "unexpected success", message: "" };
        } catch (error) {
          return { name: (error as Error).name, message: (error as Error).message };
        }
      }),
    ),
});

// A dependent plugin can discover a run, but never receives its turn capability.
const chat = createApi<{
  runs: {
    active: import("@tokamak/sdk").FunctionReference<
      "query",
      { threadId: import("@tokamak/sdk").Id<"threads"> },
      { _id: import("@tokamak/sdk").Id<"runs"> } | null
    >;
  };
  send: {
    update: import("@tokamak/sdk").FunctionReference<
      "mutation",
      { runId: string; token?: string; delta: string; outcome?: string },
      unknown
    >;
  };
  permissions: {
    claim: import("@tokamak/sdk").FunctionReference<
      "mutation",
      { runId: string; token?: string; requestId: string; expired: boolean },
      unknown
    >;
  };
}>("chat");
export const attackTurn = action({
  args: { threadId: v.id("threads"), requestId: v.string() },
  handler: async (ctx, { threadId, requestId }) => {
    const run = await ctx.runQuery(chat.runs.active, { threadId });
    if (!run) throw new Error("Expected an active victim run");
    const errors: string[] = [];
    for (const capability of [{}, { token: "wrong-token" }]) {
      for (const write of [
        () => ctx.runMutation(chat.send.update, { runId: run._id, ...capability, delta: "forged" }),
        () =>
          ctx.runMutation(chat.send.update, { runId: run._id, ...capability, delta: "", outcome: "done" }),
        () =>
          ctx.runMutation(chat.permissions.claim, {
            runId: run._id,
            ...capability,
            requestId,
            expired: true,
          }),
      ]) {
        try {
          await write();
          errors.push("unexpected success");
        } catch (error) {
          errors.push(String(error));
        }
      }
    }
    return { run, errors };
  },
});

export const loop = query({
  handler: async (ctx): Promise<null> => {
    const [provider] = await callLoop.list(ctx);
    return provider.next();
  },
});

export const noteQuery = query({ handler: ({ call }) => call });
export const noteMutation = mutation({ handler: ({ call }) => call });
export const noteViaAction = action({
  args: { other: v.optional(v.id("threads")), call: v.any() },
  handler: async ({ call, runQuery, runMutation }) => ({
    call,
    query: await runQuery(readCall, {}),
    mutation: await runMutation(writeCall, {}),
  }),
});

export const loopAction = action({
  handler: async (ctx): Promise<null> => {
    const [provider] = await actionLoop.list(ctx);
    if (!provider) throw new Error("Missing action loop provider");
    return provider.next();
  },
});
