import type { Plugin } from "vite";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { assertPluginResolution, pluginReferenceSource } from "../../sdk/tools/plugin-boundary.mjs";
import { isInternalReferenceModule, serverDirectory } from "../../sdk/tools/server-files.mjs";

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
        const directory = realpathSync(root());
        const server = serverDirectory(directory);
        const file = realpathSync(target);
        if (
          isInternalReferenceModule(file) ||
          (server !== resolve(directory, "src") &&
            file.startsWith(server + sep) &&
            file !== resolve(server, "_generated/api.ts"))
        )
          throw new Error(
            `Server code cannot be imported by the window: ${id}. Import the generated public api instead.`,
          );
      }
      return resolved;
    },
    load(id) {
      if (id.startsWith("\0tokamak-reference:"))
        return pluginReferenceSource(root(), id.slice("\0tokamak-reference:".length), { publicOnly: true });
    },
  };
}
