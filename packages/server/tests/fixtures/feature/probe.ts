// Real SDK feature handlers probe host transactions, JSON semantics and readsets.
// Loose builders deliberately permit arbitrary document fields, as does the SDK.
import {
  action,
  createApi,
  mutation,
  query,
  v,
  type ApiFromModule,
  type JsonObject,
  type Id,
} from "@tokamak/sdk";

export const whoQuery = query({
  handler: async (ctx) => ({ user: ctx.auth.user, count: (await ctx.db.query("items").collect()).length }),
});
export const whoMutation = mutation({
  handler: async (ctx) => {
    await ctx.db.insert("items", { author: ctx.auth.user.id });
    return ctx.auth.user;
  },
});
const identityApi = createApi<{
  probe: ApiFromModule<{ whoQuery: typeof whoQuery; whoMutation: typeof whoMutation }>;
}>();
export const whoAction = action({
  handler: async (ctx) => ({
    user: ctx.auth.user,
    query: await ctx.runQuery(identityApi.probe.whoQuery, {}),
    mutation: await ctx.runMutation(identityApi.probe.whoMutation, {}),
  }),
});

export const list = query({
  args: { table: v.string() },
  handler: ({ db }, { table }) => db.query(table).collect(),
});
export const get = query({
  args: { id: v.string() },
  handler: ({ db }, { id }) => db.get(id as Id),
});
export const insert = mutation({
  args: { table: v.string(), value: v.any() },
  handler: ({ db }, { table, value }) => db.insert(table, value as JsonObject),
});
export const patch = mutation({
  args: { id: v.string(), value: v.any() },
  handler: ({ db }, { id, value }) => db.patch(id as Id, value as JsonObject),
});
export const replace = mutation({
  args: { id: v.string(), value: v.any() },
  handler: ({ db }, { id, value }) => db.replace(id as Id, value as JsonObject),
});
export const remove = mutation({
  args: { id: v.string() },
  handler: ({ db }, { id }) => db.delete(id as Id),
});
export const filtered = query({
  args: { field: v.string(), value: v.any(), descending: v.boolean(), limit: v.number() },
  handler: ({ db }, a) =>
    db
      .query("items")
      .where(a.field, "=", a.value)
      .order(a.descending ? "desc" : "asc")
      .take(a.limit),
});
export const count = query({
  handler: async ({ db }) => (await db.query("items").collect()).length,
});
export const selected = query({
  handler: async ({ db }) => {
    const selection = await db.query("selection").first();
    return db.query(typeof selection?.table === "string" ? selection.table : "left").collect();
  },
});
export const rollback = mutation({
  args: { caught: v.boolean() },
  handler: async ({ db }, { caught }) => {
    await db.insert("items", { value: "must roll back" });
    if (!caught) throw new Error("handler rollback sentinel");
    try {
      await db.patch("items:missing" as Id, { value: "missing" });
    } catch {}
    return "caught errors cannot authorize a partial commit";
  },
});
export const readonly = query({
  handler: ({ db }) => ({
    methods: Object.keys(db).sort(),
    // The runtime object must not expose a writable capability, even after a cast.
    canWrite: typeof (db as unknown as { insert?: unknown }).insert === "function",
  }),
});
export const increment = mutation({
  args: { ids: v.array(v.string()) },
  handler: async ({ db }, { ids }) => {
    const values: number[] = [];
    for (const id of ids) {
      const row = await db.get(id as Id);
      const value = Number(row?.value) + 1;
      await db.patch(id as Id, { value });
      values.push(value);
    }
    await db.insert("audit", { values });
    return values;
  },
});
export const abandoned = mutation({
  handler: ({ db }) => {
    // Intentionally violate the await discipline: no unreported write may survive.
    void db.insert("items", { value: "unreported" }).catch(() => {});
    return null;
  },
});
export const timeout = mutation({
  handler: async ({ db }) => {
    await db.insert("items", { value: "timeout must roll back" });
    await new Promise<never>(() => {});
  },
});

export const caughtForeign = mutation({
  args: { id: v.string() },
  handler: async ({ db }, { id }) => {
    await db.insert("items", { value: "must roll back after denied access" });
    try {
      await db.get(id as Id);
    } catch {}
    return "caught";
  },
});
