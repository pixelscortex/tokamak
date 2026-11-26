import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { clientSurface } from "../build/src/client-surface.ts";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const fixtures = resolve(import.meta.dirname, "tests/web/fixtures/parts");
const addon = resolve(fixtures, "addon");
const owner = resolve(fixtures, "owner/src/client/api.tsx");
const builder = resolve(import.meta.dirname, "../build/src/build.ts");
const build = (root: string) => {
  const result = spawnSync("proto", ["run", "bun", "--", builder, root], {
    encoding: "utf8",
    env: { ...process.env, TOKAMAK_PLUGIN_DIR: fixtures },
  });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stdout + result.stderr);
  return result.stderr;
};
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
        build(resolve(fixtures, "owner"));
        build(addon);

        const original = readFileSync(owner, "utf8");
        const versions = {
          moved: original
            .replace(
              "<SendButton {...props} />",
              '<div data-part="send-slot"><SendButton {...props} /></div>',
            )
            .replace('<select aria-label="Upload" />', '<aside><select aria-label="Upload" /></aside>'),
          noUploadLabel: original.replace('<select aria-label="Upload" />', "<select />"),
          duplicate: original.replace(
            "const Region =",
            "export const Other = (props: ExampleProps) => <SendButton {...props} />; const Region =",
          ),
          changed: original
            .replaceAll("SendButton", "PostButton")
            .replace(
              '<div aria-label="body" />\n    <div aria-label="detail" />',
              '<div aria-label="detail" />\n    <div aria-label="body" />',
            ),
        };
        const exports: string[] = [];
        let warnings = "";
        let filteredWarnings = "";
        for (const [version, source] of Object.entries(versions)) {
          const root = resolve(fixtures, "owner/dist", version);
          const entry = resolve(root, "src/main.tsx");
          mkdirSync(dirname(entry), { recursive: true });
          writeFileSync(resolve(root, "package.json"), '{"name":"owner","version":"1.0.0","type":"module"}');
          writeFileSync(resolve(root, "plugin.ts"), readFileSync(resolve(fixtures, "owner/plugin.ts")));
          writeFileSync(entry, source);
          const log = build(root);
          if (version === "changed") warnings = log;
          else if (version === "noUploadLabel") filteredWarnings = log;
          else if (log.includes("skipping this addition")) throw new Error(log);
          exports.push(`export * as ${version} from ${JSON.stringify(resolve(root, "dist/ui.js"))};`);
        }
        return `
          export { default as manifest } from ${JSON.stringify(resolve(addon, "dist/manifest.json"))};
          ${exports.join("\n")}
          export const warnings = ${JSON.stringify(warnings)};
          export const filteredWarnings = ${JSON.stringify(filteredWarnings)};
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
