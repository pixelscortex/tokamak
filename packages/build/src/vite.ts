/** Internal application integration, not a configurable customer framework.
 * SDK discovery uses src/server/; Vite/Solid compile src/client/api.ts and
 * emit the static Blitz document, CSS, backend bundle, and original maps. */
import type { InlineConfig, PluginOption } from "vite";
import { definePlugin, type PluginDefinition } from "@tokamak/sdk";
import { dirname, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pluginImports } from "./plugin-imports.ts";
import { artifactBundle } from "./artifact-bundle.ts";
import { publicFunctions } from "./exports.ts";
import { compileCss } from "./css.ts";
import { uiContributions } from "./contributions.ts";
import { nativeSolid } from "./native.ts";
import { nativePlugins } from "./native.ts";
import { clientSurface } from "./client-surface.ts";
import {
  readDescriptor,
  serverDirectory,
  clientEntry,
  deriveInterfaces,
  deriveProviders,
} from "./descriptor.ts";
import { uiBuildConfig } from "./ui-build-config.ts";

export function tokamak(
  options: { backend?: false; ui?: false; plugin?: PluginDefinition; standalone?: boolean } = {},
): PluginOption {
  let root: string;
  let plugin: Readonly<PluginDefinition>;
  return [
    ...(!options.standalone && options.ui !== false
      ? [
          clientSurface(
            () => root,
            () => plugin.id,
          ),
        ]
      : []),
    ...(options.ui === false ? [] : options.standalone ? nativePlugins() : [nativeSolid()]),
    {
      name: "tokamak-application",
      config(config, environment) {
        if (environment.command !== "build") {
          throw new Error("Tokamak is a native build; use its Moon run task, not a browser dev server");
        }
        // Explicit --config must work from the workspace root as well as Moon's
        // app cwd. For implicit discovery Vite already searches the project cwd.
        const configFile = (config as InlineConfig).configFile;
        root =
          typeof configFile === "string"
            ? dirname(resolve(configFile))
            : resolve(config.root ?? process.cwd());
        if (existsSync(resolve(root, "plugin.ts"))) {
          if (!existsSync(resolve(root, "src/server"))) options.backend = false;
          if (!existsSync(resolve(root, "src/client"))) options.ui = false;
        }
        return uiBuildConfig(root, options);
      },
      // Run on emitted JS after type erasure/Solid, so type queries never look
      // like runtime imports. Computed imports cannot be safely classified as
      // plugin versus host names and are forbidden in plugin UI artifacts.
      transform: pluginImports(options),
      resolveId(id) {
        if (options.ui === false && id === resolve(root, ".tokamak-empty-ui.js")) return "\0tokamak-empty-ui";
      },
      load(id) {
        if (id === "\0tokamak-empty-ui") return "export {};";
      },
      async buildStart() {
        const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
        plugin = definePlugin(
          options.plugin ??
            readDescriptor(root) ?? {
              id: String(manifest.name).replace(/^@/, "").replaceAll("/", "."),
              version: manifest.version ?? "0.1.0",
            },
        );
        const server = serverDirectory(root);
        if (existsSync(resolve(root, "plugin.ts"))) {
          plugin = definePlugin({
            ...plugin,
            ...deriveInterfaces(root),
            ...(existsSync(resolve(server, "api.ts")) ? { exports: "./src/server/api.ts" } : {}),
          });
        }
        if (options.ui !== false && !options.standalone) {
          const ui = uiContributions(root);
          plugin = definePlugin({ ...plugin, contributes: ui.contributes });
        }
        const entries: Record<string, unknown> = {};
        if (options.backend === false && plugin.exports !== undefined)
          throw new Error("Plugin exports require a backend");
        if (options.backend !== false) {
          // SDK discovery/checking is Bun-only. Invoke its existing pinned entry
          // even if Vite itself was launched through Node's standard CLI.
          const bundled = spawnSync(
            "proto",
            [
              "run",
              "bun",
              "--",
              fileURLToPath(new URL("../../sdk/tools/bundle.mjs", import.meta.url)),
              server,
              "--plugin",
              plugin.id,
              ...(plugin.runtime === "worker" ? ["--worker"] : []),
            ],
            { stdio: "inherit" },
          );
          if (bundled.error) throw bundled.error;
          if (bundled.status !== 0) throw new Error("SDK backend bundling failed");
          // The bundle's describe() carries the schema/index registry evaluated
          // in QuickJS. Keep that source authoritative instead of importing user
          // schema modules into the build host or duplicating them in manifests.
          const bundle = resolve(server, "dist/bundle.js");
          const source = await readFile(bundle, "utf8");
          const map = JSON.parse(await readFile(`${bundle}.map`, "utf8"));
          // SDK maps are relative to the server half’s dist/. Rebase source names when the
          // unchanged bundle is packaged into app/dist; retain original contents.
          map.sources = map.sources.map((source: string) =>
            relative(resolve(root, "dist"), resolve(dirname(bundle), source))
              .split(sep)
              .join("/"),
          );
          this.emitFile({ type: "asset", fileName: "bundle.js", source });
          this.emitFile({ type: "asset", fileName: "bundle.js.map", source: JSON.stringify(map) });
          // References are source-aware, matching the existing SDK contract.
          // Rebase only its generated type-import specifiers, not user code.
          const api = (await readFile(resolve(server, "_generated/api.ts"), "utf8")).replaceAll(
            'import("../',
            `import("../${relative(root, server).split(sep).join("/")}/`,
          );
          this.emitFile({ type: "asset", fileName: "api.ts", source: api });
          if (plugin.runtime === "worker") {
            for (const name of ["worker.js", "worker.js.map", "worker-entry.js"]) {
              this.emitFile({
                type: "asset",
                fileName: name,
                source: await readFile(resolve(server, "dist", name), "utf8"),
              });
            }
            entries.worker = { entry: "worker-entry.js", code: "worker.js", map: "worker.js.map" };
          }
          entries.backend = { code: "bundle.js", map: "bundle.js.map", api: "api.ts" };
        }
        if (options.ui !== false) {
          const cssPath = resolve(dirname(clientEntry(root)), "styles.css");
          const css = !options.standalone && !existsSync(cssPath) ? "" : await compileCss(cssPath);
          this.emitFile({ type: "asset", fileName: "styles.css", source: css });
          this.emitFile({
            type: "asset",
            fileName: "shell.html",
            source: `<!doctype html>\n<html><head><style>${css}</style></head><body><div id="app"></div></body></html>\n`,
          });
          entries.ui = { code: "ui.js", map: "ui.js.map", css: "styles.css", shell: "shell.html" };
        }
        const functions = publicFunctions(root, plugin.exports);
        if (existsSync(resolve(root, "plugin.ts")))
          plugin = definePlugin({ ...plugin, provides: deriveProviders(root, plugin, functions) });
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source:
            JSON.stringify({ formatVersion: 1, plugin, entries, publicFunctions: functions }, null, 2) + "\n",
        });
      },
      generateBundle(_options, bundle, isWrite) {
        return artifactBundle(root, plugin, options).call(this, _options, bundle, isWrite);
      },
    },
  ];
}
