import { windowAliases, windowSharedImports } from "../../../packages/build/src/shared-libraries.mts";
import type { Plugin } from "vite";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const prefix = "virtual:tokamak-host/";
function importMap(imports: Record<string, string>) {
  const json = JSON.stringify({ imports });
  const hash = createHash("sha256").update(json).digest("base64");
  return { json, hash };
}
export function pluginModules(): Plugin {
  const specifiers = windowSharedImports;
  const chunks = new Map<string, string>();
  let production = false;
  return {
    name: "tokamak-plugin-modules",
    enforce: "post",
    configResolved(config) {
      production = config.command === "build";
    },
    resolveId(id) {
      if (id === "virtual:plugin-lexer")
        return createRequire(require.resolve("vite/package.json")).resolve("es-module-lexer/js");
      if (id.startsWith(prefix)) return `\0${id}`;
    },
    load(id) {
      if (!id.startsWith(`\0${prefix}`)) return;
      const specifier = decodeURIComponent(id.slice(prefix.length + 1));
      if (!specifiers.includes(specifier)) throw new Error(`Unknown host module: ${specifier}`);
      const target =
        specifier === "@tokamak/runtime/router"
          ? resolve(import.meta.dirname, "router.ts")
          : (windowAliases[specifier] ?? specifier);
      return `export * from ${JSON.stringify(target)};`;
    },
    buildStart() {
      if (production)
        for (const name of specifiers)
          chunks.set(
            name,
            this.emitFile({
              type: "chunk",
              id: prefix + encodeURIComponent(name),
              name: `host-${name.replace(/[^a-z0-9]/gi, "-")}`,
              preserveSignature: "strict",
            }),
          );
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (context.server) {
          const imports = Object.fromEntries(
            specifiers.map((name) => [name, `/@id/__x00__${prefix}${encodeURIComponent(name)}`]),
          );
          const { json, hash } = importMap(imports);
          return html
            .replace(/\s*__TOKAMAK_HOST_IMPORT_MAP__\s*/, json)
            .replace("'HOST_MAP_HASH'", `'sha256-${hash}'`);
        }
        return html;
      },
    },
    generateBundle(_options, bundle) {
      const imports = Object.fromEntries(
        [...chunks].map(([name, ref]) => [name, `/${this.getFileName(ref)}`]),
      );
      const { json, hash } = importMap(imports);
      for (const asset of Object.values(bundle))
        if (asset.type === "asset" && asset.fileName.endsWith(".html")) {
          asset.source = String(asset.source)
            .replace(/\s*__TOKAMAK_HOST_IMPORT_MAP__\s*/, json)
            .replace("'HOST_MAP_HASH'", `'sha256-${hash}'`);
        }
    },
  };
}

export function pluginFixtures(): Plugin {
  const serve = (
    request: { url?: string },
    response: { setHeader(name: string, value: string): void; end(body: string): void },
    next: () => void,
  ) => {
    const path = request.url?.split("?")[0];
    const match = path?.match(
      /^\/plugins\/(fixture|fixture-dependency)\/(one|two|throws)\/assets\/(ui\.js|ui\.css)$/,
    );
    if (!match) return next();
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Content-Type", match[3] === "ui.js" ? "text/javascript" : "text/css");
    response.end(
      match[3] === "ui.css"
        ? ":root { --fixture-loaded: 1 }"
        : readFileSync(
            resolve(
              import.meta.dirname,
              `../../tests/fixtures/${match[1] === "fixture" ? "ui.js" : "dependency.js"}`,
            ),
            "utf8",
          ).replaceAll("FIXTURE_REVISION", match[2]!),
    );
  };
  return {
    name: "tokamak-plugin-fixtures",
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      if (process.env.TOKAMAK_PLUGIN_FIXTURES === "1") server.middlewares.use(serve);
    },
  };
}
