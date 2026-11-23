import { action, query, v } from "@tokamak/sdk";
import { api } from "./_generated/api";

declare const fixtureSpawn: typeof import("node:child_process").spawn;
declare const fixtureWriteFile: typeof import("node:fs").writeFileSync;

let count = 0;
let releaseLarge: (() => void) | undefined;
let retained: (() => Promise<unknown>) | undefined;
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
export const remember = action({
  handler: (ctx) => {
    retained = () => ctx.runQuery(api.database.get, { id: "items/missing" as never });
  },
});
export const stale = action({
  handler: async () => {
    try {
      await retained!();
      return "allowed";
    } catch (error) {
      return String(error);
    }
  },
});
export const crash = action({ handler: () => process.exit(7) });
export const stuck = action({ handler: () => new Promise(() => {}) });
export const cpu = action({
  handler: () => {
    if (typeof process !== "undefined") fixtureWriteFile("cpu-started", "");
    else console.info("action process entered CPU loop");
    for (;;) {}
  },
});
export const flood = action({
  args: { stderr: v.boolean() },
  handler: async (_, { stderr }) => {
    for (let i = 0; i < 4096; i++) {
      if (stderr) process.stderr.write("x".repeat(8192) + "\n");
      else console.log("x".repeat(8192));
      if (typeof process === "undefined") await Promise.resolve();
      else await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return "flooded";
  },
});
export const waitForLarge = action({
  handler: () =>
    new Promise<string>((resolve) => {
      releaseLarge = () => resolve("waiting");
    }),
});
export const large = action({
  handler: async (ctx) => {
    try {
      return await ctx.runQuery(api.database.large, {});
    } finally {
      releaseLarge?.();
    }
  },
});
export const cooperative = action({
  handler: (ctx) =>
    new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true })),
});
export const child = action({
  handler: () => {
    const child = fixtureSpawn("/bin/sleep", ["60"], { stdio: "ignore" });
    return { worker: process.pid, child: child.pid };
  },
});
export const envDenied = action({ handler: (ctx) => ctx.env("WORKER_UNGRANTED") });
export const networkDenied = action({
  handler: async () => (await fetch("http://127.0.0.1:1")).text(),
});
export const dbDenied = action({ handler: (ctx) => (ctx as unknown as { db: unknown }).db ?? null });
// A mixed module must not pull this file's Node actions into QuickJS.
export const pure = query({ handler: () => "QuickJS" });

export const thrown = action({
  handler: () => {
    throw new Error("action error sentinel");
  },
});

export const logMarker = action({
  handler: () => console.info("action process log marker"),
});
