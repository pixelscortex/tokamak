import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { clientSurface } from "../build/src/client-surface.ts";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const fixtures = resolve(import.meta.dirname, "tests/web/fixtures/parts");
const addon = resolve(fixtures, "addon");
const owner = resolve(fixtures, "owner/src/client/api.tsx");
const renamedOwner = resolve(fixtures, "owner/dist/rename-check");
const builder = resolve(import.meta.dirname, "../build/src/build.ts");
const build = (root: string) => execFileSync("proto", ["run", "bun", "--", builder, root]);
const builtAddon = "\0built-component-addon";
export default defineConfig({
  plugins: [
    {
      name: "built-component-addon",
      resolveId(id) {
        if (id === "virtual:built-component-addon") return builtAddon;
      },
      load(id) {
        if (id !== builtAddon) return;
        build(addon);

        const entry = resolve(renamedOwner, "src/main.tsx");
        mkdirSync(dirname(entry), { recursive: true });
        writeFileSync(
          resolve(renamedOwner, "package.json"),
          '{"name":"owner","version":"1.0.0","type":"module"}',
        );
        writeFileSync(resolve(renamedOwner, "plugin.ts"), readFileSync(resolve(fixtures, "owner/plugin.ts")));
        writeFileSync(
          entry,
          readFileSync(owner, "utf8")
            .replaceAll("SendButton", "PostButton")
            .replace('<div aria-label="body" />', '<div aria-label="notice" /><div aria-label="body" />'),
        );
        build(renamedOwner);
        return `
          export { default as manifest } from ${JSON.stringify(resolve(addon, "dist/manifest.json"))};
          export { Composer as RenamedComposer, parts as renamedParts } from ${JSON.stringify(resolve(renamedOwner, "dist/ui.js"))};
          export const loadActions = () => import(${JSON.stringify(resolve(addon, "dist/ui.js"))});
        `;
      },
    },
    clientSurface(
      () => resolve(import.meta.dirname, "tests/web/fixtures/parts/owner"),
      () => "owner",
    ),
    solid({ refresh: false }),
  ],
  resolve: {
    alias: [
      { find: "@plugins/owner/ui", replacement: owner },
      { find: "@tokamak/sdk/client", replacement: resolve(import.meta.dirname, "client.tsx") },
      {
        find: "./fixtures/parts/owner/src/client/_generated/components",
        replacement: resolve(import.meta.dirname, "tests/web/fixtures/parts/owner/src/client/api.tsx"),
      },
      {
        find: /^solid-js$/,
        replacement: resolve(dirname(require.resolve("solid-js/package.json")), "dist/solid.dev.js"),
      },
    ],
    dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"],
  },
  test: { environment: "jsdom", include: ["tests/web/*.test.tsx"] },
});
