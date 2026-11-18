import type { Plugin } from "vite";
import { isAbsolute } from "node:path";
import { assertPluginResolution, pluginReferenceSource } from "../../sdk/tools/plugin-boundary.mjs";

export function pluginBoundary(root: () => string): Plugin {
  return {
    name: "tokamak-plugin-boundary",
    enforce: "pre",
    async resolveId(id, importer) {
      if (id.startsWith("plugin:")) {
        const client = /^plugin:([^/]+)\/client$/.exec(id);
        if (client) return { id: `@plugins/${client[1]}/ui`, external: true };
        return `\0tokamak-reference:${id}`;
      }
      if (importer?.startsWith("\0")) return;
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (resolved && !resolved.external && isAbsolute(resolved.id)) {
        const target = resolved.id.split("?")[0]!;
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
