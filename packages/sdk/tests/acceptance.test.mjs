// Independent TKM-4 acceptance: exercise public entry points and real build
// artifacts rather than private helpers or a hand-maintained API facsimile.
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, cp, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { query, mutation, v, TokamakClient, createApi } from "../src/index.ts";

const callerHost = { op: () => null };

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(sdk, "../..");
const feature = join(sdk, "tests/fixtures/feature");

function run(command, cwd = workspace, env = {}) {
  // Force compiler diagnostics to stay plain even in Bun's agent environment.
  if (command[1] === "check") command = [...command.slice(0, 2), "--no-pretty", ...command.slice(2)];
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

function succeeds(result) {
  expect(result.output).toBeDefined();
  expect(result.code, result.output).toBe(0);
}

async function temporary(fn) {
  const root = await mkdtemp(join(sdk, "tests/.tmp-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Invalid arguments must fail *before* handler/host side effects, including
// nested paths, strict objects, branded IDs, optional omission, and lossy JSON.
test("argument boundary validates the complete value language before invoking handlers", async () => {
  let calls = 0;
  const host = {
    op() {
      throw new Error("host must not be reached");
    },
  };
  const definition = mutation({
    args: {
      id: v.id("tasks"),
      rows: v.array(v.object({ title: v.string(), done: v.boolean(), priority: v.number() })),
      mode: v.union(v.literal("open"), v.null()),
      note: v.optional(v.string()),
      extra: v.any(),
    },
    handler: (_ctx, args) => {
      calls++;
      return args;
    },
  });
  const valid = {
    id: "tasks:a",
    rows: [{ title: "Ship", done: false, priority: 2 }],
    mode: "open",
    extra: { x: [null, true, 3] },
  };
  expect(await definition.invoke(valid, host)).toEqual(valid);
  expect(await definition.invoke({ ...valid, mode: null, note: "soon" }, host)).toEqual({
    ...valid,
    mode: null,
    note: "soon",
  });
  const invalid = [
    [{ ...valid, id: "projects:a" }, "args.id"],
    [{ ...valid, rows: [{ ...valid.rows[0], priority: "high" }] }, "args.rows[0].priority"],
    [{ ...valid, rows: [{ title: "x", priority: 2 }] }, "args.rows[0].done"],
    [{ ...valid, mode: "closed" }, "args.mode"],
    [{ ...valid, unexpected: true }, "args.unexpected"],
    [{ ...valid, note: undefined }, "args.note"],
    [{ ...valid, extra: Infinity }, "args.extra"],
    [{ ...valid, extra: new Date() }, "args.extra"],
    [{ ...valid, extra: Array(1) }, "args.extra"],
  ];
  for (const [input, path] of invalid) await expect(definition.invoke(input, host)).rejects.toThrow(path);
  expect(calls).toBe(2);

  const empty = query({ handler: (ctx) => ({ writable: "insert" in ctx.db }) });
  expect(await empty.invoke({}, host)).toEqual({ writable: false });
  await expect(empty.invoke({ surprise: true }, host)).rejects.toThrow("unexpected");
});

// Async handlers and transports must see snapshots, not caller-owned mutable
// arguments; non-JSON results must reject instead of silently changing on wire.
test("invocation snapshots arguments and normalizes only void results", async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const fn = query({
    args: { data: v.object({ title: v.string() }) },
    handler: async (_ctx, args) => {
      await wait;
      return args.data;
    },
  });
  const input = { data: { title: "before" } };

  const pending = fn.invoke(input, {
    op() {
      throw new Error("unused");
    },
  });
  input.data.title = "after";
  release();
  expect(await pending).toEqual({ title: "before" });

  for (const result of [undefined, null])
    expect(await query({ handler: async () => result }).invoke({}, callerHost)).toBeNull();
  for (const result of [NaN, { value: undefined }, new Map()]) {
    await expect(query({ handler: () => result }).invoke({}, callerHost)).rejects.toThrow("JSON");
  }
});

// Build the actual feature via moon: a successful synthetic source transform
// alone cannot prove discovery, linked maps, dispatch, or usable UI references.
test("moon bundles one importable ESM feature with canonical CRUD/query dispatch and typed API", async () => {
  succeeds(run(["moon", "run", "sdk:bundle", "--", "packages/sdk/tests/fixtures/feature"]));
  expect((await readdir(join(feature, "dist"))).sort()).toEqual(["bundle.js", "bundle.js.map"]);
  const source = await readFile(join(feature, "dist/bundle.js"), "utf8");
  expect(source).toContain("sourceMappingURL=bundle.js.map");
  expect(new Bun.Transpiler({ loader: "js" }).scan(source).imports).toEqual([]);
  const map = JSON.parse(await readFile(join(feature, "dist/bundle.js.map"), "utf8"));
  expect(map.version).toBe(3);
  expect(map.mappings.length).toBeGreaterThan(0);
  expect(map.sources.some((path) => path.endsWith("tasks.ts"))).toBe(true);
  expect(map.sourcesContent.some((text) => text?.includes("normalizeTitle(args.title)"))).toBe(true);

  const built = await import(pathToFileURL(join(feature, "dist/bundle.js")).href);
  expect(Object.keys(built.functions).sort()).toEqual([
    "nested/views:dashboard",
    "tasks:add",
    "tasks:edit",
    "tasks:get",
    "tasks:noResult",
    "tasks:remove",
    "tasks:replace",
    "tasks:search",
  ]);
  expect(built.schema.tables.tasks.description.fields.done).toEqual({ kind: "boolean" });
  expect(built.metadata.find((entry) => entry.name === "tasks:add")).toMatchObject({
    kind: "mutation",
    args: { kind: "object", fields: { title: { kind: "string" }, priority: { kind: "number" } } },
  });

  const calls = [];
  const row = { _id: "tasks:a", _creationTime: 100, title: "SHIP", done: false, priority: 2 };
  const host = {
    op(name, payload) {
      if (name === "user.current") return { id: "local", name: "You", role: "owner" };
      calls.push([name, payload]);
      if (name === "db.insert") return "tasks:a";
      if (name === "db.get") return payload.id === "tasks:a" ? row : null;
      if (name === "db.query") return payload.limit === 0 ? [] : [row];
      return null;
    },
  };
  const invoke = (name, args = {}) => built.invoke({ name, args }, host);
  expect(await invoke("tasks:add", { title: "  ship ", priority: 2 })).toBe("tasks:a");
  expect(await invoke("tasks:edit", { id: "tasks:a", done: true })).toBeNull();
  expect(await invoke("tasks:replace", { id: "tasks:a", title: "Replacement" })).toBeNull();
  expect(await invoke("tasks:get", { id: "tasks:a" })).toEqual(row);
  expect(await invoke("tasks:get", { id: "tasks:missing" })).toBeNull();
  expect(await invoke("tasks:remove", { id: "tasks:a" })).toBeNull();
  expect(await invoke("tasks:noResult")).toBeNull();
  expect(await invoke("nested/views:dashboard", { done: false, priority: 2 })).toEqual({
    recent: [row],
    first: row,
    all: [row],
    earliest: row,
    empty: [],
  });
  const base = {
    table: "tasks",
    where: [{ field: "done", value: false }],
    order: "asc",
    limit: null,
  };
  const narrow = {
    ...base,
    where: [...base.where, { field: "priority", value: 2 }],
    order: "desc",
  };
  expect(calls).toEqual([
    ["db.insert", { table: "tasks", value: { title: "SHIP", done: false, priority: 2 } }],
    ["db.patch", { id: "tasks:a", value: { done: true } }],
    ["db.replace", { id: "tasks:a", value: { title: "Replacement", done: false, priority: 0 } }],
    ["db.get", { id: "tasks:a" }],
    ["db.get", { id: "tasks:missing" }],
    ["db.delete", { id: "tasks:a" }],
    ["db.query", { ...narrow, limit: 2 }],
    ["db.query", { ...narrow, limit: 1 }],
    ["db.query", base],
    ["db.query", { ...base, limit: 1 }],
    ["db.query", { ...base, limit: 0 }],
  ]);

  const before = calls.length;
  await expect(invoke("tasks:add", { title: 42, priority: 2 })).rejects.toThrow("args.title");
  await expect(invoke("tasks:absent")).rejects.toThrow("Unknown function");
  expect(calls).toHaveLength(before);
  expect(
    await built.invoke({ name: "tasks:search", args: { done: false, priority: 2 } }, { op: () => [] }),
  ).toEqual({ recent: [], first: null, all: [], earliest: null, empty: [] });

  // Consume the generated runtime reference too: a UI call must arrive at the
  // bundled dispatcher without importing backend handlers into the reference.
  const apiSource = await readFile(join(feature, "_generated/api.ts"), "utf8");
  expect(new Bun.Transpiler({ loader: "ts" }).scan(apiSource).imports.map((item) => item.path)).toEqual([
    "@tokamak/sdk",
  ]);
  const { api } = await import(pathToFileURL(join(feature, "_generated/api.ts")).href);

  const client = new TokamakClient({
    query: (name, args) => built.invoke({ name, args }, host),
    mutation: (name, args) => built.invoke({ name, args }, host),
  });
  const inserted = await client.mutation(api.tasks.add, { title: "  integration ", priority: 3 });
  expect(inserted).toBe("tasks:a");
  expect(await client.query(api.tasks.get, { id: inserted })).toEqual(row);
  expect(calls.slice(-2)).toEqual([
    ["db.insert", { table: "tasks", value: { title: "INTEGRATION", done: false, priority: 3 } }],
    ["db.get", { id: "tasks:a" }],
  ]);

  await temporary(async (root) => {
    // Keep generated imports relative to an unchanged feature layout.
    await cp(feature, join(root, "feature"), { recursive: true });
    await mkdir(join(root, "types"));
    await cp(join(sdk, "tests/fixtures/types/positive.ts.txt"), join(root, "types/positive.ts"));
    const negative = await readFile(join(sdk, "tests/fixtures/types/negative.ts.txt"), "utf8");
    await writeFile(join(root, "types/negative.ts"), negative);
    const config = (files) =>
      JSON.stringify({
        extends: join(workspace, "tsconfig.json"),
        compilerOptions: { paths: { "@tokamak/sdk": [join(sdk, "src/index.ts")] } },
        files,
        include: [],
      });
    await writeFile(join(root, "positive.json"), config(["types/positive.ts"]));
    succeeds(run([process.execPath, "check", "--no-script", "--project", join(root, "positive.json")]));
    await writeFile(join(root, "negative.json"), config(["types/negative.ts"]));
    const result = run([process.execPath, "check", "--no-script", "--project", join(root, "negative.json")]);
    expect(result.code, result.output).not.toBe(0);
    const lines = negative.split("\n").flatMap((line, i) => (line.includes("// reject") ? [i + 1] : []));
    for (const line of lines)
      expect(result.output, result.output).toMatch(new RegExp(`negative\\.ts[(:]${line}[,:]`));
  });
}, 120000);

// Malformed host replies and invalid database plans must fail at the boundary;
// otherwise SDK types would promise documents/IDs while leaking corrupt data.
test("database boundary rejects invalid plans, reserved writes, and malformed host replies", async () => {
  const requests = [];
  const forbidden = {
    op(name, payload) {
      requests.push([name, payload]);
      throw new Error("unexpected host operation");
    },
  };
  for (const handler of [
    (ctx) => ctx.db.query("tasks").take(-1),
    (ctx) => ctx.db.query("tasks").take(1.5),
    (ctx) => ctx.db.query("tasks").order("random").collect(),
    (ctx) => ctx.db.query("tasks").where("done", ">", false).collect(),
    (ctx) => ctx.db.get("not-an-id"),
    (ctx) => ctx.db.insert("tasks", { _id: "tasks:owned", title: "x" }),
    (ctx) => ctx.db.patch("tasks:a", { _creationTime: 1 }),
  ])
    await expect(mutation({ handler }).invoke({}, forbidden)).rejects.toThrow();
  expect(requests).toEqual([]);

  const cases = [
    [(ctx) => ctx.db.get("tasks:a"), { _id: "tasks:b", _creationTime: 1 }, "wrong id"],
    [(ctx) => ctx.db.query("tasks").collect(), [{ _id: "projects:a", _creationTime: 1 }], "tasks:key"],
    [(ctx) => ctx.db.query("tasks").collect(), [{ _id: "tasks:a" }], "_creationTime"],
    [(ctx) => ctx.db.query("tasks").collect(), null, "array"],
    [(ctx) => ctx.db.query("tasks").take(0), [{ _id: "tasks:a", _creationTime: 1 }], "limit"],
    [(ctx) => ctx.db.insert("tasks", { title: "x" }), "projects:a", "tasks:key"],
    [(ctx) => ctx.db.patch("tasks:a", { done: true }), {}, "null"],
    [(ctx) => ctx.db.replace("tasks:a", { title: "x" }), false, "null"],
    [(ctx) => ctx.db.delete("tasks:a"), "ok", "null"],
  ];

  for (const [handler, reply, message] of cases) {
    await expect(mutation({ handler }).invoke({}, { op: async () => reply })).rejects.toThrow(message);
  }
  await expect(
    query({ handler: (ctx) => ctx.db.get("tasks:a") }).invoke(
      {},
      {
        op: async () => {
          throw new Error("transaction expired");
        },
      },
    ),
  ).rejects.toThrow("transaction expired");
});

// The SDK must not assume transport completion order or swallow errors. Teardown
// must suppress both queued microtasks and events synchronously emitted by stop.
test("injected client routes calls, preserves transport delivery order, and closes subscriptions once", async () => {
  const api = createApi();
  const pending = [];
  const events = [];
  let deliver,
    stopped = 0;
  const captured = [];
  const client = new TokamakClient({
    query(name, args) {
      captured.push(["query", name, args]);
      return new Promise((resolve) => pending.push(resolve));
    },
    async mutation(name, args) {
      captured.push(["mutation", name, args]);
      return "tasks:a";
    },
    subscribe(name, args, callback) {
      captured.push(["subscribe", name, args]);
      deliver = callback;
      callback({ value: ["initial"] });
      return () => {
        stopped++;
        callback({ value: ["during stop"] });
      };
    },
  });

  const args = { title: "before" };
  const first = client.query(api.tasks.get, args);
  args.title = "after";
  const second = client.query(api.tasks.get, { title: "second" });
  pending[1]("second");
  expect(await second).toBe("second");
  pending[0]("first");
  expect(await first).toBe("first");
  expect(await client.mutation(api.tasks.add, { title: "write" })).toBe("tasks:a");
  const stop = client.subscribe(api.nested.views.dashboard, { done: false }, (event) => events.push(event));

  deliver({ value: ["second update"] });
  deliver({ value: ["first update arriving late"] });
  const error = new Error("connection lost");
  deliver({ error });
  deliver({ value: undefined });
  queueMicrotask(() => deliver({ value: ["queued"] }));
  stop();
  stop();
  deliver({ error: new Error("late") });
  await Promise.resolve();

  expect(stopped).toBe(1);
  expect(events.slice(0, 4)).toEqual([
    { value: ["initial"] },
    { value: ["second update"] },
    { value: ["first update arriving late"] },
    { error },
  ]);
  expect(events).toHaveLength(5);
  expect(events[4].error).toBeInstanceOf(Error);
  expect(captured).toEqual([
    ["query", "tasks:get", { title: "before" }],
    ["query", "tasks:get", { title: "second" }],
    ["mutation", "tasks:add", { title: "write" }],
    ["subscribe", "nested/views:dashboard", { done: false }],
  ]);
  await expect(client.query(api.tasks.get, { bad: undefined })).rejects.toThrow("JSON");
  expect(captured).toHaveLength(4);
  const bad = new TokamakClient({ query: async () => Infinity, mutation: async () => new Date() });
  await expect(bad.query(api.tasks.get, {})).rejects.toThrow("JSON");
  await expect(bad.mutation(api.tasks.add, {})).rejects.toThrow("JSON");
});

// The default source contract uses extensionless imports. Bundle checking and
// a generated-API consumer must agree: both accept extensionless schema imports
// and reject explicit .ts imports without a matching compiler opt-in.
test("bundle and generated API consumer consistently enforce default schema import contract", async () => {
  await temporary(async (root) => {
    await writeFile(
      join(root, "schema.ts"),
      `
      import { defineSchema, defineTable, v } from '@tokamak/sdk';
      export default defineSchema({ tasks: defineTable({ title: v.string() }) });
    `,
    );
    const tasksSource = `
      import { createFunctions } from '@tokamak/sdk';
      import schema from './schema';
      const { query } = createFunctions(schema);
      export const list = query({ handler: ctx => ctx.db.query('tasks').collect() });
    `;
    await writeFile(join(root, "tasks.ts"), tasksSource);
    succeeds(run(["moon", "run", "sdk:bundle", "--", relative(workspace, root)]));

    const built = await import(pathToFileURL(join(root, "dist/bundle.js")).href);
    expect(await built.invoke({ name: "tasks:list", args: {} }, { op: () => [] })).toEqual([]);

    // This consumer is excluded from backend discovery and needs no special
    // compilerOptions or hand-maintained replacement for the generated API.
    await mkdir(join(root, "_ui"));
    await writeFile(
      join(root, "_ui/consumer.ts"),
      `
      import { TokamakClient } from '@tokamak/sdk';
      import { api } from '../_generated/api';
      declare const client: TokamakClient;
      async function readTitles(): Promise<string[]> {
        const rows = await client.query(api.tasks.list, {});
        return rows.map(row => row.title);
      }
      export { readTitles };
    `,
    );
    await writeFile(
      join(root, "consumer.json"),
      JSON.stringify({
        extends: join(workspace, "tsconfig.json"),
        files: ["_ui/consumer.ts"],
        include: [],
      }),
    );
    const checkConsumer = () =>
      run([process.execPath, "check", "--no-script", "--project", join(root, "consumer.json")]);
    succeeds(checkConsumer());
    await writeFile(join(root, "tasks.ts"), tasksSource.replace("'./schema'", "'./schema.ts'"));
    const bundleResult = run(["moon", "run", "sdk:bundle", "--", relative(workspace, root)]);
    const consumerResult = checkConsumer();
    expect(bundleResult.code, bundleResult.output).not.toBe(0);
    expect(bundleResult.output).toContain("TS5097");
    expect(consumerResult.code, consumerResult.output).not.toBe(0);
    expect(consumerResult.output).toContain("TS5097");
  });
}, 120000);

// Adding the SDK resolution must preserve aliases inherited by a feature's
// tsconfig; typechecking and bundling must agree on the imported helper module.
test("feature bundling preserves inherited tsconfig helper aliases alongside SDK resolution", async () => {
  await temporary(async (root) => {
    await mkdir(join(root, "_helpers"));
    await writeFile(
      join(root, "_helpers/title.ts"),
      "export const title = (value: string) => value.trim().toUpperCase();\n",
    );
    await writeFile(
      join(root, "base.json"),
      JSON.stringify({
        extends: join(workspace, "tsconfig.json"),
        compilerOptions: { paths: { "@helpers/*": ["./_helpers/*"] } },
      }),
    );
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: "./base.json" }));
    await writeFile(
      join(root, "tasks.ts"),
      `
      import { query, v } from '@tokamak/sdk';
      import { title } from '@helpers/title';
      export const display = query({ args: { text: v.string() }, handler: (_ctx, args) => title(args.text) });
    `,
    );
    succeeds(run([process.execPath, "check", "--no-script", "--project", join(root, "tsconfig.json")]));
    succeeds(run(["moon", "run", "sdk:bundle", "--", relative(workspace, root)]));

    const built = await import(pathToFileURL(join(root, "dist/bundle.js")).href);
    expect(Object.keys(built.functions)).toEqual(["tasks:display"]);
    expect(await built.invoke({ name: "tasks:display", args: { text: "  ship  " } }, callerHost)).toBe(
      "SHIP",
    );
  });
}, 120000);

