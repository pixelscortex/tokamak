import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function warnMissingHookTargets(
  root: string,
  plugin: string,
  functions: Set<string>,
  catalog: string | undefined,
  warn: (message: string) => void,
) {
  const reported = new Set<string>();
  for (const directory of new Set([
    dirname(root),
    process.env.TOKAMAK_PLUGIN_DIR,
    catalog && resolve(root, catalog),
  ])) {
    if (!directory || !existsSync(directory)) continue;
    const folders = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => resolve(directory, entry.name));
    for (const folder of [directory, ...folders]) {
      const path = ["manifest.json", "dist/manifest.json"]
        .map((file) => resolve(folder, file))
        .find(existsSync);
      if (!path) continue;

      let manifest: { plugin?: { id?: string }; hookTargets?: unknown };
      try {
        manifest = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      const owner = manifest?.plugin?.id;
      if (!owner || !Array.isArray(manifest.hookTargets)) continue;
      for (const target of manifest.hookTargets) {
        if (typeof target !== "string" || !target.startsWith(`${plugin}/`) || functions.has(target)) continue;
        const message = `Plugin "${owner}" hooks ${target}, which no longer exists`;
        if (reported.has(message)) continue;

        reported.add(message);
        warn(message);
      }
    }
  }
}
