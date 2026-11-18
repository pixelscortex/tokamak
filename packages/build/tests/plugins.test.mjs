import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { uiContributions } from "../src/contributions.ts";
import { clientSurface } from "../src/client-surface.ts";
import { PLUGIN_UI_BUILD_ENABLED } from "../src/vite.ts";

const workspace = resolve(import.meta.dir, "../../..");
async function scratch(check) {
  const parent = resolve(workspace, "packages/build/dist");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "plugin-regression-"));
  try {
    await check(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function source(root, id, code, paths = {}) {
  const path = resolve(root, id);
  await mkdir(resolve(path, "src/client"), { recursive: true });
  await writeFile(
    resolve(path, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", type: "module" }),
  );
  await writeFile(
    resolve(path, "tsconfig.json"),
    JSON.stringify({
      extends: resolve(workspace, "app/tsconfig.json"),
      compilerOptions: { paths },
      include: ["src"],
    }),
  );
  await writeFile(resolve(path, "src/client/api.tsx"), code);
  return path;
}

test("static contribution discovery preserves brands, aliases and erased exports without execution", async () => {
  await scratch(async (root) => {
    const path = await source(
      root,
      "parts",
      `
      import { view as screen, itemRenderer, toolbar, command, entityCard } from "@tokamak/sdk/client";
      throw new Error("must never execute");
      const Local = screen({ route: "/" }, () => <p>View</p>);
      export { Local as PublicView };
      export const Item = itemRenderer({ type: "note" }, () => <p />);
      export const Tools = toolbar({ label: "Actions" }, () => <p />);
      export const Run = command({ title: "Run" }, () => {});
      export const Card = entityCard({ table: "notes" }, () => <p />);
      export type { Local as Ghost };
    `,
    );
    expect(uiContributions(path).contributes).toEqual({
      view: [{ id: "PublicView", route: "/" }],
      itemRenderer: [{ id: "Item", type: "note" }],
      toolbar: [{ id: "Tools", label: "Actions" }],
      command: [{ id: "Run", title: "Run" }],
      entityCard: [{ id: "Card", table: "notes" }],
    });
    await writeFile(
      resolve(path, "src/client/api.tsx"),
      `
      import { view } from "@tokamak/sdk/client";
      const route = "/";
      export const Bad = view({ route }, () => <p />);
    `,
    );
    expect(() => uiContributions(path)).toThrow("Invalid UI contribution Bad");
  });
});

test("compiler-derived slot and component identities survive the DOM port", async () => {
  await scratch(async (root) => {
    const code = `
      import { defineSlot as slot } from "@tokamak/sdk/client";
      export const actions = slot<{ text: string }>("composer.actions");
      function Impl(props: { text: string }) { return <p>{props.text}</p>; }
      export { Impl as Input, Impl as Alias };
    `;
    const owner = await source(root, "owner", code);
    const transform = clientSurface(
      () => owner,
      () => "owner",
    ).transform;
    const transformed = transform.call({}, code, resolve(owner, "src/client/api.tsx"));
    for (const identity of ["owner.composer.actions", "owner.Input", "owner.Alias"])
      expect(transformed.code).toContain(identity);
    const mod = await source(
      root,
      "mod",
      `
      import { fill, wrap, replace } from "@tokamak/sdk/client";
      import { actions, Input } from "plugin:owner/client";
      export const Extra = fill(actions, { order: -5, id: "extra" }, p => <p>{p.text}</p>);
      export const Frame = wrap(Input, Original => props => <div><Original {...props} /></div>);
      export const Other = replace(Input, props => <p>{props.text}</p>);
    `,
      { "plugin:owner/client": [resolve(owner, "src/client/api.tsx")] },
    );
    expect(uiContributions(mod).contributes).toEqual({
      fill: [{ id: "Extra", target: "owner.composer.actions", order: -5, fillId: "extra" }],
      wrap: [{ id: "Frame", target: "owner.Input" }],
      replace: [{ id: "Other", target: "owner.Input" }],
    });
  });
});

test("a public function component stays hoisted after the surface transform", async () => {
  await scratch(async (root) => {
    const code = `
      export const Early = Panel;
      export function Panel() { return null; }
    `;
    const owner = await source(root, "owner", code);
    const transform = clientSurface(
      () => owner,
      () => "owner",
    ).transform;
    const transformed = transform.call({}, code, resolve(owner, "src/client/api.tsx")).code;
    expect(transformed).toContain("export function Panel(props)");
    expect(transformed).not.toMatch(/export const Panel\b/);
  });
});

test("server artifacts omit UI, verify final hashes and preserve unchanged bytes and mtimes", async () => {
  await scratch(async (root) => {
    await cp(resolve(workspace, "packages/server/tests/fixtures/record"), root, {
      recursive: true,
      filter: (path) => !["dist", "_generated", "node_modules"].includes(path.split("/").at(-1)),
    });
    await writeFile(
      resolve(root, "src/server/tsconfig.json"),
      JSON.stringify({
        extends: resolve(workspace, "tsconfig.json"),
        include: ["**/*.ts"],
        exclude: ["dist"],
      }),
    );
    await mkdir(resolve(root, "src/client"), { recursive: true });
    await writeFile(resolve(root, "src/client/api.tsx"), "this is intentionally invalid UI");
    const build = () => {
      const result = spawnSync(process.execPath, [resolve(workspace, "packages/build/src/build.ts"), root], {
        encoding: "utf8",
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    expect(PLUGIN_UI_BUILD_ENABLED).toBe(true);
    await writeFile(
      resolve(root, "vite.config.ts"),
      `import {tokamak} from "${workspace}/packages/build/src/vite.ts"; export default {plugins:[tokamak({ui:false})]};`,
    );
    build();
    const manifest = JSON.parse(await readFile(resolve(root, "dist/manifest.json"), "utf8"));
    expect(manifest.entries.ui).toBeUndefined();
    expect(manifest.entries.backend.code).toBe("bundle.js");
    expect(manifest.publicFunctions).toContain("record:add");
    const before = new Map();
    for (const [name, hash] of Object.entries(manifest.hashes)) {
      const path = resolve(root, "dist", name);
      const bytes = await readFile(path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
      before.set(name, { bytes, mtime: (await stat(path)).mtimeMs });
    }
    build();
    for (const [name, expected] of before) {
      const path = resolve(root, "dist", name);
      expect(await readFile(path)).toEqual(expected.bytes);
      expect((await stat(path)).mtimeMs).toBe(expected.mtime);
    }
  });
}, 30_000);
