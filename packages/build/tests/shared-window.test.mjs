import { expect, test } from "bun:test";
import { join } from "node:path";
import { build, withPlugin } from "./outside-fixture.mjs";

async function packageFiles(plugin, name, files, exports) {
  const folder = join(plugin, "node_modules", name);
  await Bun.write(join(folder, "package.json"), JSON.stringify({ name, type: "module", exports }));
  for (const [file, text] of Object.entries(files)) await Bun.write(join(folder, file), text);
}

const entry = "src/client/api.tsx";
const solidBody = 'export const createSignal = () => "second-solid";';
async function fakeSolid(plugin) {
  for (const [name, paths] of [
    ["solid-js", { ".": "./dist/solid.js", "./store": "./dist/solid.js", "./web": "./dist/solid.js" }],
    ["@solidjs/web", { "./storage": "./dist/solid.js" }],
  ]) {
    await packageFiles(
      plugin,
      name,
      { "dist/solid.js": solidBody, "dist/solid.d.ts": "export declare const createSignal: () => string;" },
      paths,
    );
  }
}

for (const id of [
  "../../node_modules/solid-js/dist/solid.js",
  "solid-js/store",
  "solid-js/web",
  "@solidjs/web/storage",
]) {
  test(`window rejects unlisted shared implementation ${id}`, async () => {
    await withPlugin(async (plugin) => {
      await fakeSolid(plugin);
      await Bun.write(
        join(plugin, entry),
        `import "solid-js"; export { createSignal } from ${JSON.stringify(id)};`,
      );
      const result = build(plugin);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(JSON.stringify(id));
      expect(result.output).toContain(entry);
      expect(result.output).toContain("Allowed paths:");
    });
  }, 30_000);
}

test("an ES module dependency uses the canonical Solid import", async () => {
  await withPlugin(async (plugin) => {
    await fakeSolid(plugin);
    await packageFiles(
      plugin,
      "bridge",
      {
        "index.js":
          'import { createSignal } from "solid-js"; export const makeSignal = () => createSignal();',
        "index.d.ts": "export declare const makeSignal: () => string;",
      },
      "./index.js",
    );
    await Bun.write(join(plugin, entry), 'export { makeSignal } from "bridge";');
    const result = build(plugin);
    expect(result.code, result.output).toBe(0);
    const output = await Bun.file(join(plugin, "dist/ui.js")).text();
    expect(new Bun.Transpiler({ loader: "js" }).scan(output).imports.map(({ path }) => path)).toEqual([
      "solid-js",
    ]);
    expect(output).not.toContain("second-solid");
    expect((await Bun.file(join(plugin, "dist/ui.js.map")).json()).sources.join("\n")).not.toContain(
      "solid-js/dist",
    );
  });
}, 30_000);

for (const direct of [true, false]) {
  test(`rejects CommonJS shared import from ${direct ? "window source" : "a dependency"}`, async () => {
    await withPlugin(async (plugin) => {
      await fakeSolid(plugin);
      if (!direct)
        await packageFiles(
          plugin,
          "common-bridge",
          {
            "index.cjs": 'module.exports = require("solid-js").createSignal;',
            "index.d.cts": "declare const signal: () => string; export = signal;",
          },
          "./index.cjs",
        );
      await Bun.write(
        join(plugin, entry),
        direct
          ? 'declare function require(id: string): {createSignal: () => unknown}; export const signal = require("solid-js").createSignal;'
          : 'export { default as signal } from "common-bridge";',
      );
      const result = build(plugin);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(direct ? entry : "common-bridge/index.cjs");
      expect(result.output).toMatch(/require.*"solid-js".*ES module build/);
    });
  }, 30_000);
}

for (const part of ["client", "server"]) {
  test(`rejects a private Tokamak dependency in the ${part === "client" ? "window" : "server part"} bundle`, async () => {
    await withPlugin(async (plugin) => {
      await packageFiles(
        plugin,
        "@tokamak/review-private",
        {
          "index.js": 'export const secret = "private";',
          "index.d.ts": "export declare const secret: string;",
        },
        "./index.js",
      );
      await packageFiles(
        plugin,
        "private-bridge",
        {
          "index.js": 'export { secret } from "@tokamak/review-private";',
          "index.d.ts": "export declare const secret: string;",
        },
        "./index.js",
      );
      await Bun.write(
        join(plugin, part === "client" ? entry : "src/server/probe.ts"),
        'export { secret } from "private-bridge";',
      );
      const result = build(plugin);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('"@tokamak/review-private"');
      expect(result.output).toContain("private-bridge/index.js");
      expect(result.output).toContain("Allowed paths:");
    });
  }, 30_000);
}

for (const id of ["@tokamak/sdk/client", "@tokamak/sdk/solid", "@tokamak/runtime/router"]) {
  test(`server diagnostic rejects the window entry ${id}`, async () => {
    await withPlugin(async (plugin) => {
      await Bun.write(join(plugin, "src/server/wrong.ts"), `import ${JSON.stringify(id)};`);
      const result = build(plugin);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(JSON.stringify(id));
      expect(result.output).toContain("src/server/wrong.ts");
      expect(result.output).toMatch(/Allowed paths: @tokamak\/sdk(?:[,\n]|$)/);
      expect(result.output.match(/Allowed paths:[^\n]+/)[0]).not.toContain("@tokamak/runtime/router");
    });
  }, 30_000);
}

for (const id of ["@tokamak/sdk/web", "@tokamak/ui/theme.css"]) {
  test(`window runtime diagnostic rejects the build-only entry ${id}`, async () => {
    await withPlugin(async (plugin) => {
      await Bun.write(join(plugin, entry), `import ${JSON.stringify(id)};`);
      const result = build(plugin);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(JSON.stringify(id));
      expect(result.output).toContain(entry);
      expect(result.output).toContain(id.endsWith(".css") ? "stylesheet" : "types only");
    });
  }, 30_000);
}

for (const id of [
  "solid-js/refresh",
  "solid-js/internal",
  "solid-js/attribution",
  "solid-js/internal/container-trace",
  "@solidjs/web/jsx-runtime",
  "@solidjs/web/jsx-dev-runtime",
]) {
  test(`authored window code cannot import compiler entry ${id}`, async () => {
    await withPlugin(async (plugin) => {
      await Bun.write(join(plugin, entry), `import ${JSON.stringify(id)};`);
      const result = build(plugin);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(JSON.stringify(id));
      expect(result.output).toContain(entry);
      expect(result.output).toContain("Allowed paths:");
      expect(result.output.match(/Allowed paths:[^\n]+/)[0]).not.toContain(id);
    });
  }, 30_000);
}

test("a dependency cannot bundle a relative path into Solid", async () => {
  await withPlugin(async (plugin) => {
    await fakeSolid(plugin);
    const id = "../solid-js/dist/solid.js";
    await packageFiles(
      plugin,
      "bridge",
      {
        "index.js": `export { createSignal } from ${JSON.stringify(id)};`,
        "index.d.ts": "export declare const createSignal: () => string;",
      },
      "./index.js",
    );
    await Bun.write(join(plugin, entry), 'export { createSignal } from "bridge";');
    const result = build(plugin);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain(JSON.stringify(id));
    expect(result.output).toContain("bridge/index.js");
    expect(result.output).toContain("Allowed paths:");
  });
}, 30_000);
