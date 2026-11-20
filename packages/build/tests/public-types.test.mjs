import { expect, test } from "bun:test";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, withPlugin, workspace } from "./outside-fixture.mjs";

test("chat publishes its server and window declarations in the artifact", async () => {
  const root = join(workspace, "plugins/chat");
  const result = build(root);
  expect(result.code, result.output).toBe(0);
  const manifest = JSON.parse(await readFile(join(root, "dist/manifest.json"), "utf8"));
  expect(manifest.entries.types).toBe("public.d.ts");
  expect(manifest.hashes["public.d.ts"]).toMatch(/^[a-f0-9]{64}$/);
  const types = await readFile(join(root, "dist", manifest.entries.types), "utf8");
  expect(types).toContain('declare module "plugin:chat/server"');
  expect(types).toContain('declare module "plugin:chat/client"');
}, 90_000);

test("a plugin builds against a sibling containing only the provider artifact", async () => {
  await withPlugin(async (plugin, root) => {
    const entry = join(plugin, "src/client/api.tsx");
    const provider = join(root, "provider-source");
    await mkdir(join(provider, "src/client"), { recursive: true });
    await writeFile(
      join(provider, "plugin.ts"),
      'import { definePlugin } from "@tokamak/sdk"; export default definePlugin({ id: "fixture-api", version: "1.0.0" });',
    );
    await writeFile(join(provider, "src/client/api.ts"), "export const answer = 42;");
    const built = build(provider);
    expect(built.code, built.output).toBe(0);
    await cp(join(provider, "dist"), join(root, "artifact-only", "dist"), { recursive: true });
    await rm(provider, { recursive: true });
    await writeFile(
      entry,
      (await readFile(entry, "utf8")) + '\nexport { answer } from "plugin:fixture-api/client";\n',
    );
    const result = build(plugin);
    expect(result.code, result.output).toBe(0);
    expect(await readFile(join(plugin, ".tokamak/types/fixture-api/public.d.ts"), "utf8")).toContain(
      "answer",
    );
  });
}, 90_000);

test("a missing dependency names the plugin to build or install first", async () => {
  await withPlugin(async (plugin) => {
    const entry = join(plugin, "src/client/api.tsx");
    await writeFile(
      entry,
      (await readFile(entry, "utf8")) + '\nexport { answer } from "plugin:missing-fixture/client";\n',
    );
    const result = build(plugin);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('build or install "missing-fixture" first');
  });
}, 30_000);

test("a public signature cannot expose a type from the plugin's own npm package", async () => {
  await withPlugin(async (plugin, root) => {
    const privatePackage = join(root, "private-package");
    await mkdir(privatePackage);
    await writeFile(
      join(privatePackage, "package.json"),
      JSON.stringify({ name: "private-types", version: "1.0.0", types: "./index.d.ts" }),
    );
    await writeFile(join(privatePackage, "index.d.ts"), "export interface PrivateRecord { value: string }");
    await writeFile(
      join(plugin, "package.json"),
      JSON.stringify({
        name: "outside-fixture",
        dependencies: { "private-types": "file:../private-package" },
      }),
    );
    const entry = join(plugin, "src/client/api.tsx");
    await writeFile(
      entry,
      (await readFile(entry, "utf8")) +
        '\nimport type { PrivateRecord } from "private-types";\nexport function privateValue(): PrivateRecord { return { value: "local" }; }\n',
    );
    const result = build(plugin);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(
      /Cannot publish public types.*PrivateRecord.*non-shared library private-types/,
    );
  });
}, 90_000);
