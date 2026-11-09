// Public-builder fixtures shared by compiler and real socket/native regressions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
    export const Broken = view({ route: "/" }, () => { throw new Error("intentional contribution failure"); });`));
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
  else if (action === "parts-host") await partsHost(root);
  else await fixtures(root);
}
