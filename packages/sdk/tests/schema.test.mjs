// TKM-84 / TKM-89 SDK acceptance: schema index declarations, the indexed query
// builder's host payloads and runtime rejections, and compile-time checking of
// index chains. Storage, ordering and uniqueness execution are server tests
// (packages/server/tests/schema_indexes.rs); this host only records requests.
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, cp, readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFunctions, defineSchema, defineTable, query as loose, schemaMetadata, v } from "../src/index.ts";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(sdk, "../..");

const todoFields = { owner: v.string(), text: v.string(), done: v.boolean(), created: v.number() };
const schema = defineSchema({
  todos: defineTable(todoFields)
    .index("by_owner_created", ["owner", "created"])
    .unique("by_owner_text", ["owner", "text"]),
  notes: defineTable({ topic: v.string() }),
});
const { query } = createFunctions(schema);

function recordingHost(reply = []) {
  const requests = [];
  return {
    requests,
    host: {
      op(name, payload) {
        requests.push([name, payload]);
        return reply;
      },
    },
  };
}

// Builders are shared module values; a chained call must never add an index
// to the table another schema (or a later chain) already holds.
test("index declarations chain immutably and serialize as plain metadata", () => {
  const base = defineTable(todoFields);
  const indexed = base.index("by_owner_created", ["owner", "created"]);
  const both = indexed.unique("by_owner_text", ["owner", "text"]);
  expect(base.indexes).toEqual([]);
  expect(indexed.indexes).toEqual([{ name: "by_owner_created", fields: ["owner", "created"], unique: false }]);
  expect(both.indexes).toEqual([
    { name: "by_owner_created", fields: ["owner", "created"], unique: false },
    { name: "by_owner_text", fields: ["owner", "text"], unique: true },
  ]);
  // Forking the same base yields independent tables.
  const other = indexed.index("by_done", ["done"]);
  expect(both.indexes.map(index => index.name)).toEqual(["by_owner_created", "by_owner_text"]);
  expect(other.indexes.map(index => index.name)).toEqual(["by_owner_created", "by_done"]);
  expect(Object.isFrozen(both)).toBe(true);
  expect(Object.isFrozen(both.indexes)).toBe(true);
  expect(Object.isFrozen(both.indexes[0].fields)).toBe(true);
  expect(() => both.indexes.push({ name: "x", fields: ["owner"], unique: false })).toThrow();

  // The caller's field array is copied: editing it later cannot change the
  // installed definition the server compares on every load.
  const keys = ["owner", "text"];
  const copied = defineTable(todoFields).index("by_keys", keys);
  keys.push("done");
  expect(copied.indexes[0].fields).toEqual(["owner", "text"]);

  const metadata = schemaMetadata(defineSchema({ todos: both }));
  expect(JSON.parse(JSON.stringify(metadata))).toEqual({
    tables: {
      todos: {
        description: both.description,
        indexes: [
          { name: "by_owner_created", fields: ["owner", "created"], unique: false },
          { name: "by_owner_text", fields: ["owner", "text"], unique: true },
        ],
      },
    },
  });
  expect(schemaMetadata(null)).toEqual({ tables: {} });
});

