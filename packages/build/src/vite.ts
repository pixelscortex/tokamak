import { normalizePath, type InlineConfig, type PluginOption } from "vite";
import { definePlugin, type PluginDefinition } from "@tokamak/sdk";
import { declaresAccessTo } from "../../sdk/src/plugin";
import { dirname, relative, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPluginImports } from "../../sdk/tools/plugin-boundary.mjs";
import { contractDeclarations, contractEntry } from "../../sdk/tools/contracts.mjs";
import { serverDirectory } from "../../sdk/tools/server-files.mjs";
import { httpActionEntry } from "../../sdk/tools/http-actions.mjs";
import {
  functionPlacement,
  lanes,
  moduleName,
  runnerFunction,
  runnerProvider,
} from "../../sdk/tools/placement.mjs";
import { pluginBoundary } from "./plugin-boundary.ts";
import { uiContributions } from "./contributions.ts";
import { artifactBundle, stripSourcesContent } from "./artifact-bundle.ts";
import solid from "@solidjs/vite-plugin";
import { clientSurface } from "./client-surface.ts";
import { uiBuildConfig, clientAssets } from "./ui-build-config.ts";
import { exportedFunctions } from "./exports.ts";
import { readDescriptor, clientEntry } from "./descriptor.ts";
import { warnMissingHookTargets } from "./hook-targets.ts";
import { signInDependency } from "./auth-dependencies.ts";

export const PLUGIN_UI_BUILD_ENABLED = true;

