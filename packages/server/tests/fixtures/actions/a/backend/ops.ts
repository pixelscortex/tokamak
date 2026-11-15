/// <reference lib="dom" />
import { action, mutation, query, createApi, v, type ApiFromModule } from "@tokamak/sdk";

const self = createApi<{ ops: ApiFromModule<typeof import("./ops")> }>("a");
const b = createApi<{ ops: ApiFromModule<typeof import("../../b/backend/ops")> }>("b");
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const append = mutation({
  args: { value: v.string() },
  handler: (ctx, { value }) => ctx.db.insert("items", { value }),
});
export const rollback = mutation({ handler: async ctx => {
  await ctx.db.insert("items", { value: "rolled back" });
  throw new Error("nested rollback sentinel");
} });
export const list = query({ handler: ctx => ctx.db.query("items").collect() });
export const timeoutQuery = query({ handler: () => new Promise<null>(() => {}) });
export const timeoutMutation = mutation({ handler: () => new Promise<null>(() => {}) });
export const transactions = action({ handler: async (ctx): Promise<unknown> => {
  const noDb = !("db" in ctx);
  await ctx.runMutation(self.ops.append, { value: "committed before error" });
  let rolledBack = false;
  try { await ctx.runMutation(self.ops.rollback, {}); } catch { rolledBack = true; }
  const before = await ctx.runQuery(self.ops.list, {});
  await ctx.runMutation(self.ops.append, { value: "committed after query" });
  return { noDb, rolledBack, before, rows: await ctx.runQuery(self.ops.list, {}) };
} });
export const failedAction = action({ handler: async (ctx): Promise<never> => {
  await ctx.runMutation(self.ops.append, { value: "survives action failure" });
  throw new Error("action failure sentinel");
} });
export const idle = action({ args: { started: v.string(), ms: v.number() }, handler: async (_ctx, args) => {
  const pending = wait(args.ms);
  await (await fetch(args.started)).text();
  await pending;
  return "timer completed";
} });
export const queryFetch = query({ args: { url: v.string() }, handler: async (_ctx, { url }) => (await fetch(url)).text() });
export const mutationFetch = mutation({ args: { url: v.string() }, handler: async (_ctx, { url }) => (await fetch(url)).text() });
export const streamed = action({ args: { url: v.string(), ack: v.string() }, handler: async (_ctx, args) => {
  const response = await fetch(args.url);
  const reader = response.body!.getReader();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
    // Acknowledgement gates the next server chunk: full-body buffering deadlocks.
    await (await fetch(args.ack)).text();
  }
  return chunks;
} });
export const fetchText = action({ args: { url: v.string() }, handler: async (_ctx, { url }) => (await fetch(url)).text() });
export const abortFetch = action({ args: { url: v.string(), observed: v.string() }, handler: async (_ctx, args) => {
  const controller = new AbortController();
  const response = await fetch(args.url, { signal: controller.signal });
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const pending = reader.read();
  controller.abort();
  let error = "";
  try { await pending; } catch (e) { error = (e as Error).name; }
  // Keep this action/world alive until the mock observes disconnect; world
  // retirement alone must not be able to make the abort assertion pass.
  const observed = await (await fetch(args.observed)).text();
  return { first, error, observed };
} });
function frozen() {
  const before = Date.now();
  // External timers are forbidden in transactions; promise work must retain
  // the same logical clock even as real wall time advances.
  return { before, random: Math.random() };
}
export const queryTime = query({ handler: async ctx => {
  const before = frozen();
  for (let i = 0; i < 12; i++) await ctx.db.query("items").collect();
  return { ...before, after: Date.now() };
} });
export const mutationTime = mutation({ handler: async ctx => {
  const before = frozen();
  for (let i = 0; i < 12; i++) await ctx.db.insert("clock", { i });
  return { ...before, after: Date.now() };
} });
export const time = action({ handler: async (ctx): Promise<unknown> => {
  const before = Date.now();
  await wait(40);
  return { before, after: Date.now(), query: await ctx.runQuery(self.ops.queryTime, {}), mutation: await ctx.runMutation(self.ops.mutationTime, {}) };
} });
export const random = action({ handler: () => Array.from({ length: 8 }, () => Math.random()) });
export const exports = action({ args: { write: v.boolean() }, handler: async (ctx, { write }): Promise<unknown> => {
  if (write) return ctx.runMutation(b.ops.privateWrite, {});
  return ctx.runQuery(b.ops.privateRead, {});
} });
export const publicCall = action({ handler: (ctx): Promise<string> => ctx.runQuery(b.ops.publicRead, {}) });
export const missing = action({ handler: () => new WebSocket("ws://127.0.0.1:1") });
// TKM-44 x TKM-45: an action result is one wire response under the shared
// 1 MiB limit, and a timer-only action lets reload cancel it without network.
export const oversized = action({ args: { bytes: v.number() }, handler: (_ctx, { bytes }) => "x".repeat(bytes) });
export const sleep = action({ args: { ms: v.number() }, handler: async (_ctx, { ms }) => {
  await wait(ms);
  return "slept";
} });

export { todoTools } from "../../b/backend/ops";