test("index declarations reject bad names, duplicates and invalid field lists", () => {
  const table = defineTable({ ...todoFields, "not-ident": v.string() }).index("by_owner", ["owner"]);
  const cases = [
    [() => table.index("1bad", ["owner"]), "Index name"],
    [() => table.index("by-owner", ["owner"]), "Index name"],
    [() => table.index("", ["owner"]), "Index name"],
    [() => table.index("by_owner", ["text"]), "Duplicate index"],
    // Ordinary and unique indexes share one namespace per table.
    [() => table.unique("by_owner", ["text"]), "Duplicate index"],
    [() => table.index("by_none", []), "at least one field"],
    [() => table.index("by_none", "owner"), "at least one field"],
    [() => table.index("by_missing", ["missing"]), "Undeclared index field"],
    [() => table.index("by_system", ["_creationTime"]), "Undeclared index field"],
    [() => table.index("by_system", ["_id"]), "Undeclared index field"],
    [() => table.index("by_bad_field", ["not-ident"]), "Invalid index field"],
    [() => table.index("by_repeat", ["owner", "text", "owner"]), "Repeated index field"],
  ];
  for (const [declare, message] of cases) expect(declare).toThrow(message);
  // A rejected declaration leaves the table unchanged and still usable.
  expect(table.indexes.map(index => index.name)).toEqual(["by_owner"]);
  expect(table.index("by_text", ["text"]).indexes).toHaveLength(2);
  // Size caps match the server's, which installs indexes outside the JS budget.
  expect(() => table.index("a".repeat(65), ["owner"])).toThrow("longer than 64");
  const wide = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, v.string()]));
  expect(() => defineTable(wide).index("by_all", Object.keys(wide))).toThrow("at most 16 fields");
  let full = defineTable({ owner: v.string() });
  for (let i = 0; i < 32; i++) full = full.index(`by_${i}`, ["owner"]);
  expect(() => full.index("by_32", ["owner"])).toThrow("at most 32 indexes");
  // Index names are per table: two tables may reuse one name.
  expect(() =>
    defineSchema({
      a: defineTable({ x: v.string() }).index("by_x", ["x"]),
      b: defineTable({ x: v.string() }).index("by_x", ["x"]),
    }),
  ).not.toThrow();
});

// The host contract is the payload: eq follows index order, range bounds the
// next field, where stays empty, and order/limit come from the chain.
test("withIndex sends the equality prefix, range bounds, order and limit to the host", async () => {
  const { requests, host } = recordingHost();
  const fn = query({
    args: { owner: v.string(), since: v.number() },
    handler: async (ctx, { owner, since }) => {
      const todos = ctx.db.query("todos");
      await todos.withIndex("by_owner_created", q => q.eq("owner", owner).gt("created", since)).order("desc").take(20);
      await todos.withIndex("by_owner_created", q => q.eq("owner", owner).lte("created", 9).gte("created", 1)).collect();
      await todos.withIndex("by_owner_created", q => q.lt("owner", "m")).first();
      await todos.withIndex("by_owner_text", q => q.eq("owner", owner).eq("text", "x")).collect();
      await todos.withIndex("by_owner_created").collect();
      // Order chosen before withIndex carries over; reusing `todos` does not
      // inherit an earlier chain's index or order.
      await todos.order("desc").withIndex("by_owner_created", q => q.eq("owner", owner)).take(0);
      return null;
    },
  });
  await fn.invoke({ owner: "ann", since: 5 }, host);
  const request = (order, limit, name, eq, range) =>
    ["db.query", { table: "todos", where: [], order, limit, index: { name, eq, range } }];
  expect(requests).toEqual([
    request("desc", 20, "by_owner_created", [{ field: "owner", value: "ann" }], [{ field: "created", operator: "gt", value: 5 }]),
    request("asc", null, "by_owner_created", [{ field: "owner", value: "ann" }], [
      { field: "created", operator: "lte", value: 9 },
      { field: "created", operator: "gte", value: 1 },
    ]),
    request("asc", 1, "by_owner_created", [], [{ field: "owner", operator: "lt", value: "m" }]),
    request("asc", null, "by_owner_text", [{ field: "owner", value: "ann" }, { field: "text", value: "x" }], []),
    request("asc", null, "by_owner_created", [], []),
    request("desc", 0, "by_owner_created", [{ field: "owner", value: "ann" }], []),
  ]);
});

