/** Internal application integration, not a configurable customer framework.
 * SDK discovery is confined to backend/; Vite/Solid compile src/main.tsx and
 * emit the static Blitz document, CSS, backend bundle, and original maps. */
import type { InlineConfig, PluginOption } from "vite";
import { definePlugin, type PluginDefinition } from "@tokamak/sdk";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compileCss } from "./css.ts";
import { nativeConfig, nativePlugins } from "./native.ts";

export function tokamak(options: { backend?: false; ui?: false; plugin?: PluginDefinition } = {}): PluginOption {
  let root: string;
  let plugin: Readonly<PluginDefinition>;
  return [
    ...(options.ui === false ? [] : nativePlugins()),
    {
      name: "tokamak-application",
      config(config, environment) {
        if (environment.command !== "build") {
          throw new Error("Tokamak is a native build; use its Moon run task, not a browser dev server");
        }
        // Explicit --config must work from the workspace root as well as Moon's
        // app cwd. For implicit discovery Vite already searches the project cwd.
        const configFile = (config as InlineConfig).configFile;
        root = typeof configFile === "string"
          ? dirname(resolve(configFile))
          : resolve(config.root ?? process.cwd());
        if (options.ui === false) {
          return { root, build: { target: "es2022", emptyOutDir: false, outDir: "dist",
            lib: { entry: resolve(root, ".tokamak-empty-ui.js"), name: "TokamakEmpty", formats: ["iife"], fileName: () => "ui.js" } } };
        }
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
      resolveId(id) {
        if (options.ui === false && id === resolve(root, ".tokamak-empty-ui.js")) return "\0tokamak-empty-ui";
      },
      load(id) { if (id === "\0tokamak-empty-ui") return "export {};"; },
      async buildStart() {
        const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
        plugin = definePlugin(options.plugin ?? {
          id: String(manifest.name).replace(/^@/, "").replaceAll("/", "."),
          version: manifest.version ?? "0.1.0",
        });
        const entries: Record<string, unknown> = {};
        if (options.backend !== false) {
          // SDK discovery/checking is Bun-only. Invoke its existing pinned entry
          // even if Vite itself was launched through Node's standard CLI.
          const bundled = spawnSync("proto", [
            "run", "bun", "--",
            fileURLToPath(new URL("../../sdk/tools/bundle.mjs", import.meta.url)),
            resolve(root, "backend"),
            ...(options.plugin ? ["--plugin", plugin.id] : []),
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
          // References are source-aware, matching the existing SDK contract.
          // Rebase only its generated type-import specifiers, not user code.
          const api = (await readFile(resolve(root, "backend/_generated/api.ts"), "utf8"))
            .replaceAll('import("../', 'import("../backend/');
          this.emitFile({ type: "asset", fileName: "api.ts", source: api });
          entries.backend = { code: "bundle.js", map: "bundle.js.map", api: "api.ts" };
        }
        if (options.ui !== false) {
          const css = await compileCss(resolve(root, "src/styles.css"));
          this.emitFile({ type: "asset", fileName: "styles.css", source: css });
          this.emitFile({
            type: "asset",
            fileName: "shell.html",
            source: `<!doctype html>\n<html><head><style>${css}</style></head><body><div id="app"></div></body></html>\n`,
          });
          entries.ui = { code: "ui.js", map: "ui.js.map", css: "styles.css", shell: "shell.html" };
        }
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source: JSON.stringify({ formatVersion: 1, plugin, entries }, null, 2) + "\n",
        });
      },
      generateBundle(_options, bundle) {
        if (options.ui === false) delete bundle["ui.js"];
        // Commit the hashes of final emitted bytes, not intermediate compiler
        // inputs. A loader snapshots and verifies these before evaluating code.
        const manifest = bundle["manifest.json"];
        if (!manifest || manifest.type !== "asset") throw new Error("Missing artifact manifest");
        const hashes: Record<string, string> = {};
        for (const [name, file] of Object.entries(bundle)) {
          if (name === "manifest.json") continue;
          hashes[name] = createHash("sha256").update(file.type === "chunk" ? file.code : file.source).digest("hex");
        }
        const metadata = JSON.parse(String(manifest.source));
        manifest.source = JSON.stringify({ ...metadata, hashes }, null, 2) + "\n";
      },
    },
  ];
}
