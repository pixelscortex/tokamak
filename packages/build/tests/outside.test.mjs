import { expect, test } from "bun:test";
import { readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
  expect(await readFile(join(dist, "styles.css"), "utf8")).toContain(".bg-brand");
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

test("reports the file and line of a window type error without publishing", async () => {
  await withPlugin(async (plugin) => {
    const path = join(plugin, "src/client/api.tsx");
    const source = await readFile(path, "utf8");
    const line = source.split("\n").findIndex((text) => text.includes("<Button>")) + 1;
    expect(line).toBeGreaterThan(0);
    await writeFile(path, source.replace("<Button>", '<Button disabled="yes">'));
    const result = build(plugin);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(new RegExp(String.raw`api\.tsx[(:]${line}[,:]\d+\)?: error TS2322`));
    expect(await readdir(plugin)).not.toContain("dist");
  });
}, 30_000);

test("builds an external worker action that uses node:path", async () => {
  await withPlugin(async (plugin) => {
    const descriptor = join(plugin, "plugin.ts");
    const source = await readFile(descriptor, "utf8");
    await writeFile(descriptor, source.replace("definePlugin({", 'definePlugin({ runtime: "worker",'));
    await writeFile(
      join(plugin, "src/server/paths.ts"),
      `
import { action } from "@tokamak/sdk";
import { basename } from "node:path";
export const name = action({ handler: () => basename("/notes/example.txt") });
`,
    );
    await expectArtifact(plugin);
    expect(await readFile(join(plugin, "dist/worker.js"), "utf8")).toContain("node:path");
  });
}, 30_000);

test("an internal server directory link preserves the authored API names", async () => {
  await withPlugin(async (plugin) => {
    const server = join(plugin, "src/server");
    const notes = join(server, "notes.ts");
    await Bun.write(
      join(server, "topics/notes.ts"),
      (await readFile(notes, "utf8")).replace('"./_generated/api"', '"../_generated/api"'),
    );
    await unlink(notes);
    await expectArtifact(plugin);
    const before = await readFile(join(plugin, "dist/api.ts"), "utf8");
    await rm(join(server, "_generated"), { recursive: true });
    const implementation = join(plugin, "src/implementation");
    await rename(server, implementation);
    await symlink(implementation, server, "junction");
    await expectArtifact(plugin);
    const after = await readFile(join(plugin, "dist/api.ts"), "utf8");
    expect(after).toBe(before);
    expect(before).toContain('"notes": ApiFromModule');
    expect(after).toContain('"notes": ApiFromModule');
    expect(after).not.toContain('"topics":');
  });
}, 30_000);

test("an empty local tsconfig preserves the default server type checks", async () => {
  await withPlugin(async (plugin) => {
    const config = join(plugin, "src/server/tsconfig.json");
    await expectArtifact(plugin);
    await writeFile(config, "{}");
    await expectArtifact(plugin);

    const broken = join(plugin, "src/server/broken.ts");
    await writeFile(
      broken,
      `import { JsonValue } from "@tokamak/sdk";
export const value: JsonValue = "note";
`,
    );
    const configured = build(plugin);
    await unlink(config);
    const defaults = build(plugin);
    for (const result of [defaults, configured]) {
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/broken\.ts[^\n]*TS1484/);
    }
  });
}, 30_000);

test("a local server config can relax strictness without adding Node globals", async () => {
  await withPlugin(async (plugin) => {
    const config = join(plugin, "src/server/tsconfig.json");
    const source = join(plugin, "src/server/overrides.ts");
    await writeFile(config, JSON.stringify({ compilerOptions: { strict: false, types: ["node"] } }));
    await writeFile(source, "export const value: string = null;\n");
    await expectArtifact(plugin);
    await writeFile(source, "export const value = process.cwd();\n");
    const result = build(plugin);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/overrides\.ts[^\n]*TS2591/);
  });
}, 30_000);