// A transport may deliver its initial event before returning stop. If the UI
// throws during that callback, the SDK must still obtain stop, tear down once,
// ignore reentrant/late delivery, and only then propagate the original error.
test("synchronous initial subscriber failure cleans acquired transport listener before throwing", () => {
  const api = createApi();
  const failure = new Error("UI initial render failed");
  let deliver,
    listeners = 0,
    stops = 0,
    callbacks = 0;
  const steps = [];
  const client = new TokamakClient({
    subscribe(_name, _args, callback) {
      listeners++;
      deliver = callback;
      callback({ value: ["initial"] });
      steps.push("transport returned stop");
      return () => {
        stops++;
        listeners--;
        steps.push("stopped");
        callback({ value: ["reentrant stop event"] });
      };
    },
  });

  let caught;
  try {
    client.subscribe(api.tasks.list, {}, () => {
      callbacks++;
      throw failure;
    });
  } catch (error) {
    caught = error;
    steps.push("caller caught");
  }

  // Check cleanup first so this regression reports the leaked listener directly.
  expect(listeners).toBe(0);
  expect(stops).toBe(1);
  expect(caught).toBe(failure);
  expect(steps).toEqual(["transport returned stop", "stopped", "caller caught"]);
  expect(() => deliver({ value: ["late value"] })).not.toThrow();
  expect(() => deliver({ error: new Error("late transport failure") })).not.toThrow();
  expect(callbacks).toBe(1);
});