export function tokamak(
  options: { backend?: false; ui?: false; plugin?: PluginDefinition; pluginCatalog?: string } = {},
): PluginOption {
  let root: string;
  let plugin: Readonly<PluginDefinition>;
  let placement: ReturnType<typeof functionPlacement>;
  let ui: ReturnType<typeof uiContributions> | undefined;
  let hasLocal = false;
  let stripClientSources = false;
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
        root = realpathSync(root);
        checkPluginImports(root, (options.plugin ?? readDescriptor(root))?.depends ?? {});
        placement = functionPlacement(root);
        stripClientSources = false;
        const server = serverDirectory(root);
        // A flat src/ may contain only window code. Enable function bundling
        // there only when placement finds definitions or a schema needs a server entry.
        if (
          existsSync(resolve(root, "plugin.ts")) &&
          (!existsSync(server) ||
            (server === resolve(root, "src") &&
              !placement?.modules.size &&
              !placement?.providers.length &&
              !contractDeclarations(contractEntry(root)).length &&
              !existsSync(resolve(server, "schema.ts"))))
        )
          options.backend = false;
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
        hasLocal =
          !!placement &&
          ([...placement.modules.values()].some((exports) =>
            [...exports.values()].some((definition) => runnerFunction(definition.kind)),
          ) ||
            placement.providers.some(runnerProvider));
        const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
        plugin = definePlugin(
          options.plugin ??
            readDescriptor(root) ?? {
              id: String(manifest.name).replace(/^@/, "").replaceAll("/", "."),
              version: manifest.version ?? "0.1.0",
            },
        );
        if (options.ui !== false) ui = uiContributions(root, plugin.id, (message) => this.warn(message));
        const signIn = signInDependency(root, plugin, options.pluginCatalog);
        if (signIn)
          throw new Error(`Plugin ${plugin.id} lists ${signIn} as a dependency; depend on auth instead`);
        const server = serverDirectory(root);
        if (existsSync(resolve(root, "plugin.ts"))) {
          plugin = definePlugin({
            ...plugin,
            ...(existsSync(resolve(server, "api.ts"))
              ? { exports: "./" + relative(root, resolve(server, "api.ts")).split(sep).join("/") }
              : {}),
          });
        }
        const entries: Record<string, unknown> = {};
        let contracts: object = {};
        for (const provider of placement?.providers ?? []) {
          const owner = provider.owner;
          if (owner && !declaresAccessTo(plugin, owner)) {
            throw new Error(
              `Provider for ${owner}/${provider.name}: declare ${owner} in depends or optional`,
            );
          }
        }
        if (options.backend === false && hasLocal)
          throw new Error("Caller actions require the function build");
        if (options.backend === false && plugin.exports !== undefined)
          throw new Error("Plugin exports require a backend");
        if (options.backend !== false) {
          // Reuse the builder's Bun from any cwd. The checkout pins Bun for Node's Vite CLI.
          const transactions = resolve(server, "dist/transactions.js");
          await rm(transactions, { force: true });
          await rm(`${transactions}.map`, { force: true });
          const usingBun = !!process.versions.bun;
          const bundled = spawnSync(
            usingBun ? process.execPath : "proto",
            [
              ...(usingBun ? [] : ["run", "bun", "--"]),
              fileURLToPath(new URL("../../sdk/tools/bundle.mjs", import.meta.url)),
              server,
              "--plugin",
              plugin.id,
              ...(options.plugin ? ["--depends", JSON.stringify(plugin.depends ?? {})] : []),
            ],
            { stdio: "inherit", ...(usingBun ? {} : { cwd: import.meta.dirname }) },
          );
          if (bundled.error) throw bundled.error;
          if (bundled.status !== 0) throw new Error("SDK backend bundling failed");
          contracts = JSON.parse(await readFile(resolve(server, "dist/contracts.json"), "utf8"));
          // The bundle's describe() carries the schema/index registry evaluated
          // in QuickJS. Keep that source authoritative instead of importing user
          // schema modules into the build host or duplicating them in manifests.
          const bundle = resolve(server, "dist/bundle.js");
          const source = await readFile(bundle, "utf8");
          const map = JSON.parse(await readFile(`${bundle}.map`, "utf8"));
          if (hasLocal) stripSourcesContent(map);
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
          entries.server = { code: "bundle.js", map: "bundle.js.map", api: "api.ts" };
          if (existsSync(transactions)) {
            for (const name of ["transactions.js", "transactions.js.map"]) {
              let source = await readFile(resolve(server, "dist", name), "utf8");
              if (hasLocal && name.endsWith(".map")) {
                const map = JSON.parse(source);
                stripSourcesContent(map);
                source = JSON.stringify(map);
              }
              this.emitFile({ type: "asset", fileName: name, source });
            }
          }
          const http = placement && httpActionEntry(placement, server, server !== resolve(root, "src"));
          if (http) {
            const code = "http-actions.js";
            const map = code + ".map";
            for (const name of [code, map])
              this.emitFile({
                type: "asset",
                fileName: name,
                source: await readFile(resolve(server, "dist", name), "utf8"),
              });
            entries.http = { code, map, paths: http.paths };
          }
          if (hasLocal) {
            for (const name of ["local.js", "local.js.map", "local-entry.js"]) {
              let source = await readFile(resolve(server, "dist", name), "utf8");
              if (name.endsWith(".map")) {
                // Original mixed modules can contain handlers from the other lanes.
                const map = JSON.parse(source);
                stripSourcesContent(map);
                source = JSON.stringify(map);
              }
              this.emitFile({ type: "asset", fileName: name, source });
            }
            entries.local = { entry: "local-entry.js", code: "local.js", map: "local.js.map" };
          }
        }
        const functions = exportedFunctions(root, plugin.exports);
        const hookTargets = new Set<string>();
        const hookable = new Set<string>();
        for (const [path, definitions] of placement?.modules ?? []) {
          const module = moduleName(server, path, server === resolve(root, "src/server"));
          for (const [name, definition] of definitions) {
            if (definition.target) hookTargets.add(definition.target);
            if (["query", "mutation", "action"].includes(definition.kind)) {
              const key = `${plugin.id}/${module}:${name}`;
              hookable.add(key);
              for (const point of definition.points?.keys() ?? []) hookable.add(`${key}#${point}`);
            }
          }
        }
        warnMissingHookTargets(root, plugin.id, hookable, options.pluginCatalog, (message) =>
          this.warn(message),
        );
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source:
            JSON.stringify(
              {
                formatVersion: 1,
                plugin,
                entries,
                publicFunctions: functions.publicFunctions,
                ...(functions.pluginFunctions.length ? { pluginFunctions: functions.pluginFunctions } : {}),
                ...(hookTargets.size ? { hookTargets: [...hookTargets].sort() } : {}),
                ...contracts,
              },
              null,
              2,
            ) + "\n",
        });
      },
      generateBundle: {
        order: "post",
        handler(_options, bundle, isWrite) {
          return artifactBundle(ui?.contributes ?? {}, plugin, { ...options, stripClientSources }).call(
            this,
            _options,
            bundle,
            isWrite,
          );
        },
      },
    },
    clientAssets(() => root),
    clientSurface(
      () => root,
      () => plugin.id,
      (id) => {
        const edits = placement?.edits(id, lanes.window) ?? [];
        if (edits.length) stripClientSources = true;
        return [...edits, ...(ui?.edits.get(id) ?? [])];
      },
      options.pluginCatalog,
    ),
    solid(),
  ];
}
