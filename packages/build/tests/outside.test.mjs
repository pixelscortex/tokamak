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
