// Real schema-bound handlers for schema_indexes.rs. They run in QuickJS against
// the plugin's own namespaced tables; expectations are computed in Rust.
import { createFunctions, query as looseQuery, v, type HostBridge, type JsonValue } from "@tokamak/sdk";
import schema from "./schema";

const { query, mutation } = createFunctions(schema);
const row = { owner: v.string(), text: v.string(), done: v.boolean(), created: v.number() };
const bound = v.optional(v.object({ op: v.string(), value: v.number() }));

export const add = mutation({ args: row, handler: (ctx, value) => ctx.db.insert("todos", value) });
export const addNote = mutation({
  args: { topic: v.string(), body: v.string() },
  handler: (ctx, value) => ctx.db.insert("notes", value),
});
export const move = mutation({
  args: { id: v.id("todos"), created: v.number() },
  handler: (ctx, { id, created }) => ctx.db.patch(id, { created }),
});

// The documented example chain: eq on the leading field, then a lower bound.
export const recent = query({
  args: { owner: v.string(), since: v.number() },
  handler: (ctx, { owner, since }) => ctx.db.query("todos")
    .withIndex("by_owner_created", q => q.eq("owner", owner).gt("created", since))
    .order("desc").take(20),
});

// Every bound combination through the real builder. The dynamic method name is
// the only untyped step; the builder still validates it at runtime.
export const range = query({
  args: { owner: v.string(), lower: bound, upper: bound, order: v.string(), limit: v.optional(v.number()) },
  handler: (ctx, a) => {
    const plan = ctx.db.query("todos").withIndex("by_owner_created", q => {
      let r: any = q.eq("owner", a.owner);
      if (a.lower) r = r[a.lower.op]("created", a.lower.value);
      if (a.upper) r = r[a.upper.op]("created", a.upper.value);
      return r;
    }).order(a.order === "desc" ? "desc" : "asc");
    return a.limit === undefined ? plan.collect() : plan.take(a.limit);
  },
});

// Omitting the callback scans the whole index in (owner, created, _id) order.
export const scan = query({
  args: { order: v.string() },
  handler: (ctx, { order }) => ctx.db.query("todos").withIndex("by_owner_created")
    .order(order === "desc" ? "desc" : "asc").collect(),
});

// Un-indexed queries keep working next to declared indexes.
export const unindexed = query({
  args: { owner: v.string() },
  handler: (ctx, { owner }) => ctx.db.query("todos").where("owner", "=", owner).collect(),
});

// Duplicate inserts after a first write in the same call. The caught error is
// rethrown with a marker, proving JS received a catchable error first.
export const addPairRethrow = mutation({
  args: { first: v.object(row), second: v.object(row) },
  handler: async (ctx, { first, second }) => {
    await ctx.db.insert("todos", first);
    try {
      await ctx.db.insert("todos", second);
    } catch (error) {
      throw new Error(`caught in JS: ${(error as Error).message}`);
    }
    return null;
  },
});
export const addPairSwallow = mutation({
  args: { first: v.object(row), second: v.object(row) },
  handler: async (ctx, { first, second }) => {
    await ctx.db.insert("todos", first);
    try {
      await ctx.db.insert("todos", second);
    } catch {
      return "swallowed";
    }
    return "inserted";
  },
});
export const patchText = mutation({
  args: { touch: v.id("todos"), id: v.id("todos"), text: v.string() },
  handler: async (ctx, { touch, id, text }) => {
    await ctx.db.patch(touch, { done: true });
    await ctx.db.patch(id, { text });
    return null;
  },
});
export const replaceText = mutation({
  args: { touch: v.id("todos"), id: v.id("todos"), value: v.object(row) },
  handler: async (ctx, { touch, id, value }) => {
    await ctx.db.patch(touch, { done: true });
    await ctx.db.replace(id, value);
    return null;
  },
});

// Schema-free probes: the loose builder sends any index name to the host, so
// these observe what the server's catalog actually contains.
export const probe = looseQuery({
  args: { table: v.string(), index: v.string() },
  handler: (ctx, { table, index }) => ctx.db.query(table).withIndex(index).collect(),
});
export const notes = looseQuery({ handler: ctx => ctx.db.query("notes").collect() });

// Bypass the SDK query builder entirely and send a hand-written db.query
// payload, as a non-SDK or tampered bundle could. Only the host validates it.
const rawShape = looseQuery({ args: { payload: v.any() }, handler: () => null });
export const raw = Object.freeze({
  ...rawShape,
  invoke: async (input: unknown, host: HostBridge) =>
    host.op("db.query", (input as { payload: JsonValue }).payload),
});
