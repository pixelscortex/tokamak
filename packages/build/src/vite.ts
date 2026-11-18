import { normalizePath, type InlineConfig, type PluginOption } from "vite";
import { definePlugin, type PluginDefinition } from "@tokamak/sdk";
import { dirname, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPluginImports } from "../../sdk/tools/plugin-boundary.mjs";
import { pluginBoundary } from "./plugin-boundary.ts";
import { artifactBundle } from "./artifact-bundle.ts";
import solid from "@solidjs/vite-plugin";
import { clientSurface } from "./client-surface.ts";
import { uiBuildConfig, clientAssets } from "./ui-build-config.ts";
import { publicFunctions } from "./exports.ts";
import {
  readDescriptor,
  serverDirectory,
  deriveInterfaces,
  deriveProviders,
  clientEntry,
} from "./descriptor.ts";

export const PLUGIN_UI_BUILD_ENABLED = true;

export function tokamak(
  options: { backend?: false; ui?: false; plugin?: PluginDefinition } = {},
): PluginOption {
  let root: string;
  let plugin: Readonly<PluginDefinition>;
  return [
    pluginBoundary(() => root),
    {
      name: "tokamak-application",
      config(config, environment) {
        if (environment.command !== "build") {
          throw new Error("Plugin artifacts require a build");
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
        if (!existsSync(clientEntry(root))) options.ui = false;
        if (options.ui !== false) return uiBuildConfig(root);
        if (options.backend === false) throw new Error("Plugin has no enabled targets");
        return {
          root,
          build: {
            target: "es2022",
            emptyOutDir: false,
            outDir: "dist",
            lib: {
              entry: resolve(root, ".tokamak-backend-entry.js"),
              formats: ["es"],
              fileName: () => ".tokamak-backend-entry.js",
            },
          },
        };
      },
      resolveId(id) {
        if (normalizePath(id) === normalizePath(resolve(root, ".tokamak-backend-entry.js")))
          return "\0tokamak-backend-entry";
      },
      load(id) {
        if (id === "\0tokamak-backend-entry") return "export {};";
      },
      async buildStart() {
        checkPluginImports(root);
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
      generateBundle: {
        order: "post",
        handler(_options, bundle, isWrite) {
          return artifactBundle(root, plugin, options).call(this, _options, bundle, isWrite);
        },
      },
    },
    clientAssets(() => root),
    clientSurface(
      () => root,
      () => plugin.id,
    ),
    solid(),
  ];
}
