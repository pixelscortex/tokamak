import { test, expect } from "bun:test";
import { build } from "vite";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { tokamak } from "../src/vite";
import { hostModule } from "../src/ui-build-config";

async function browserFixture() {
  const parent = await mkdtemp(resolve(await realpath(tmpdir()), "tokamak-browser-"));
  try {
    for (const name of ["browser", "other"]) {
      await cp(resolve(import.meta.dir, "fixtures", name), resolve(parent, name), {
        recursive: true,
        filter: (path) => !path.split("/").includes("dist"),
      });
    }
    await writeFile(
      resolve(parent, "browser/tsconfig.json"),
      JSON.stringify({
        extends: resolve(import.meta.dir, "../../../app/tsconfig.json"),
        include: ["src"],
      }),
    );
    await build({ root: resolve(parent, "other"), configFile: false, plugins: [tokamak()] });
    return { parent, root: resolve(parent, "browser") };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

test("browser plugin emits DOM ESM with host imports, contributions and qualified names", async () => {
  const { parent, root } = await browserFixture();
  try {
    const result = await build({ root, configFile: false, plugins: [tokamak()], build: { write: false } });
    const output = Array.isArray(result) ? result[0]! : result;
    if (!("output" in output)) throw new Error("Expected one build");
    const ui = output.output.find((file) => file.fileName === "ui.js");
    if (!ui || ui.type !== "chunk") throw new Error("Missing UI");
    expect(ui.code).toContain("export {");
    expect(ui.code).not.toContain("__tokamakModules");
    expect(ui.imports).toContain("@solidjs/web");
    expect(ui.imports).toContain("solid-js");
    expect(ui.imports).toContain("@tokamak/sdk/client");
    expect(ui.dynamicImports).toContain("@plugins/other/ui");
    expect(ui.code).toContain("useQuery");
    expect(ui.code).toContain("browser-fixture.actions");
    expect(ui.code).toContain("browser-fixture.Panel");
    const manifest = output.output.find((file) => file.fileName === "manifest.json");
    if (!manifest || manifest.type !== "asset") throw new Error("Missing manifest");
    const metadata = JSON.parse(String(manifest.source));
    expect(metadata.entries.ui).toEqual({ code: "ui.js", map: "ui.js.map", css: "styles.css" });
    expect(metadata.plugin.contributes.view).toEqual([{ id: "FixtureView", route: "/fixture" }]);
    expect(metadata.plugin.optional.other).toBe("*");
    expect(metadata.hashes["ui.js"]).toMatch(/^[a-f0-9]{64}$/);
    for (const id of [
      "solid-js",
      "solid-js/refresh",
      "@solidjs/web",
      "@tokamak/sdk",
      "@tokamak/sdk/solid",
      "@tokamak/sdk/client",
      "@tokamak/ui",
      "@tokamak/runtime/router",
      "@ui-sdk/solid/button",
      "@ui-sdk/core/button",
      "@plugins/other",
      "@plugins/other/ui",
    ])
      expect(hostModule(id)).toBe(true);
    for (const id of ["solid-js/store", "@tokamak/ui/button", "@tokamak/runtime", "@tokamak/runtime/plugins"])
      expect(hostModule(id)).toBe(false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 30000);

test("static plugin imports infer dependencies and styles remain optional", async () => {
  const { parent, root } = await browserFixture();
  try {
    const required = resolve(parent, "required");
    await mkdir(resolve(required, "src/client"), { recursive: true });
    await writeFile(
      resolve(required, "plugin.ts"),
      'import { definePlugin } from "@tokamak/sdk"; export default definePlugin({id: "required", version: "1.0.0"});',
    );
    await writeFile(resolve(required, "src/client/api.ts"), 'export const Remote = "remote";');
    await build({ root: required, configFile: false, plugins: [tokamak()] });
    await rm(resolve(root, "src/client/styles.css"));
    const entry = resolve(root, "src/client/api.ts");
    await writeFile(
      entry,
      `${await readFile(entry, "utf8")}\nexport { Remote } from "plugin:required/client";`,
    );
    const result = await build({ root, configFile: false, plugins: [tokamak()], build: { write: false } });
    const output = Array.isArray(result) ? result[0]! : result;
    if (!("output" in output)) throw new Error("Expected one build");
    const ui = output.output.find((file) => file.fileName === "ui.js");
    if (!ui || ui.type !== "chunk") throw new Error("Missing UI");
    expect(ui.imports).toContain("@plugins/required/ui");
    const manifest = output.output.find((file) => file.fileName === "manifest.json");
    if (!manifest || manifest.type !== "asset") throw new Error("Missing manifest");
    const metadata = JSON.parse(String(manifest.source));
    expect(metadata.plugin.depends.required).toBe("*");
    expect(metadata.entries.ui).toEqual({ code: "ui.js", map: "ui.js.map" });
    expect(metadata.hashes["styles.css"]).toBeUndefined();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 30000);

test("a view may name an icon as a literal or a const path; anything else fails the build", async () => {
  const { parent, root } = await browserFixture();
  const path = "M4 4H20V20H4Z";
  const contributes = async () => {
    const result = await build({
      root,
      configFile: false,
      plugins: [tokamak()],
      build: { write: false },
      logLevel: "silent",
    });
    const output = Array.isArray(result) ? result[0]! : result;
    if (!("output" in output)) throw new Error("Expected one build");
    const manifest = output.output.find((file) => file.fileName === "manifest.json");
    if (!manifest || manifest.type !== "asset") throw new Error("Missing manifest");
    return JSON.parse(String(manifest.source)).plugin.contributes.view;
  };
  try {
    const view = resolve(root, "src/client/view.tsx");
    const original = await readFile(view, "utf8");
    const withOptions = (options: string, prefix = "") =>
      writeFile(view, prefix + original.replace('view({ route: "/fixture" }', `view(${options}`));

    await withOptions(`{ route: "/fixture", icon: "${path}" }`);
    expect(await contributes()).toEqual([{ id: "FixtureView", route: "/fixture", icon: path }]);
    await withOptions(`{ route: "/fixture", icon: mark }`, `const mark = "${path}";\n`);
    expect(await contributes()).toEqual([{ id: "FixtureView", route: "/fixture", icon: path }]);
    for (const [options, prefix] of [
      [`{ route: "/fixture", icon: "<svg/>" }`, ""],
      [`{ route: "/fixture", icon: mark }`, `let mark = String(Date.now());\n`],
      [`{ route: "/fixture", title: "Fixture" }`, ""],
    ]) {
      await withOptions(options!, prefix);
      await expect(contributes()).rejects.toThrow("static literal options");
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 60000);