// Type-only imports vanish from Bun's runtime import scan, but still pull
// triple-slash ambient libraries into the compiler. The real source guard must
// reject this leak instead of silently authorizing fetch inside QuickJS source.
test("source guard rejects external type-only declaration imports that enable DOM globals", async () => {
  await temporary(async (root) => {
    await cp(join(sdk, "src"), join(root, "src"), { recursive: true });
    await cp(join(sdk, "tools"), join(root, "tools"), { recursive: true });
    for (const name of ["tsconfig.json", "tsconfig.runtime.json"]) {
      const config = JSON.parse(await readFile(join(sdk, name), "utf8"));
      config.extends = join(workspace, "tsconfig.json");
      await writeFile(join(root, name), JSON.stringify(config));
    }

    const check = () => run([process.execPath, join(root, "tools/check.mjs")], root);
    succeeds(check());
    await writeFile(
      join(root, "tools/tool-types.d.ts"),
      '/// <reference lib="dom" />\nexport interface ToolOptions { label?: string }\n',
    );
    await writeFile(
      join(root, "src/portability-probe.ts"),
      `
      import type { ToolOptions } from '../tools/tool-types.d.ts';
      export const options: ToolOptions = {};
      export const leak = fetch;
    `,
    );
    const result = check();
    expect(result.code, result.output).not.toBe(0);
  });
}, 120000);

