import ts from "typescript";
import { createHash } from "node:crypto";
import { definePlugin, type PluginDefinition } from "@tokamak/sdk";
import type { Plugin } from "vite";
import { uiContributions } from "./contributions.ts";

type GenerateBundle = Extract<NonNullable<Plugin["generateBundle"]>, (...args: never[]) => unknown>;

export function artifactBundle(
  root: string,
  plugin: Readonly<PluginDefinition>,
  options: { ui?: false; standalone?: boolean },
): GenerateBundle {
  return function (_options, bundle) {
    if (options.ui === false) delete bundle["ui.js"];
    if (options.ui !== false && !options.standalone) {
      const ui = bundle["ui.js"];
      if (!ui || ui.type !== "chunk") throw new Error("Missing plugin UI module");
      const modules = [...this.getModuleIds()];
      if (modules.some((id) => /\/solid-js\/|\/render\/js\//.test(id)))
        throw new Error("Shared runtime leaked into plugin UI");
      if (/document\.|window\.|solid-js\/web/.test(ui.code))
        throw new Error("Browser runtime leaked into plugin UI");
      const metadataAsset = artifactManifest(bundle);
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
      inferOptional(ui.code, depends, optional);
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
    const manifest = artifactManifest(bundle);
    const hashes = bundleHashes(bundle);
    const metadata = JSON.parse(String(manifest.source));
    manifest.source = JSON.stringify({ ...metadata, hashes }, null, 2) + "\n";
  };
}

function inferOptional(code: string, depends: Record<string, string>, optional: Record<string, string>) {
  const source = ts.createSourceFile("ui.js", code, ts.ScriptTarget.Latest, true);
  function lazy(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "__tokamakModules" &&
      node.expression.name.text === "load"
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) {
        const match = /^@plugins\/([^/]+)\/ui$/.exec(arg.text);
        if (match && !depends[match[1]!]) optional[match[1]!] ??= "*";
      }
    }
    ts.forEachChild(node, lazy);
  }
  lazy(source);
}

function bundleHashes(bundle: Parameters<GenerateBundle>[1]) {
  const hashes: Record<string, string> = {};
  for (const [name, file] of Object.entries(bundle)) {
    if (name === "manifest.json") continue;
    hashes[name] = createHash("sha256")
      .update(file.type === "chunk" ? file.code : file.source)
      .digest("hex");
  }
  return hashes;
}

function artifactManifest(bundle: Parameters<GenerateBundle>[1]) {
  const manifest = bundle["manifest.json"];
  if (!manifest || manifest.type !== "asset") throw new Error("Missing artifact manifest");
  return manifest;
}
