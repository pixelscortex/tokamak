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
  try { await symlink(resolve(workspace, "app/node_modules"), resolve(path, "node_modules"), "dir"); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  await writeFile(resolve(path, "package.json"), JSON.stringify({ name: id, version: "1.0.0", type: "module" }));
  await writeFile(resolve(path, "tsconfig.json"), JSON.stringify({ extends: resolve(workspace, "app/tsconfig.json"), include: ["src"] }));
  await writeFile(resolve(path, "vite.config.ts"), `import { tokamak } from "@tokamak/build/vite"; export default { plugins: [tokamak(${JSON.stringify(options)})] };`);
  await writeFile(resolve(path, "src/main.tsx"), code);
  return path;
}
export function build(path) {
  const result = spawnSync(process.execPath, [resolve(workspace, "packages/build/src/build.ts"), path], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}
export function built(path) {
  const result = build(path);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
export async function library(root, version = "before") {
  const path = await source(root, "library", `
    import { createSignal } from "solid-js";
    export const [shared, setShared] = createSignal(0);
    export const ready = "library-ready";
    export function Counter() { return <button id="shared-increment" onClick={() => setShared(n => n + 1)}>library-${version}: {shared()}</button>; }
  `);
  built(path);
}
export async function fixtures(root) {
  const logic = await source(root, "logic", "", { ui: false });
  await cp(resolve(workspace, "plugins/todo/backend"), resolve(logic, "backend"), {
    recursive: true, filter: path => !/\/(dist|_generated)(\/|$)/.test(path),
  });
  await writeFile(resolve(logic, "backend/tsconfig.json"), JSON.stringify({
    extends: resolve(workspace, "app/backend/tsconfig.json"), include: ["**/*.ts"], exclude: ["dist"],
  }));
  built(logic);
  await library(root);
  built(await source(root, "dormant", 'export function Unused() { throw new Error("backend dependency UI must stay lazy"); }'));
  built(await source(root, "consumer", `
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
      const rows = useQuery(client, api.todo.list, () => ({}));
      return <div>
        <input id="local-input" value="" />
        <Counter /><p id="shared-observer">observed: {shared()}</p>
        <button id="local-increment" onClick={() => setLocal(n => n + 1)}>local: {local()}</button>
        <p id="live-data">{JSON.stringify(rows.data())}</p>
        <button id="add-row" onClick={() => client.mutation(api.todo.add, { title: "live-row" })}>Add row</button>
        <button id="thread-route" onClick={() => router.navigate("/chat/thread-one")}>Thread</button>
        <button id="nested-route" onClick={() => router.navigate("/p/consumer/detail/one")}>Nested</button>
      </div>;
    });
    export const Nested = view({ route: "/detail/*rest" }, () => <p id="nested">Nested route</p>);
  `, { backend: false, plugin: { id: "consumer", version: "1.0.0", depends: { logic: "*", dormant: "*" } } }));
  built(await source(root, "broken", `import { view } from "@tokamak/sdk";
    import { shared } from "@plugins/library/ui";
    export const Broken = view({ route: "/" }, () => {
      if (shared() === 0) throw new Error("intentional contribution failure");
      return <p id="recovered">Recovered contribution</p>;
    });`));
}

async function errors(root) {
  await library(root);
  built(await source(root, "healthy", `
    import { view } from "@tokamak/sdk";
    import { Counter } from "@plugins/library/ui";
    export const Healthy = view({ route: "/" }, () => <Counter />);
  `));
  for (const kind of ["event", "async", "effect", "factory"]) {
    built(await source(root, `error-${kind}`, `
      import { createSignal, createEffect } from "solid-js";
      import { view } from "@tokamak/sdk";
      const [trigger, setTrigger] = createSignal(false);
      ${kind === "factory" ? 'createEffect(() => { if (trigger()) throw new Error("factory-owned failure"); });' : ""}
      export const Failure = view({ route: "/" }, () => {
        ${kind === "effect" ? 'createEffect(() => { if (trigger()) throw new Error("effect-owned failure"); });' : ""}
        return <button id="throw-${kind}" onClick={() => {
          ${kind === "event" ? 'throw new Error("event-owned failure");'
            : kind === "async" ? 'void (async () => { await Promise.resolve(); throw new Error("async-owned failure"); })();'
            : "setTrigger(true);"}
        }}>Throw ${kind}</button>;
      });
    `));
  }
}

async function guards(root) {
  built(await source(root, "vault", `
    let original: any;
    export const remember = (handle: any) => { original ??= handle; return original; };
  `));
  built(await source(root, "guard", `
    import { createSignal } from "solid-js";
    import { view } from "@tokamak/sdk";
    import { remember } from "@plugins/vault/ui";
    const capability = (globalThis as any).__tokamakModules;
    const original = remember(capability);
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
  `));
}

async function lazy(root) {
  await library(root);
  built(await source(root, "lazy", `
    import { createSignal } from "solid-js";
    import { view } from "@tokamak/sdk";
    export const Lazy = view({ route: "/" }, () => {
      const [component, setComponent] = createSignal<any>();
      return <div><button id="lazy-load" onClick={async () => {
        const module = await import("@plugins/library/ui");
        setComponent(() => module.Counter);
      }}>Load library</button>{component() && component()({})}</div>;
    });
  `));
}

async function payload(root) {
  const backend = await source(root, "payload", "", { ui: false });
  await mkdir(resolve(backend, "backend"), { recursive: true });
  await writeFile(resolve(backend, "backend/tsconfig.json"), JSON.stringify({
    extends: resolve(workspace, "app/backend/tsconfig.json"), include: ["**/*.ts"],
  }));
  await writeFile(resolve(backend, "backend/schema.ts"), `
    import { defineSchema, defineTable, v } from "@tokamak/sdk";
    export default defineSchema({ values: defineTable({ size: v.number() }) });
  `);
  await writeFile(resolve(backend, "backend/ops.ts"), `
    import { createFunctions, v } from "@tokamak/sdk";
    import schema from "./schema";
    const { query } = createFunctions(schema);
    export const bytes = query({ args: { size: v.number() }, handler: (_ctx, { size }) => "x".repeat(size) });
  `);
  built(backend);
  built(await source(root, "payload-view", `
    import { createSignal } from "solid-js";
    import { view } from "@tokamak/sdk";
    import { useClient } from "@tokamak/sdk/solid";
    import { api } from "../../payload/backend/_generated/api";
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
            client.subscribe(api.ops.bytes, { size: 1_100_000 }, event => {
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
  `, { backend: false, plugin: { id: "payload-view", version: "1.0.0", depends: { payload: "*" } } }));
}

async function catalog(root, count) {
  // Build once, then install distinct manifests from that real artifact. This
  // avoids 150 compiler processes while retaining real server validation.
  const template = await source(root, "catalog-000", `
    import { view } from "@tokamak/sdk";
    export const Catalog = view({ route: "/" }, () => <p id="catalog-view">Catalog loaded</p>);
  `);
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
    await writeFile(resolve(root, id, "dist/manifest.json"), JSON.stringify({
      ...manifest, plugin: { ...manifest.plugin, id },
      hashes: { ...manifest.hashes, "ui.js": createHash("sha256").update(renamed).digest("hex") },
    }));
  }
}

async function partsHost(root) {
  const entry = (await readFile(resolve(workspace, "app/src/main.tsx"), "utf8"))
    .replace('import { Shell } from "./shell";', `import { PartsHost as Shell } from ${JSON.stringify(resolve(workspace, "app/tests/parts-host.tsx"))};`);
  // This standalone test host uses the production entry's module namespaces.
  const path = await source(root, "parts-host", entry, { backend: false, standalone: true });
  await writeFile(resolve(path, "src/styles.css"), "button { display: block; min-width: 160px; min-height: 32px; }");
  built(path);
}

if (import.meta.main) {
  const [root, action] = process.argv.slice(2);
  if (action === "reload") await library(root, "after");
  else if (action === "unrelated-reload") built(await source(root, "broken", `
    import { view } from "@tokamak/sdk";
    export const Updated = view({ route: "/" }, () => <p>Unrelated update</p>);
  `));
  else if (action === "parts-host") await partsHost(root);
  else if (action === "errors") await errors(root);
  else if (action === "lazy") await lazy(root);
  else if (action === "guards") await guards(root);
  else if (action === "payload") await payload(root);
  else if (action.startsWith("catalog-")) await catalog(root, Number(action.slice(8)));
  else await fixtures(root);
}