// Portability is an automated source rule, not just a convention: check an
// isolated real checker even when included TypeScript tests enable DOM ambient
// declarations. A .mjs test would not participate in this TypeScript project.
test("SDK source checker rejects Node, Bun, browser and external runtime imports", async () => {
  await temporary(async (root) => {
    await cp(join(sdk, "src"), join(root, "src"), { recursive: true });
    await cp(join(sdk, "tools"), join(root, "tools"), { recursive: true });
    for (const name of ["tsconfig.json", "tsconfig.runtime.json"]) {
      const config = JSON.parse(await readFile(join(sdk, name), "utf8"));
      config.extends = join(workspace, "tsconfig.json");
      await writeFile(join(root, name), JSON.stringify(config));
    }
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests/ambient.test.ts"), '/// <reference lib="dom" />\nexport {};\n');

    const check = () => run([process.execPath, join(root, "tools/check.mjs")], root);
    succeeds(check());
    for (const [source, diagnostic] of [
      ["export const leak = process.pid;", "process"],
      ["export const leak = Bun.version;", "Bun"],
      ["export const leak = window.location;", "window"],
      ['export const leak = fetch("https://example.invalid");', "fetch"],
      ['import { readFile } from "node:fs/promises"; export { readFile };', "node:fs/promises"],
    ]) {
      await writeFile(join(root, "src/portability-probe.ts"), source);
      const result = check();
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(diagnostic);
    }
  });
}, 120000);

