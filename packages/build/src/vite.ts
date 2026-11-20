import { normalizePath, type InlineConfig, type PluginOption } from "vite";
import { definePlugin, type PluginDefinition } from "@tokamak/sdk";
import { dirname, relative, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPluginImports } from "../../sdk/tools/plugin-boundary.mjs";
import { pluginBoundary } from "./plugin-boundary.ts";
import { artifactBundle } from "./artifact-bundle.ts";
import solid from "@solidjs/vite-plugin";
import { clientSurface } from "./client-surface.ts";
import { uiBuildConfig, clientAssets } from "./ui-build-config.ts";
import { BuildError, checkerDiagnostics } from "./diagnostics.ts";
import { installPluginPackages, readPluginPackage } from "./plugin-packages.ts";
import { publicTypes } from "./public-types.ts";
import { publicFunctions } from "./exports.ts";
import {
  readSourcePlugin,
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
        root = realpathSync(
          typeof configFile === "string"
            ? dirname(resolve(configFile))
            : resolve(config.root ?? process.cwd()),
        );
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
        const manifest = await readPluginPackage(root);
        if (manifest) await installPluginPackages(root, manifest);
        plugin = options.plugin
          ? definePlugin(options.plugin)
          : await readSourcePlugin(root, manifest ?? null);
        await checkPluginImports(root, console.warn, Object.keys(plugin.depends ?? {}));
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
              "--prepared-types",
            ],
            { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
          );
          if (bundled.error) throw bundled.error;
          process.stdout.write(bundled.stdout);
          process.stderr.write(bundled.stderr);
          if (bundled.status !== 0) {
            const diagnostics = checkerDiagnostics(
              bundled.stdout + "\n" + bundled.stderr,
              realpathSync(server),
            );
            throw new BuildError(
              diagnostics.length ? diagnostics : [{ message: "SDK server part bundling failed" }],
            );
          }
          // The bundle's describe() carries the schema/index registry evaluated
          // in QuickJS. Keep that source authoritative instead of importing user
          // schema modules into the build host or duplicating them in manifests.
          const bundle = resolve(server, "dist/bundle.js");
          const source = await readFile(bundle, "utf8");
          const map = JSON.parse(await readFile(`${bundle}.map`, "utf8"));
          // Keep source locations for stack traces without shipping the original source.
          delete map.sourcesContent;
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
              const contents = await readFile(resolve(server, "dist", name), "utf8");
              let source = contents;
              if (name.endsWith(".map")) {
                const map = JSON.parse(contents);
                delete map.sourcesContent;
                source = JSON.stringify(map);
              }
              this.emitFile({ type: "asset", fileName: name, source });
            }
            entries.worker = { entry: "worker-entry.js", code: "worker.js", map: "worker.js.map" };
          }
          entries.backend = { code: "bundle.js", map: "bundle.js.map", api: "api.ts" };
        }
        const functions = publicFunctions(root, plugin.exports);
        entries.types = "public.d.ts";
        if (existsSync(resolve(root, "plugin.ts")))
          plugin = definePlugin({ ...plugin, provides: deriveProviders(root, plugin, functions) });
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source:
            JSON.stringify({ formatVersion: 1, plugin, entries, publicFunctions: functions }, null, 2) + "\n",
        });
      },
      buildEnd(error) {
        if (error) return;
        // Report boundary failures from the bundle before checking the declarations.
        this.emitFile({
          type: "asset",
          fileName: "public.d.ts",
          source: publicTypes(root, plugin.id, options),
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
