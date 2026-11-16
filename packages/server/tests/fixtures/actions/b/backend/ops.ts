/// <reference lib="dom" />
import { action, mutation, query, v, createApi, type ApiFromModule } from "@tokamak/sdk";
export const publicRead = query({ handler: () => "public" });
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

const record = createApi<{
  tools: ApiFromModule<typeof import("../../record/backend/tools")>;
  record: ApiFromModule<typeof import("../../record/backend/record")>;
}>("record");
export const recordTools = action({
  handler: async (ctx) => {
    const descriptions = await ctx.runQuery(record.tools.describe, {});
    const out = await ctx.runMutation(record.tools.invoke, {
      name: "records.create",
      args: { title: "Buy milk tomorrow" },
      threadId: "test-thread",
    });
    return {
      descriptions,
      out,
      record: await ctx.runQuery(record.record.get, {
        id: (out.result as { id: import("@tokamak/sdk").Id<"records"> }).id,
      }),
    };
  },
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
