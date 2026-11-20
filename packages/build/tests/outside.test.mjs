import { expect, test } from "bun:test";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, withPlugin } from "./outside-fixture.mjs";

async function expectArtifact(plugin) {
  const result = build(plugin);
  expect(result.code, result.output).toBe(0);
  const dist = join(plugin, "dist");
  const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
  expect(manifest.plugin.contributes.view).toEqual([{ id: "OutsideView", route: "/outside" }]);
  expect(await readFile(join(dist, "bundle.js"), "utf8")).toContain("describe");
  expect(await readFile(join(dist, "ui.js"), "utf8")).toContain("@tokamak/ui");
  expect(await readFile(join(dist, "styles.css"), "utf8")).toContain(String.raw`.print\:p-3`);
}

test("builds a source-only plugin outside the checkout with its view and styles", async () => {
  await withPlugin(expectArtifact);
}, 30_000);

test("builds the same plugin through a symlinked temp directory", async () => {
  await withPlugin(async (_, root) => {
    const link = join(root, "alias");
    await symlink(root, link, "junction");
    await expectArtifact(join(link, "plugin"));
  });
}, 30_000);

test("reports the file and line of a type error in the external server part", async () => {
  await withPlugin(async (plugin) => {
    await writeFile(join(plugin, "src/server/broken.ts"), "\nexport const broken: string = 42;\n");
    const result = build(plugin);
    expect(result.code).not.toBe(0);
    // The type checker prints `broken.ts(2,14): error TS2322` in a terminal and
    // `<error file="broken.ts" line="2" ... code="TS2322">` when it detects an AI
    // agent (the AI_AGENT environment variable). Both name the file and line.
    expect(result.output).toMatch(
      /broken\.ts\(2,\d+\): error TS2322|file="broken\.ts" line="2"[^>]*code="TS2322"/,
    );
  });
}, 30_000);

test("rejects an internal runtime import in the window", async () => {
  await withPlugin(async (plugin) => {
    await writeFile(join(plugin, "src/client/internal.ts"), 'import "@tokamak/runtime";\n');
    const result = build(plugin);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/"@tokamak\/runtime".*Allowed paths:.*@tokamak\/runtime\/router/);
  });
}, 30_000);

test("rejects an internal runtime import in the server part", async () => {
  await withPlugin(async (plugin) => {
    await writeFile(join(plugin, "src/server/internal.ts"), 'import "@tokamak/runtime";\n');
    const result = build(plugin);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/"@tokamak\/runtime".*Allowed paths:.*@tokamak\/runtime\/router/);
  });
}, 30_000);

test("builds with a warning for a direct UI SDK import", async () => {
  await withPlugin(async (plugin) => {
    const path = join(plugin, "src/client/api.tsx");
    await writeFile(path, 'import "@ui-sdk/solid";\n' + (await readFile(path, "utf8")));
    const result = build(plugin);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/Warning:.*"@ui-sdk\/solid".*@tokamak\/ui/);
    expect(await readFile(join(plugin, "dist/ui.js"), "utf8")).toContain("@ui-sdk/solid");
  });
}, 30_000);

test("rejects shared packages in every dependency section", async () => {
  await withPlugin(async (plugin) => {
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      await writeFile(
        join(plugin, "package.json"),
        JSON.stringify({ name: "outside-fixture", [section]: { "solid-js": "2.0.0" } }),
      );
      const result = build(plugin);
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(new RegExp(`package.json.*${section}.*"solid-js".*shared`));
    }
  });
}, 30_000);

test("installs and bundles the plugin's own npm package outside the checkout", async () => {
  await withPlugin(async (plugin) => {
    await writeFile(
      join(plugin, "package.json"),
      JSON.stringify({ name: "outside-fixture", dependencies: { "escape-string-regexp": "5.0.0" } }),
    );
    const path = join(plugin, "src/client/api.tsx");
    const original = await readFile(path, "utf8");
    await writeFile(
      path,
      'import escape from "escape-string-regexp";\n' + original.replace("Notes", '{escape("Notes.")}'),
    );
    const result = build(plugin);
    expect(result.code, result.output).toBe(0);
    const output = await readFile(join(plugin, "dist/ui.js"), "utf8");
    expect(output).toContain("Expected a string");
    expect(output).not.toContain('from "escape-string-regexp"');
  });
}, 90_000);
