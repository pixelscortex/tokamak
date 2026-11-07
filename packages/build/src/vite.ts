/** Internal application integration, not a configurable customer framework.
 * SDK discovery is confined to backend/; Vite/Solid compile src/main.tsx and
 * emit the static Blitz document, CSS, backend bundle, and original maps. */
import type { InlineConfig, PluginOption } from "vite";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileCss } from "./css.ts";
import { nativeConfig, nativePlugins } from "./native.ts";

export function tokamak(): PluginOption {
  let root: string;
  return [
    ...nativePlugins(),
    {
      name: "tokamak-application",
      config(config, environment) {
        if (environment.command !== "build") {
          throw new Error("Tokamak is a native build; use moon run app:run, not a browser dev server");
        }
        // Explicit --config must work from the workspace root as well as Moon's
        // app cwd. For implicit discovery Vite already searches the project cwd.
        const configFile = (config as InlineConfig).configFile;
        root = typeof configFile === "string"
          ? dirname(resolve(configFile))
          : resolve(config.root ?? process.cwd());
        const renderer = createRequire(resolve(root, "package.json")).resolve("@tokamak/render");
        const { plugins: _plugins, ...native } = nativeConfig(
          resolve(dirname(renderer), ".."),
          {
            entry: resolve(root, "src/main.tsx"),
            outDir: resolve(root, "dist"),
            fileName: "ui.js",
          },
        );
        return { ...native, root };
      },
      async buildStart() {
        // SDK discovery/checking is Bun-only. Invoke its existing pinned entry
        // even if Vite itself was launched through Node's standard CLI.
        const bundled = spawnSync("proto", [
          "run", "bun", "--",
          fileURLToPath(new URL("../../sdk/tools/bundle.mjs", import.meta.url)),
          resolve(root, "backend"),
        ], { stdio: "inherit" });
        if (bundled.error) throw bundled.error;
        if (bundled.status !== 0) throw new Error("SDK backend bundling failed");
        const bundle = resolve(root, "backend/dist/bundle.js");
        const source = await readFile(bundle, "utf8");
        const map = JSON.parse(await readFile(`${bundle}.map`, "utf8"));
        // SDK maps are relative to backend/dist. Rebase source names when the
        // unchanged bundle is packaged into app/dist; retain original contents.
        map.sources = map.sources.map((source: string) =>
          relative(resolve(root, "dist"), resolve(dirname(bundle), source)).split(sep).join("/"),
        );
        this.emitFile({ type: "asset", fileName: "bundle.js", source });
        this.emitFile({ type: "asset", fileName: "bundle.js.map", source: JSON.stringify(map) });
        const css = await compileCss(resolve(root, "src/styles.css"));
        this.emitFile({
          type: "asset",
          fileName: "shell.html",
          source: `<!doctype html>\n<html><head><style>${css}</style></head><body><div id="app"></div></body></html>\n`,
        });
      },
    },
  ];
}
