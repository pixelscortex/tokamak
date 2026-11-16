import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { source, build, built, workspace } from "../../../app/tests/plugin-fixtures.mjs";

async function scratch(check) {
  await mkdir(resolve(workspace, "packages/build/dist"), { recursive: true });
  const root = await mkdtemp(resolve(workspace, "packages/build/dist/plugin-regression-"));
  try {
    await check(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const artifact = async (path, file) => readFile(resolve(path, "dist", file), "utf8");

// Prevents runtime duplication (including hidden source-map copies), eager UI
// execution during discovery, and IDs accidentally derived from local names.
test("public builder extracts all contribution kinds and leaves the host runtime external", async () => {
  await scratch(async (root) => {
    const path = await source(
      root,
      "parts",
      `
      import { createSignal } from "solid-js";
      import { view as screen, itemRenderer, toolbar, command, entityCard } from "@tokamak/sdk";
      throw new Error("plugin code was executed during discovery");
      const Local = screen({ route: "/" }, () => <p>{createSignal(1)[0]()}</p>);
      export { Local as PublicView };
      export const Item = itemRenderer({ type: "note" }, () => <p>Item</p>);
      export const Tools = toolbar({ label: "Actions" }, () => <p>Tools</p>);
      export const Run = command({ title: "Run" }, () => {});
      export const Card = entityCard({ table: "notes" }, () => <p>Card</p>);
      export const Plain = () => <p>Plain</p>;
    `,
    );
    built(path);
    const manifest = JSON.parse(await artifact(path, "manifest.json"));
    expect(manifest.plugin.contributes).toEqual({
      view: [{ id: "PublicView", route: "/" }],
      itemRenderer: [{ id: "Item", type: "note" }],
      toolbar: [{ id: "Tools", label: "Actions" }],
      command: [{ id: "Run", title: "Run" }],
      entityCard: [{ id: "Card", table: "notes" }],
    });
    const code = await artifact(path, "ui.js");
    expect(code).toContain('require("solid-js")');
    expect(code).toContain('require("@tokamak/render")');
    expect(code).not.toMatch(/function createSignal\(|function createRenderer\(|document\.createElement/);
    const map = JSON.parse(await artifact(path, "ui.js.map"));
    expect(map.sources.length).toBeGreaterThan(0);
    expect(map.sources.every((name) => !/solid-js|render\/js/.test(name))).toBe(true);
    expect(map.sourcesContent.join("\n")).not.toMatch(/function createSignal\(|function createRenderer\(/);
  });
}, 30_000);

// Prevents silently missing dynamic contributions or running arbitrary helper
// options as part of a build. The error must identify the offending export.
test("public builder rejects nonliteral contribution options with an actionable error", async () => {
  await scratch(async (root) => {
    for (const options of ["options", "{ route: route }", "{ ...options }", '{ ["route"]: "/" }']) {
      const path = await source(
        root,
        "dynamic",
        `import { view } from "@tokamak/sdk";
        const options = { route: "/" }; const route = "/";
        export const Dynamic = view(${options}, () => <p>Dynamic</p>);`,
      );
      const result = build(path);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "Invalid UI contribution Dynamic: use a contribution helper with static literal options",
      );
    }
  });
}, 30_000);

// Prevents cross-plugin imports being bundled away or omitted from installation
// dependency ordering, while preserving ordinary component-only artifacts.
test("component-only exports infer UI dependencies without inventing contributions", async () => {
  await scratch(async (root) => {
    const path = await source(
      root,
      "components",
      `import { Other } from "@plugins/other/ui";
      export const Component = () => <Other />;`,
    );
    built(path);
    const manifest = JSON.parse(await artifact(path, "manifest.json"));
    expect(manifest.plugin.depends).toEqual({ other: "*" });
    expect(manifest.plugin.contributes).toEqual({});
    expect(manifest.entries.backend).toBeUndefined();
    expect(await artifact(path, "ui.js")).toContain('require("@plugins/other/ui")');
  });
}, 30_000);

// F: TypeScript erases these exports; discovering them as views creates rail
// entries whose exports do not exist when the native loader evaluates the UI.
test("type-only named and star re-exports never create contributions", async () => {
  await scratch(async (root) => {
    const path = await source(
      root,
      "erased-exports",
      `
      export type { Home as Ghost } from "./home";
      export type * from "./home";
      export { Home as Actual } from "./home";
    `,
    );
    await writeFile(
      resolve(path, "src/home.tsx"),
      `
      import { view } from "@tokamak/sdk";
      export const Home = view({ route: "/" }, () => <p>Home</p>);
    `,
    );
    built(path);
    expect(JSON.parse(await artifact(path, "manifest.json")).plugin.contributes).toEqual({
      view: [{ id: "Actual", route: "/" }],
    });
  });
}, 30_000);

// G: An erased intermediate module must not force installation of a plugin
// that the emitted runtime graph never imports.
test("type-import chains do not infer runtime plugin dependencies", async () => {
  await scratch(async (root) => {
    const path = await source(
      root,
      "erased-chain",
      `
      import type { Shape } from "./types";
      export const label: Shape = "ok";
    `,
    );
    await writeFile(
      resolve(path, "src/types.ts"),
      `
      import { Other } from "@plugins/type-only/ui";
      export type Shape = ReturnType<typeof Other>;
    `,
    );
    built(path);
    const manifest = JSON.parse(await artifact(path, "manifest.json"));
    expect(manifest.plugin.depends ?? {}).toEqual({});
    expect(await artifact(path, "ui.js")).not.toContain("@plugins/type-only");
  });
}, 30_000);

// E: Optional UI imports must remain lazy and use the scoped native loader,
// rather than leave an unsupported QuickJS import() in the emitted factory.
test("literal dynamic plugin imports use the lazy loader and optional dependencies", async () => {
  await scratch(async (root) => {
    const path = await source(
      root,
      "lazy-import",
      `
      export const load = async () => (await import("@plugins/optional/ui")).Other;
    `,
    );
    built(path);
    const manifest = JSON.parse(await artifact(path, "manifest.json"));
    expect(manifest.plugin.optional).toEqual({ optional: "*" });
    expect(manifest.plugin.depends ?? {}).toEqual({});
    expect(await artifact(path, "ui.js")).toMatch(
      /__tokamakModules\.load\(["'`]@plugins\/optional\/ui["'`]\)/,
    );
  });
}, 30_000);

// E: A computed import cannot be checked or assigned a loader capability;
// accepting it postpones the failure until the user opens the native view.
test("computed dynamic imports fail the build with an actionable diagnostic", async () => {
  await scratch(async (root) => {
    const path = await source(
      root,
      "computed-import",
      `
      export const load = (name: string) => import(name);
    `,
    );
    const result = build(path);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Dynamic plugin imports require a string literal");
  });
}, 30_000);

// Open slots/mods use the same static export graph and cross-plugin contract.
test("builder qualifies slots, extracts extension targets and instruments local public components", async () => {
  await scratch(async (root) => {
    const owner = await source(
      root,
      "owner",
      `
      import { defineSlot } from "@tokamak/sdk/client";
      export const actions = defineSlot<{ text: string }>("composer.actions");
      export function Input(props: { text: string }) { return <p>{props.text}</p>; }
      export function Local() { return <Input text="local" />; }
    `,
    );
    built(owner);
    const ownerCode = await artifact(owner, "ui.js");
    expect(ownerCode).toContain("owner.composer.actions");
    expect(ownerCode).toContain("owner.Input");
    const mod = await source(
      root,
      "mod",
      `
      import { fill, wrap, replace } from "@tokamak/sdk/client";
      import { actions as target, Input } from "@plugins/owner/ui";
      export const Extra = fill(target, { order: -5, id: "extra" }, p => <p>{p.text}</p>);
      export const Frame = wrap(Input, Original => props => <div><Original {...props} /></div>);
      export const Other = replace(Input, props => <p>{props.text}</p>);
    `,
    );
    await writeFile(
      resolve(mod, "tsconfig.json"),
      JSON.stringify({
        extends: resolve(workspace, "app/tsconfig.json"),
        compilerOptions: { paths: { "@plugins/owner/ui": [resolve(owner, "src/main.tsx")] } },
        include: ["src"],
      }),
    );
    built(mod);
    const manifest = JSON.parse(await artifact(mod, "manifest.json"));
    expect(manifest.plugin.contributes).toEqual({
      fill: [{ id: "Extra", target: "owner.composer.actions", order: -5, fillId: "extra" }],
      wrap: [{ id: "Frame", target: "owner.Input" }],
      replace: [{ id: "Other", target: "owner.Input" }],
    });
    expect(manifest.plugin.depends).toEqual({ owner: "*" });
    const code = await artifact(mod, "ui.js");
    expect(code).not.toContain("mod.Frame"); // wrapper factories are not components
    for (const options of ["{ order: rank }", "{ ...options }", "{ id: label }"]) {
      await writeFile(
        resolve(mod, "src/main.tsx"),
        `
        import { fill } from "@tokamak/sdk/client";
        import { actions } from "@plugins/owner/ui";
        const rank = 1, options = {}, label = "x";
        export const Bad = fill(actions, ${options}, () => <p />);
      `,
      );
      const result = build(mod);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("Invalid UI contribution Bad");
    }
  });
}, 30_000);