// Agent environment auto-formatting must not hide negative fixture locations;
// every rejected API misuse still needs a stable, machine-readable diagnostic.
test("negative type diagnostics retain all source locations in agent environments", async () => {
  await temporary(async (root) => {
    await cp(feature, join(root, "feature"), { recursive: true });
    succeeds(run(["moon", "run", "sdk:bundle", "--", relative(workspace, join(root, "feature"))]));
    await mkdir(join(root, "types"));
    const negative = await readFile(join(sdk, "tests/fixtures/types/negative.ts.txt"), "utf8");
    await writeFile(join(root, "types/negative.ts"), negative);
    await writeFile(
      join(root, "negative.json"),
      JSON.stringify({
        extends: join(workspace, "tsconfig.json"),
        compilerOptions: { paths: { "@tokamak/sdk": [join(sdk, "src/index.ts")] } },
        files: ["types/negative.ts"],
        include: [],
      }),
    );
    const result = run(
      [process.execPath, "check", "--no-script", "--project", join(root, "negative.json")],
      workspace,
      { CLAUDECODE: "1", AI_AGENT: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
    );
    expect(result.code, result.output).not.toBe(0);
    for (const [index, line] of negative.split("\n").entries()) {
      if (line.includes("// reject"))
        expect(result.output, result.output).toMatch(new RegExp(`negative\\.ts[(:]${index + 1}[,:]`));
    }
  });
}, 120000);

// The shipped SDK checker must also keep stable diagnostics when an agent
// launches it; the test helper's compiler flags cannot repair this subprocess.
test("SDK checker reports plain source diagnostics in agent environments", async () => {
  await temporary(async (root) => {
    await cp(join(sdk, "src"), join(root, "src"), { recursive: true });
    await cp(join(sdk, "tools"), join(root, "tools"), { recursive: true });
    for (const name of ["tsconfig.json", "tsconfig.runtime.json"]) {
      const config = JSON.parse(await readFile(join(sdk, name), "utf8"));
      config.extends = join(workspace, "tsconfig.json");
      await writeFile(join(root, name), JSON.stringify(config));
    }
    await writeFile(join(root, "src/diagnostic-probe.ts"), "export const value: string = 42;\n");
    const result = run([process.execPath, join(root, "tools/check.mjs")], root, {
      CLAUDECODE: "1",
      AI_AGENT: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    });
    expect(result.code, result.output).not.toBe(0);
    expect(result.output, result.output).toMatch(/diagnostic-probe\.ts[(:]1[,:].*TS2322/);
  });
}, 120000);
