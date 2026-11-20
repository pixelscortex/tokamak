import type { Plugin } from "vite";
import { isAbsolute } from "node:path";
import { assertPluginResolution, pluginReferenceSource } from "../../sdk/tools/plugin-boundary.mjs";

import { checkTokamakImport, resolvedPackage, windowExternal } from "./shared-libraries.mts";

export function pluginBoundary(root: () => string): Plugin {
  return {
    name: "tokamak-plugin-boundary",
    enforce: "pre",
    async resolveId(id, importer, options) {
      if (id.startsWith("plugin:")) {
        const client = /^plugin:([^/]+)\/client$/.exec(id);
        if (client) return { id: `@plugins/${client[1]}/ui`, external: true };
        return `\0tokamak-reference:${id}`;
      }
      if (id.startsWith("@plugins/")) return { id, external: true };
      if (importer) {
        checkTokamakImport(id, importer, "window");
        const external = windowExternal(id, importer);
        if (external) {
          if (options.kind === "require-call")
            throw new Error(
              `${importer} uses require for ${JSON.stringify(id)}. Use an ES module build of this dependency.`,
            );
          return { id: external, external: true };
        }
      }
      if (importer?.startsWith("\0")) return;
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (resolved && !resolved.external && isAbsolute(resolved.id)) {
        const target = resolved.id.split("?")[0]!;
        if (importer) {
          windowExternal(id, importer, target);
          const owner = resolvedPackage(target);
          if (owner?.startsWith("@tokamak/") && owner !== resolvedPackage(importer))
            checkTokamakImport(id, importer, "window", false, owner);
        }
        assertPluginResolution(
          root(),
          importer?.split("?")[0] ?? root(),
          id,
          target,
          !id.startsWith(".") && !isAbsolute(id) && /\/node_modules\//.test(resolved.id),
        );
      }
      return resolved;
    },
    load(id) {
      if (id.startsWith("\0tokamak-reference:"))
        return pluginReferenceSource(root(), id.slice("\0tokamak-reference:".length));
    },
  };
}