// The SDK rejects invalid chains before any host call, so a bad query cannot
// spend a round trip or reach storage with a half-valid plan.
test("invalid index chains fail in JS before reaching the host", async () => {
  const { requests, host } = recordingHost();
  let foreign;
  const chains = [
    [q => q.withIndex("by_missing"), "Unknown index on todos: by_missing"],
    [q => q.withIndex("by-bad"), "Index name"],
    [q => q.withIndex("by_owner_created", r => r.eq("created", 1)), "leading field order"],
    [q => q.withIndex("by_owner_created", r => r.eq("text", "a")), "leading field order"],
    [q => q.withIndex("by_owner_created", r => r.gt("created", 1)), "after the equality prefix"],
    [q => q.withIndex("by_owner_created", r => r.eq("owner", "a").gt("text", "x")), "after the equality prefix"],
    [q => q.withIndex("by_owner_created", r => r.eq("owner", "a").gt("created", 1).eq("created", 2)), "after an index range"],
    [q => q.withIndex("by_owner_created", r => r.eq("owner", "a").gt("created", 1).gte("created", 2)), "one lower and one upper"],
    [q => q.withIndex("by_owner_created", r => r.eq("owner", "a").lt("created", 1).lte("created", 2)), "one lower and one upper"],
    [q => q.withIndex("by_owner_created", r => r.eq("owner", "a").eq("created", 1).eq("text", "x")), "leading field order"],
    // Values are checked against the declared field validators.
    [q => q.withIndex("by_owner_created", r => r.eq("owner", 1)), "index owner"],
    [q => q.withIndex("by_owner_created", r => r.eq("owner", "a").gt("created", "x")), "index created"],
    [q => q.withIndex("by_owner_created", r => r.eq("owner", "a").gt("created", Infinity)), "index value"],
    [q => q.withIndex("by_owner_created", () => 5), "must return its range builder"],
    [q => q.withIndex("by_owner_created", () => undefined), "must return its range builder"],
    // A builder from a different withIndex call is not this query's range.
    [q => {
      q.withIndex("by_owner_created", r => (foreign = r.eq("owner", "a")));
      return q.withIndex("by_owner_created", () => foreign);
    }, "must return its range builder"],
    [q => q.withIndex("by_owner_created", "owner"), "callback"],
    [q => q.where("owner", "=", "a").withIndex("by_owner_created"), "before any where"],
    [q => q.withIndex("by_owner_created").where("owner", "=", "a"), "where cannot be combined"],
    [q => q.withIndex("by_owner_created").withIndex("by_owner_text"), "selected once"],
  ];
  for (const [chain, message] of chains) {
    const fn = query({ handler: async ctx => { await chain(ctx.db.query("todos")).collect(); return null; } });
    const outcome = await fn.invoke({}, host).then(() => "resolved", error => error.message);
    expect(outcome, `${chain}`).toContain(message);
  }
  expect(requests).toEqual([]);
});

// Bundles without a schema use the loose builder; it cannot know index fields,
// so it forwards them for the host to validate instead of guessing.
test("schema-free builders forward index requests for host validation", async () => {
  const { requests, host } = recordingHost();
  const fn = loose({
    handler: async ctx => {
      await ctx.db.query("todos").withIndex("whatever", q => q.eq("b", 1).gt("a", 2)).collect();
      return null;
    },
  });
  await fn.invoke({}, host);
  expect(requests).toEqual([[
    "db.query",
    {
      table: "todos", where: [], order: "asc", limit: null,
      index: { name: "whatever", eq: [{ field: "b", value: 1 }], range: [{ field: "a", operator: "gt", value: 2 }] },
    },
  ]]);
  // Chain shape (eq after range, where mixing) is still enforced without a schema.
  const bad = loose({ handler: async ctx => ctx.db.query("todos").withIndex("x", q => q.gt("a", 1).eq("b", 2)).collect() });
  await expect(bad.invoke({}, host)).rejects.toThrow("after an index range");
  expect(requests).toHaveLength(1);
});

test("indexed queries keep the document reply checks of ordinary queries", async () => {
  const fn = query({ handler: ctx => ctx.db.query("todos").withIndex("by_owner_created").take(0) });
  await expect(fn.invoke({}, { op: () => [{ _id: "todos:a", _creationTime: 1 }] })).rejects.toThrow("limit");
  const wrong = query({ handler: ctx => ctx.db.query("todos").withIndex("by_owner_created").collect() });
  await expect(wrong.invoke({}, { op: () => [{ _id: "notes:a", _creationTime: 1 }] })).rejects.toThrow("todos:key");
});

