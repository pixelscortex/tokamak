import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { source, build, built, workspace } from "../../../app/tests/plugin-fixtures.mjs";

async function scratch(check) {
  await mkdir(resolve(workspace, "packages/build/dist"), { recursive: true });
  const root = await mkdtemp(resolve(workspace, "packages/build/dist/plugin-regression-"));
  try { await check(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const artifact = async (path, file) => readFile(resolve(path, "dist", file), "utf8");

// Prevents runtime duplication (including hidden source-map copies), eager UI
// execution during discovery, and IDs accidentally derived from local names.
test("public builder extracts all contribution kinds and leaves the host runtime external", async () => {
  await scratch(async root => {
    const path = await source(root, "parts", `
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
    `);
    built(path);
    const manifest = JSON.parse(await artifact(path, "manifest.json"));
    expect(manifest.plugin.contributes).toEqual({
      view: [{ id: "PublicView", route: "/" }], itemRenderer: [{ id: "Item", type: "note" }],
      toolbar: [{ id: "Tools", label: "Actions" }], command: [{ id: "Run", title: "Run" }],
      entityCard: [{ id: "Card", table: "notes" }],
    });
    const code = await artifact(path, "ui.js");
    expect(code).toContain('require("solid-js")');
    expect(code).toContain('require("@tokamak/render")');
    expect(code).not.toMatch(/function createSignal\(|function createRenderer\(|document\.createElement/);
    const map = JSON.parse(await artifact(path, "ui.js.map"));
    expect(map.sources.length).toBeGreaterThan(0);
    expect(map.sources.every(name => !/solid-js|render\/js/.test(name))).toBe(true);
    expect(map.sourcesContent.join("\n")).not.toMatch(/function createSignal\(|function createRenderer\(/);
  });
}, 30_000);

// Prevents silently missing dynamic contributions or running arbitrary helper
// options as part of a build. The error must identify the offending export.
test("public builder rejects nonliteral contribution options with an actionable error", async () => {
  await scratch(async root => {
    for (const options of ['options', '{ route: route }', '{ ...options }', '{ ["route"]: "/" }']) {
      const path = await source(root, "dynamic", `import { view } from "@tokamak/sdk";
        const options = { route: "/" }; const route = "/";
        export const Dynamic = view(${options}, () => <p>Dynamic</p>);`);
      const result = build(path);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("Invalid UI contribution Dynamic: use a contribution helper with static literal options");
    }
  });
}, 30_000);

// Prevents cross-plugin imports being bundled away or omitted from installation
// dependency ordering, while preserving ordinary component-only artifacts.
test("component-only exports infer UI dependencies without inventing contributions", async () => {
  await scratch(async root => {
    const path = await source(root, "components", `import { Other } from "@plugins/other/ui";
      export const Component = () => <Other />;`);
    built(path);
    const manifest = JSON.parse(await artifact(path, "manifest.json"));
    expect(manifest.plugin.depends).toEqual({ other: "*" });
    expect(manifest.plugin.contributes).toEqual({});
    expect(manifest.entries.backend).toBeUndefined();
    expect(await artifact(path, "ui.js")).toContain('require("@plugins/other/ui")');
  });
}, 30_000);
