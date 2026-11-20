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
    expect(result.output).toContain("src/server/internal.ts");
    expect(result.output).not.toContain("@tokamak/runtime/router");
    expect(result.output).toMatch(/"@tokamak\/runtime".*Allowed paths:.*@tokamak\/sdk/);
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

async function localNpmPackage(root, folder, marker) {
  const path = join(root, folder);
  await Bun.write(
    join(path, "package.json"),
    JSON.stringify({
      name: "local-note",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
    }),
  );
  await Bun.write(join(path, "index.js"), `export const note = () => ${JSON.stringify(marker)};`);
  await Bun.write(join(path, "index.d.ts"), "export declare const note: () => string;");
}

async function useLocalNpmPackage(plugin, folder) {
  await writeFile(
    join(plugin, "package.json"),
    JSON.stringify({ name: "outside-fixture", dependencies: { "local-note": `file:../${folder}` } }),
  );
}

test("installs and bundles the plugin's own local npm package outside the checkout", async () => {
  await withPlugin(async (plugin, root) => {
    await localNpmPackage(root, "note", "bundled local npm note");
    await useLocalNpmPackage(plugin, "note");
    const path = join(plugin, "src/client/main.tsx");
    await rename(join(plugin, "src/client/api.tsx"), path);
    await writeFile(path, 'export { note } from "local-note";');
    const result = build(plugin);
    expect(result.code, result.output).toBe(0);
    const output = await readFile(join(plugin, "dist/ui.js"), "utf8");
    expect(output).toContain("bundled local npm note");
    expect(new Bun.Transpiler({ loader: "js" }).scan(output).imports).toEqual([]);
    const cached = build(plugin);
    expect(cached.code, cached.output).toBe(0);
    expect(cached.output).not.toContain("bun install");
    await rm(join(plugin, "node_modules/local-note"), { recursive: true, force: true });
    const restored = build(plugin);
    expect(restored.code, restored.output).toBe(0);
    expect(restored.output).toContain("bun install");
  });
}, 90_000);

test("a dependency-free manifest does not invoke Bun install", async () => {
  await withPlugin(async (plugin) => {
    await Bun.write(join(plugin, "package.json"), '{"name":"outside-fixture"}');
    const result = build(plugin);
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain("bun install");
  });
}, 30_000);

test("refuses to build after dependencies diverge from the plugin lockfile", async () => {
  await withPlugin(async (plugin, root) => {
    await localNpmPackage(root, "first", "first locked note");
    await localNpmPackage(root, "second", "second unlocked note");
    await useLocalNpmPackage(plugin, "first");
    const install = Bun.spawnSync([process.execPath, "install", "--offline"], {
      cwd: plugin,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(install.exitCode, install.stdout.toString() + install.stderr.toString()).toBe(0);
    const lock = join(plugin, "bun.lock");
    const before = await readFile(lock, "utf8");
    await useLocalNpmPackage(plugin, "second");
    const result = build(plugin);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toMatch(/lockfile.*(?:changed|disagree|frozen)/i);
    expect(await readFile(lock, "utf8")).toBe(before);
  });
}, 90_000);
