// Public-builder fixtures shared by compiler and real socket/native regressions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const workspace = fileURLToPath(new URL("../../", import.meta.url));
export async function source(root, id, code, options = { backend: false }) {
  const path = resolve(root, id);
  await mkdir(resolve(path, "src"), { recursive: true });
  try {
    await symlink(resolve(workspace, "app/node_modules"), resolve(path, "node_modules"), "dir");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await writeFile(
    resolve(path, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", type: "module" }),
  );
  await writeFile(
    resolve(path, "tsconfig.json"),
    JSON.stringify({ extends: resolve(workspace, "app/tsconfig.json"), include: ["src"] }),
  );
  await writeFile(
    resolve(path, "vite.config.ts"),
    `import { tokamak } from "@tokamak/build/vite"; export default { plugins: [tokamak(${JSON.stringify(options)})] };`,
  );
  await writeFile(resolve(path, "src/main.tsx"), code);
  return path;
}
export function build(path) {
  const result = spawnSync(process.execPath, [resolve(workspace, "packages/build/src/build.ts"), path], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}
export function built(path) {
  const result = build(path);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
export async function library(root, version = "before") {
  const path = await source(
    root,
    "library",
    `
    import { createSignal } from "solid-js";
    export const [shared, setShared] = createSignal(0);
    export const ready = "library-ready";
    export function Counter() { return <button id="shared-increment" onClick={() => setShared(n => n + 1)}>library-${version}: {shared()}</button>; }
  `,
  );
  built(path);
}
export async function fixtures(root) {
  const logic = await source(root, "logic", "", { ui: false });
  await cp(resolve(workspace, "app/tests/fixtures/record/backend"), resolve(logic, "backend"), {
    recursive: true,
    filter: (path) => !/\/(dist|_generated)(\/|$)/.test(path),
  });
  await writeFile(
    resolve(logic, "backend/tsconfig.json"),
    JSON.stringify({
      extends: resolve(workspace, "app/backend/tsconfig.json"),
      include: ["**/*.ts"],
      exclude: ["dist"],
    }),
  );
  built(logic);
  await library(root);
  built(
    await source(
      root,
      "dormant",
      'export function Unused() { throw new Error("backend dependency UI must stay lazy"); }',
    ),
  );
  built(
    await source(
      root,
      "consumer",
      `
    import { createSignal } from "solid-js";
    import { view } from "@tokamak/sdk";
    import { useClient, useQuery } from "@tokamak/sdk/solid";
    import { useRouter } from "@tokamak/runtime/router";
    import { Counter, shared, ready } from "@plugins/library/ui";
    import { api } from "../../logic/backend/_generated/api";
    if (ready !== "library-ready") throw new Error("dependency initialized out of order");
    export const Consumer = view({ route: "/" }, () => {
      const [local, setLocal] = createSignal(10);
      const router = useRouter();
      const client = useClient();
      const rows = useQuery(client, api.record.list, () => ({}));
      return <div>
        <input id="local-input" value="" />
        <Counter /><p id="shared-observer">observed: {shared()}</p>
        <button id="local-increment" onClick={() => setLocal(n => n + 1)}>local: {local()}</button>
        <p id="live-data">{JSON.stringify(rows.data())}</p>
        <button id="add-row" onClick={() => client.mutation(api.record.add, { title: "live-row" })}>Add row</button>
        <button id="thread-route" onClick={() => router.navigate("/chat/thread-one")}>Thread</button>
        <button id="nested-route" onClick={() => router.navigate("/p/consumer/detail/one")}>Nested</button>
      </div>;
    });
    export const Nested = view({ route: "/detail/*rest" }, () => <p id="nested">Nested route</p>);
  `,
      { backend: false, plugin: { id: "consumer", version: "1.0.0", depends: { logic: "*", dormant: "*" } } },
    ),
  );
  built(
    await source(
      root,
      "broken",
      `import { view } from "@tokamak/sdk";
    import { shared } from "@plugins/library/ui";
    export const Broken = view({ route: "/" }, () => {
      if (shared() === 0) throw new Error("intentional contribution failure");
      return <p id="recovered">Recovered contribution</p>;
    });`,
    ),
  );
}

async function errors(root) {
  await library(root);
  built(
    await source(
      root,
      "healthy",
      `
    import { view } from "@tokamak/sdk";
    import { Counter } from "@plugins/library/ui";
    export const Healthy = view({ route: "/" }, () => <Counter />);
  `,
    ),
  );
  for (const kind of ["event", "async", "effect", "factory"]) {
    built(
      await source(
        root,
        `error-${kind}`,
        `
      import { createSignal, createEffect } from "solid-js";
      import { view } from "@tokamak/sdk";
      const [trigger, setTrigger] = createSignal(false);
      ${kind === "factory" ? 'createEffect(() => { if (trigger()) throw new Error("factory-owned failure"); });' : ""}
      export const Failure = view({ route: "/" }, () => {
        ${kind === "effect" ? 'createEffect(() => { if (trigger()) throw new Error("effect-owned failure"); });' : ""}
        return <button id="throw-${kind}" onClick={() => {
          ${
            kind === "event"
              ? 'throw new Error("event-owned failure");'
              : kind === "async"
                ? 'void (async () => { await Promise.resolve(); throw new Error("async-owned failure"); })();'
                : "setTrigger(true);"
          }
        }}>Throw ${kind}</button>;
      });
    `,
      ),
    );
  }
}

// `generation` is part of the emitted code, so a second call produces a
// genuinely different artifact: reloading an unchanged artifact is a no-op and
// emits no change notice, which would leave the retirement path untested.
async function guards(root, generation = 1) {
  built(
    await source(
      root,
      "vault",
      `
    let original: any;
    export const remember = (handle: any) => { original ??= handle; return original; };
  `,
    ),
  );
  built(
    await source(
      root,
      "guard",
      `
    import { createSignal } from "solid-js";
    import { view } from "@tokamak/sdk";
    import { remember } from "@plugins/vault/ui";
    const capability = (globalThis as any).__tokamakModules;
    const original = remember(capability);
    export const generation = ${generation};
    const [count, setCount] = createSignal(0);
    export const Guard = view({ route: "/" }, () => {
      const [status, setStatus] = createSignal("ready");
      const probe = async () => {
        const rejected: string[] = [];
        for (const name of ["@plugins/vault/ui", "solid-js", "@tokamak/sdk"]) {
          try { capability.register(name, [], (_r: any, exports: any) => { exports.poisoned = true; }); }
          catch (error) { if (String(error).includes("Unexpected plugin registration")) rejected.push(name); }
        }
        if (capability.provide || capability.remove || capability.require) throw new Error("host registry administration leaked");
        let retired = "current";
        if (original !== capability) {
          try { await original.load("@plugins/vault/ui"); }
          catch (error) { retired = String(error); }
        }
        setStatus(rejected.join(",") + ":" + retired);
      };
      return <div><button id="guard-probe" onClick={() => { void probe(); }}>Probe registration</button>
        <button id="guard-count" onClick={() => setCount(n => n + 1)}>state: {count()}</button>
        <p id="guard-status">{status()}</p></div>;
    });
  `,
    ),
  );
}

async function lazy(root) {
  await library(root);
  built(
    await source(
      root,
      "lazy",
      `
    import { createSignal } from "solid-js";
    import { view } from "@tokamak/sdk";
    export const Lazy = view({ route: "/" }, () => {
      const [component, setComponent] = createSignal<any>();
      return <div><button id="lazy-load" onClick={async () => {
        const module = await import("@plugins/library/ui");
        setComponent(() => module.Counter);
      }}>Load library</button>{component() && component()({})}</div>;
    });
  `,
    ),
  );
}

// One backend serves the payload, wire-limit and subscription-growth views.
// `bytes` builds a result of an exact size; `rows` holds large user data.
async function payloadBackend(root) {
  const backend = await source(root, "payload", "", { ui: false });
  await mkdir(resolve(backend, "backend"), { recursive: true });
  await writeFile(
    resolve(backend, "backend/tsconfig.json"),
    JSON.stringify({
      extends: resolve(workspace, "app/backend/tsconfig.json"),
      include: ["**/*.ts"],
    }),
  );
  await writeFile(
    resolve(backend, "backend/schema.ts"),
    `
    import { defineSchema, defineTable, v } from "@tokamak/sdk";
    export default defineSchema({ values: defineTable({ size: v.number() }), rows: defineTable({ text: v.string() }) });
  `,
  );
  await writeFile(
    resolve(backend, "backend/ops.ts"),
    `
    import { createFunctions, v } from "@tokamak/sdk";
    import schema from "./schema";
    const { query, mutation } = createFunctions(schema);
    export const bytes = query({ args: { size: v.number() }, handler: (_ctx, { size }) => "x".repeat(size) });
    export const all = query({ args: {}, handler: ({ db }) => db.query("rows").collect() });
    export const grow = mutation({ args: { size: v.number() }, handler: ({ db }, { size }) => db.insert("rows", { text: "x".repeat(size) }) });
    export const clear = mutation({ args: {}, handler: async ({ db }) => { for (const row of await db.query("rows").collect()) await db.delete(row._id); } });
  `,
  );
  built(backend);
}

async function payload(root) {
  await payloadBackend(root);
  built(
    await source(
      root,
      "payload-view",
      `
    import { createSignal } from "solid-js";
    import { view } from "@tokamak/sdk";
    import { useClient } from "@tokamak/sdk/solid";
    import { api } from "../../payload/backend/_generated/api";
    // The test host also publishes a client on the raw transport (no query
    // cache): replaying a cached terminal error would hide leaked wire capacity.
    const wire = () => (globalThis as any).__tokamakTestWireClient;
    export const Payload = view({ route: "/" }, () => {
      const client = useClient();
      const [status, setStatus] = createSignal("idle");
      const run = async () => {
        const medium = await client.query(api.ops.bytes, { size: 100_000 });
        if (medium !== "x".repeat(100_000)) throw new Error("100KB result corrupted");
        let failure = "";
        try { await client.query(api.ops.bytes, { size: 1_100_000 }); }
        catch (error) { failure = String(error); }
        if (!failure.includes("result too large")) throw new Error("missing oversized query error: " + failure);
        // More than the 128-slot client limit proves terminal errors release
        // subscription capacity; each await also bounds native event pressure.
        for (let i = 0; i < 130; i++) {
          await new Promise<void>((resolve, reject) => {
            wire().subscribe(api.ops.bytes, { size: 1_100_000 }, (event: any) => {
              if ("error" in event && event.error.message.includes("result too large")) resolve();
              else reject(new Error("missing oversized subscription error"));
            });
          });
        }
        const later = await client.query(api.ops.bytes, { size: 7 });
        setStatus(medium.length + ":" + failure + ":130:" + later);
      };
      return <div><button id="payload-run" onClick={() => { void run().catch(e => setStatus("FAILED: " + e)); }}>Run payloads</button>
        <p id="payload-status">{status()}</p></div>;
    });
    // The serialized response event is {"type":"response","id":N,"result":{"Ok":"..."}}:
    // 44 bytes plus the digits of N plus the string. After a 120-call warm-up every
    // id has three digits, so a 1_048_529-byte string is an event of exactly
    // 1_048_576 bytes. The Rust test recomputes the sizes from the observed ids.
    const EXACT = 1_048_576 - 44 - 3;
    export const Boundary = view({ route: "/boundary" }, () => {
      const client = useClient();
      const [status, setStatus] = createSignal("idle");
      const run = async () => {
        for (let i = 0; i < 120; i++) await client.query(api.ops.bytes, { size: 1 });
        const exact = await client.query(api.ops.bytes, { size: EXACT });
        let over = "";
        try { await client.query(api.ops.bytes, { size: EXACT + 1 }); over = "delivered"; }
        catch (error) { over = String(error); }
        const later = await client.query(api.ops.bytes, { size: 7 });
        setStatus((exact as string).length + "|" + over + "|" + later);
      };
      return <div><button id="boundary-run" onClick={() => { void run().catch(e => setStatus("FAILED: " + e)); }}>Run boundary</button>
        <p id="boundary-status">{status()}</p></div>;
    });
  `,
      { backend: false, plugin: { id: "payload-view", version: "1.0.0", depends: { payload: "*" } } },
    ),
  );
}

// A live query whose result grows past the wire limit mid-subscription. The
// controls live in the same plugin but a separate contribution, so they stay
// mounted (and usable) while the Growth contribution shows its error card.
async function growth(root) {
  await payloadBackend(root);
  built(
    await source(
      root,
      "growth-view",
      `
    import { createSignal } from "solid-js";
    import { view } from "@tokamak/sdk";
    import { useClient, useQuery } from "@tokamak/sdk/solid";
    import { api } from "../../payload/backend/_generated/api";
    export const Growth = view({ route: "/" }, () => {
      const client = useClient();
      const rows = useQuery(client, api.ops.all, () => ({}));
      const text = () => {
        const error = rows.error();
        if (error) throw error;
        const data = rows.data();
        return data === undefined ? "loading" : "rows:" + data.length;
      };
      return <p id="growth-rows">{text()}</p>;
    });
    export const Controls = view({ route: "/controls" }, () => {
      const client = useClient();
      // Mutations resolve only after commit; the log lets a test wait for that
      // instead of racing the next subscription against an uncommitted clear.
      const [log, setLog] = createSignal("");
      const mutate = async (name: string, run: () => Promise<unknown>) => { await run(); setLog(name); };
      return <div>
        <button id="growth-grow" onClick={() => { void mutate("grown", () => client.mutation(api.ops.grow, { size: 600_000 })); }}>Grow</button>
        <button id="growth-clear" onClick={() => { void mutate("cleared", () => client.mutation(api.ops.clear, {})); }}>Clear</button>
        <p id="growth-log">{log()}</p>
      </div>;
    });
  `,
      { backend: false, plugin: { id: "growth-view", version: "1.0.0", depends: { payload: "*" } } },
    ),
  );
}

// A plugin that allocates without bound next to a healthy plugin. The loop stops
// at ~1.5 GB so that, if the window heap ceiling regresses, the test fails with
// a clear message instead of exhausting the machine.
async function heap(root) {
  await library(root);
  built(
    await source(
      root,
      "healthy",
      `
    import { view } from "@tokamak/sdk";
    import { Counter } from "@plugins/library/ui";
    export const Healthy = view({ route: "/" }, () => <Counter />);
  `,
    ),
  );
  built(
    await source(
      root,
      "hog",
      `
    import { createSignal } from "solid-js";
    import { view } from "@tokamak/sdk";
    const [report, setReport] = createSignal("untouched");
    export const Hog = view({ route: "/" }, () => <button id="hog-run" onClick={() => {
      const hoard: number[][] = [];
      try {
        for (let i = 0; i < 750; i++) hoard.push(new Array(125_000).fill(1));
        setReport("NO CEILING: allocated " + hoard.length + " arrays");
      } catch (error) {
        // Release the heap first: reporting itself needs a little memory.
        hoard.length = 0;
        setReport(String(error));
        throw error;
      }
    }}>Allocate</button>);
    export const Report = view({ route: "/report" }, () => <p id="hog-report">{report()}</p>);
  `,
    ),
  );
}

// A declared UI asset far larger than the old 64 MiB window heap. Its content
// mixes 1-, 2-, 3- and 4-byte UTF-8 characters, so 8 KiB page boundaries split
// characters; the view downloads it through the shell's own transport and
// compares it with an independently generated copy, so any dropped, duplicated
// or reordered chunk shows up as "corrupt". The asset is the source map: it is
// hash-verified and served exactly like code and CSS, but never compiled or
// injected into the document, so this isolates transfer from evaluation.
const BULK_UNIT = "aé€😀-"; // 11 UTF-8 bytes, 6 UTF-16 code units
const BULK_BYTES = 100_000_000;
async function bulk(root) {
  await payloadBackend(root); // supplies a tiny query used to yield between slices
  const repeats = Math.ceil(BULK_BYTES / 11);
  const path = await source(
    root,
    "bulk",
    `
    import { createSignal } from "solid-js";
    import { view } from "@tokamak/sdk";
    import { useClient } from "@tokamak/sdk/solid";
    import { api } from "../../payload/backend/_generated/api";
    export const Bulk = view({ route: "/" }, () => {
      const [status, setStatus] = createSignal("idle");
      const client = useClient();
      const run = async () => {
        const text: string = await (globalThis as any).__tokamakTestAsset("bulk", "ui.js.map");
        // A native UI turn has a 250 ms budget and promise continuations share
        // it until the queue drains. Compare in slices, yielding to a real server
        // round trip (a new turn) between slices, so verification never trips the
        // turn deadline that the 100 MB download itself must not need.
        const slice = ${JSON.stringify(BULK_UNIT)}.repeat(100_000);
        let intact = text.length === ${repeats} * ${JSON.stringify(BULK_UNIT)}.length;
        for (let at = 0; intact && at < text.length; at += slice.length) {
          intact = text.slice(at, at + slice.length) === slice.slice(0, Math.min(slice.length, text.length - at));
          await client.query(api.ops.bytes, { size: 1 });
        }
        setStatus((intact ? "intact:" : "corrupt:") + text.length);
      };
      return <div><button id="bulk-run" onClick={() => { void run().catch(e => setStatus("FAILED: " + e)); }}>Download</button>
        <p id="bulk-status">{status()}</p></div>;
    });
  `,
    { backend: false, plugin: { id: "bulk", version: "1.0.0", depends: { payload: "*" } } },
  );
  built(path);
  const mapPath = resolve(path, "dist/ui.js.map"),
    manifestPath = resolve(path, "dist/manifest.json");
  const blob = BULK_UNIT.repeat(repeats);
  assert.ok(Buffer.byteLength(blob) > BULK_BYTES, "bulk UI asset is smaller than 100 MB");
  await writeFile(mapPath, blob);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.hashes["ui.js.map"] = createHash("sha256").update(blob).digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest));
}

async function catalog(root, count) {
  // Build once, then install distinct manifests from that real artifact. This
  // avoids hundreds of compiler processes while retaining real server validation.
  const template = await source(
    root,
    "catalog-000",
    `
    import { view } from "@tokamak/sdk";
    export const Catalog = view({ route: "/" }, () => <p id="catalog-view">Catalog loaded</p>);
  `,
  );
  built(template);
  const manifest = JSON.parse(await readFile(resolve(template, "dist/manifest.json"), "utf8"));
  const code = await readFile(resolve(template, "dist/ui.js"), "utf8");
  for (let i = 1; i < count; i++) {
    const id = `catalog-${String(i).padStart(3, "0")}`;
    await cp(resolve(template, "dist"), resolve(root, id, "dist"), { recursive: true });
    // Re-key the builder's registration and its content hash together, so
    // every catalog entry remains a valid, independently loadable artifact.
    const renamed = code.replace("@plugins/catalog-000/ui", `@plugins/${id}/ui`);
    await writeFile(resolve(root, id, "dist/ui.js"), renamed);
    await writeFile(
      resolve(root, id, "dist/manifest.json"),
      JSON.stringify({
        ...manifest,
        plugin: { ...manifest.plugin, id },
        hashes: { ...manifest.hashes, "ui.js": createHash("sha256").update(renamed).digest("hex") },
      }),
    );
  }
}

async function partsHost(root) {
  const entry = (await readFile(resolve(workspace, "app/src/main.tsx"), "utf8")).replace(
    'import { Shell } from "./shell";',
    `import { PartsHost as Shell } from ${JSON.stringify(resolve(workspace, "app/tests/parts-host.tsx"))};`,
  );
  // This standalone test host uses the production entry's module namespaces.
  const path = await source(root, "parts-host", entry, { backend: false, standalone: true });
  await writeFile(
    resolve(path, "src/styles.css"),
    "button { display: block; min-width: 160px; min-height: 32px; }",
  );
  built(path);
}

if (import.meta.main) {
  const [root, action] = process.argv.slice(2);
  if (action === "reload") await library(root, "after");
  else if (action === "unrelated-reload")
    built(
      await source(
        root,
        "broken",
        `
    import { view } from "@tokamak/sdk";
    export const Updated = view({ route: "/" }, () => <p>Unrelated update</p>);
  `,
      ),
    );
  else if (action === "parts-host") await partsHost(root);
  else if (action === "errors") await errors(root);
  else if (action === "lazy") await lazy(root);
  else if (action === "guards") await guards(root);
  else if (action === "guards-reload") await guards(root, 2);
  else if (action === "growth") await growth(root);
  else if (action === "heap") await heap(root);
  else if (action === "bulk") await bulk(root);
  else if (action === "payload") await payload(root);
  else if (action.startsWith("catalog-")) await catalog(root, Number(action.slice(8)));
  else await fixtures(root);
}