// Type checking is part of the API: wrong names, fields, order, value types
// and chaining after a range must be compile errors on the exact line.
test("index chains are checked by the TypeScript compiler", async () => {
  const root = await mkdtemp(join(sdk, "tests/.tmp-"));
  try {
    await mkdir(join(root, "types"));
    for (const name of ["indexes-positive", "indexes-negative"])
      await cp(join(sdk, `tests/fixtures/types/${name}.ts.txt`), join(root, `types/${name}.ts`));
    const project = async (file) => {
      const config = join(root, `${file}.json`);
      await Bun.write(config, JSON.stringify({
        extends: join(workspace, "tsconfig.json"),
        compilerOptions: { paths: { "@tokamak/sdk": [join(sdk, "src/index.ts")] } },
        files: [`types/${file}.ts`],
        include: [],
      }));
      const result = Bun.spawnSync([process.execPath, "check", "--no-script", "--no-pretty", "--project", config], {
        cwd: workspace, stdout: "pipe", stderr: "pipe",
      });
      return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
    };
    const positive = await project("indexes-positive");
    expect(positive.code, positive.output).toBe(0);

    const negative = await project("indexes-negative");
    expect(negative.code, negative.output).not.toBe(0);
    const source = await readFile(join(sdk, "tests/fixtures/types/indexes-negative.ts.txt"), "utf8");
    const lines = source.split("\n").flatMap((line, i) => (line.includes("// reject") ? [i + 1] : []));
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines)
      expect(negative.output, `line ${line}\n${negative.output}`).toMatch(new RegExp(`indexes-negative\\.ts[(:]${line}[,:]`));
    // No diagnostics outside the marked lines: unmarked setup must compile.
    const reported = [...negative.output.matchAll(/indexes-negative\.ts[(:](\d+)[,:]/g)].map(m => Number(m[1]));
    expect(reported.filter(line => !lines.includes(line))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test("tool schemas and validated invocation", async () => {
  const { defineTools, tool, toJsonSchema, mutation } = await import("../src/index.ts");
  expect(toJsonSchema(v.object({
    title: v.string(), count: v.number(), done: v.boolean(), id: v.id("todos"),
    choice: v.union(v.literal("a"), v.literal(null)), optional: v.optional(v.string()),
    items: v.array(v.any()),
  }).description)).toEqual({
    type: "object", additionalProperties: false,
    properties: { title: { type: "string" }, count: { type: "number" }, done: { type: "boolean" },
      id: { type: "string" }, choice: { anyOf: [{ const: "a" }, { const: null }] },
      optional: { type: "string" }, items: { type: "array", items: {} } },
    required: ["title", "count", "done", "id", "choice", "items"],
  });
  const tools = defineTools({ query, mutation }, {
    echo: tool({ description: "Echo", args: { title: v.string() }, view: "card",
      handler: (_ctx, { title }) => ({ result: { title }, summary: "Echoed" }) }),
  });
  const host = { op() { throw new Error("unexpected host call"); } };
  expect(await tools.describe.invoke({}, host)).toMatchObject([{ name: "echo", view: "card" }]);
  await expect(tools.invoke.invoke({ name: "echo", args: { title: 1 }, threadId: "thread" }, host)).rejects.toThrow("args.title: expected string");
  await expect(tools.invoke.invoke({ name: "missing", args: {}, threadId: "thread" }, host)).rejects.toThrow("Unknown tool: missing");
  expect(await tools.invoke.invoke({ name: "echo", args: { title: "hi" }, threadId: "thread" }, host))
    .toEqual({ result: { title: "hi" }, summary: "Echoed", model: '{"title":"hi"}', view: "card" });
});
