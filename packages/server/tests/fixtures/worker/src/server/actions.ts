import { action, query, v } from "@tokamak/sdk";
import { spawn } from "node:child_process";
import { api } from "./_generated/api";
let count = 0;
let retained: (() => Promise<unknown>) | undefined;
export const state = action({
  handler: () => ({
    count: ++count,
    pid: process.pid,
    cwd: process.cwd(),
    secret: process.env.WORKER_UNGRANTED ?? null,
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
    for (;;) {}
  },
});
export const cooperative = action({
  handler: (ctx) =>
    new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true })),
});
export const child = action({
  handler: () => {
    const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    return { worker: process.pid, child: child.pid };
  },
});
export const envDenied = action({ handler: (ctx) => ctx.env("WORKER_UNGRANTED") });
export const dbDenied = action({ handler: (ctx) => (ctx as unknown as { db: unknown }).db ?? null });
// A mixed module must not pull this file's Node actions into QuickJS.
export const pure = query({ handler: () => "QuickJS" });
