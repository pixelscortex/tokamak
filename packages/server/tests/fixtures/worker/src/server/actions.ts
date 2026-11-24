import { action, query, v } from "@tokamak/sdk";
import { api } from "./_generated/api";

let count = 0;
export const state = action({
  handler: () => ({
    count: ++count,
    pid: typeof process === "undefined" ? null : process.pid,
    cwd: typeof process === "undefined" ? null : process.cwd(),
    secret: typeof process === "undefined" ? null : (process.env.WORKER_UNGRANTED ?? null),
  }),
});
export const echo = action({
  args: { value: v.string(), delay: v.number() },
  handler: async (_, { value, delay }) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return value;
  },
});
export const roundtrip = action({
  args: { value: v.string() },
  handler: async (ctx, { value }) => {
    const id = await ctx.runMutation(api.database.insert, { value });
    return ctx.runQuery(api.database.get, { id });
  },
});
export const stuck = action({
  handler: () => new Promise(() => {}),
});
export const cpu = action({
  handler: () => {
    console.info("action process entered CPU loop");
    for (;;) {}
  },
});
export const flood = action({
  handler: async () => {
    for (let i = 0; i < 4096; i++) {
      console.log("x".repeat(8192));
      await Promise.resolve();
    }
    return "flooded";
  },
});
export const large = action({
  handler: (ctx) => ctx.runQuery(api.database.large, {}),
});
export const cooperative = action({
  handler: (ctx) =>
    new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true })),
});
export const envDenied = action({ handler: (ctx) => ctx.env("WORKER_UNGRANTED") });
export const networkDenied = action({
  handler: async () => (await fetch("http://127.0.0.1:1")).text(),
});
export const dbDenied = action({ handler: (ctx) => (ctx as unknown as { db: unknown }).db ?? null });
// A mixed module keeps transactions available when the action process exits.
export const pure = query({ handler: () => "QuickJS" });

export const thrown = action({
  handler: () => {
    throw new Error("action error sentinel");
  },
});

export const logMarker = action({
  handler: () => console.info("action process log marker"),
});
