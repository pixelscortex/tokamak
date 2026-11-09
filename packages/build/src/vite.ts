/** Internal application integration, not a configurable customer framework.
 * SDK discovery is confined to backend/; Vite/Solid compile src/main.tsx and
 * emit the static Blitz document, CSS, backend bundle, and original maps. */
import ts from "typescript";
import MagicString from "magic-string";
import type { InlineConfig, PluginOption } from "vite";
import { definePlugin, type PluginDefinition } from "@tokamak/sdk";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { publicFunctions } from "./exports.ts";
import { compileCss } from "./css.ts";
import { uiContributions } from "./contributions.ts";
import { nativeSolid } from "./native.ts";
import { nativeConfig, nativePlugins } from "./native.ts";

export function tokamak(options: { backend?: false; ui?: false; plugin?: PluginDefinition; standalone?: boolean } = {}): PluginOption {
  let root: string;
  let plugin: Readonly<PluginDefinition>;
  return [
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
        if (options.standalone) return { ...native, root };
        return { ...native, root, build: { ...native.build,
          lib: { entry: resolve(root, "src/main.tsx"), formats: ["cjs"], fileName: () => "ui.js" },
          rollupOptions: { external: id => /^(solid-js(?:$|\/)|@tokamak\/|@plugins\/)/.test(id),
            output: { exports: "named", codeSplitting: false } },
        } };
      },
      // Run on emitted JS after type erasure/Solid, so type queries never look
      // like runtime imports. Computed imports cannot be safely classified as
      // plugin versus host names and are forbidden in plugin UI artifacts.
      transform: {
        order: "post",
        handler(code, id) {
          if (options.ui === false || options.standalone || !/\.[cm]?[jt]sx?(?:\?|$)/.test(id)) return;
          const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
          const edits: { start: number; end: number; text: string }[] = [];
          function visit(node: ts.Node) {
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
              const arg = node.arguments[0];
              if (!arg || !ts.isStringLiteralLike(arg)) throw new Error(`Dynamic plugin imports require a string literal: ${id}. Use import("@plugins/<id>/ui").`);
              const match = /^@plugins\/([^/]+)(?:\/ui)?$/.exec(arg.text);
              if (match) edits.push({ start: node.getStart(source), end: node.end,
                text: `__tokamakModules.load(${JSON.stringify(`@plugins/${match[1]}/ui`)})` });
            }
            ts.forEachChild(node, visit);
          }
          visit(source);
          if (!edits.length) return;
          const output = new MagicString(code);
          for (const edit of edits) output.overwrite(edit.start, edit.end, edit.text);
          return { code: output.toString(), map: output.generateMap({ source: id, includeContent: true, hires: true }) };
        },
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
        if (options.ui !== false && !options.standalone) {
          const ui = uiContributions(root);
          plugin = definePlugin({ ...plugin, contributes: ui.contributes });
        }
        const entries: Record<string, unknown> = {};
        if (options.backend === false && plugin.exports !== undefined) throw new Error("Plugin exports require a backend");
        if (options.backend !== false) {
          // SDK discovery/checking is Bun-only. Invoke its existing pinned entry
          // even if Vite itself was launched through Node's standard CLI.
          const bundled = spawnSync("proto", [
            "run", "bun", "--",
            fileURLToPath(new URL("../../sdk/tools/bundle.mjs", import.meta.url)),
            resolve(root, "backend"),
            "--plugin", plugin.id,
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
          const cssPath = resolve(root, "src/styles.css");
          const css = !options.standalone && !existsSync(cssPath) ? "" : await compileCss(cssPath);
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
          source: JSON.stringify({ formatVersion: 1, plugin, entries, publicFunctions: publicFunctions(root, plugin.exports) }, null, 2) + "\n",
        });
      },
      generateBundle(_options, bundle) {
        if (options.ui === false) delete bundle["ui.js"];
        if (options.ui !== false && !options.standalone) {
          const ui = bundle["ui.js"];
          if (!ui || ui.type !== "chunk") throw new Error("Missing plugin UI module");
          const modules = [...this.getModuleIds()];
          if (modules.some(id => /\/solid-js\/|\/render\/js\//.test(id))) throw new Error("Shared runtime leaked into plugin UI");
          if (/document\.|window\.|solid-js\/web/.test(ui.code)) throw new Error("Browser runtime leaked into plugin UI");
          const metadataAsset = bundle["manifest.json"];
          if (!metadataAsset || metadataAsset.type !== "asset") throw new Error("Missing artifact manifest");
          const metadata = JSON.parse(String(metadataAsset.source));
          // The emitted chunk's imports are authoritative. The type-checker
          // graph also contains files reachable only through erased type edges.
          const depends = { ...plugin.depends };
          for (const specifier of ui.imports) {
            const match = /^@plugins\/([^/]+)(?:\/ui)?$/.exec(specifier);
            if (match) depends[match[1]!] ??= "*";
          }
          metadata.plugin.depends = depends;
          // Lazy modules are optional: installation succeeds without them and
          // only executing import() requests their assets. Static imports win.
          const optional = { ...plugin.optional };
          const source = ts.createSourceFile("ui.js", ui.code, ts.ScriptTarget.Latest, true);
          function lazy(node: ts.Node) {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
              && node.expression.expression.getText(source) === "__tokamakModules" && node.expression.name.text === "load") {
              const arg = node.arguments[0];
              if (arg && ts.isStringLiteralLike(arg)) {
                const match = /^@plugins\/([^/]+)\/ui$/.exec(arg.text);
                if (match && !depends[match[1]!]) optional[match[1]!] ??= "*";
              }
            }
            ts.forEachChild(node, lazy);
          }
          lazy(source);
          metadata.plugin.optional = optional;
          metadata.plugin.contributes = uiContributions(root).contributes;
          // Inferred names obey the same manifest rules as explicit names.
          metadata.plugin = definePlugin(metadata.plugin);
          metadataAsset.source = JSON.stringify(metadata);
          const deps = ui.imports;
          ui.code = `globalThis.__tokamakModules.register(${JSON.stringify(`@plugins/${plugin.id}/ui`)},${JSON.stringify(deps)},function(require,exports,module){\n${ui.code}\n});\n`;
          const map = bundle["ui.js.map"];
          if (map?.type === "asset") {
            const source = JSON.parse(String(map.source));
            source.mappings = ";" + source.mappings;
            map.source = JSON.stringify(source);
          }
        }
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
