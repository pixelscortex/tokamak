import ts from "typescript";
import { definePlugin, type PluginDefinition } from "@tokamak/sdk";
import { uiContributions } from "./contributions.ts";
import { createHash } from "node:crypto";
import type { Plugin } from "vite";

type GenerateBundle = Extract<NonNullable<Plugin["generateBundle"]>, (...args: never[]) => unknown>;

export function artifactBundle(
  root: string,
  plugin: Readonly<PluginDefinition>,
  options: { ui?: false; stripClientSources?: boolean },
): GenerateBundle {
  return function (_options, bundle) {
    delete bundle[".tokamak-backend-entry.js"];
    // Commit the hashes of final emitted bytes, not intermediate compiler
    // inputs. A loader snapshots and verifies these before evaluating code.
    const manifest = artifactManifest(bundle);
    const metadata = JSON.parse(String(manifest.source));
    if (options.ui !== false) {
      const ui = bundle["ui.js"];
      if (!ui || ui.type !== "chunk") throw new Error("Missing plugin UI module");
      if (options.stripClientSources || metadata.entries.local) {
        // Bundlers can refill omitted source text from disk while composing
        // maps. Strip it from the published map before hashing the artifact.
        const asset = bundle["ui.js.map"];
        if (asset?.type === "asset") {
          const map = JSON.parse(String(asset.source));
          stripSourcesContent(map);
          asset.source = JSON.stringify(map);
        }
        if (ui.map) stripSourcesContent(ui.map);
      }
      const depends = { ...plugin.depends };
      const optional = { ...plugin.optional };
      for (const specifier of ui.imports) {
        const match = /^@plugins\/([^/]+)(?:\/ui)?$/.exec(specifier);
        if (match) depends[match[1]!] ??= "*";
      }
      const source = ts.createSourceFile("ui.js", ui.code, ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0];
          const match = arg && ts.isStringLiteralLike(arg) && /^@plugins\/([^/]+)(?:\/ui)?$/.exec(arg.text);
          if (match && !depends[match[1]!]) optional[match[1]!] ??= "*";
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      metadata.plugin = definePlugin({
        ...plugin,
        depends,
        optional,
        contributes: uiContributions(root, plugin.id).contributes,
      });
      metadata.entries.ui = {
        code: "ui.js",
        map: "ui.js.map",
        ...(bundle["styles.css"] ? { css: "styles.css" } : {}),
      };
    }
    const hashes = bundleHashes(bundle);
    manifest.source = JSON.stringify({ ...metadata, hashes }, null, 2) + "\n";
  };
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

export function stripSourcesContent(map: { sourcesContent?: unknown }) {
  delete map.sourcesContent;
}
