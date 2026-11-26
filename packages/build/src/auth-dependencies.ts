import type { PluginDefinition } from "@tokamak/sdk";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { functionPlacement } from "../../sdk/tools/placement.mjs";
import { checkPluginImports } from "../../sdk/tools/plugin-boundary.mjs";
import { readDescriptor } from "./descriptor.ts";

const providesSignIn = (provider: { owner?: string; name: string }) =>
  provider.owner === "auth" && provider.name === "method";

/** Use the installed artifact identity; installations need not be named after their plugin. */
export function signInDependency(root: string, plugin: PluginDefinition, catalog?: string) {
  const dependencies = new Set([...Object.keys(plugin.depends ?? {}), ...Object.keys(plugin.optional ?? {})]);
  dependencies.delete("auth");
  if (!dependencies.size) return;

  const catalogs = new Set([
    catalog && resolve(root, catalog),
    process.env.TOKAMAK_PLUGIN_DIR,
    dirname(root),
  ]);
  for (const directory of catalogs) {
    if (!directory || !existsSync(directory)) continue;
    const id = installedSignIn(directory, dependencies);
    if (id) return id;
  }

  return sourceSignIn(root, dependencies);
}

// A sibling source dependency can be identified before its first build.
function sourceSignIn(root: string, dependencies: Set<string>) {
  for (const id of dependencies) {
    const folder = resolve(dirname(root), id);
    const descriptor = readDescriptor(folder);
    if (descriptor?.id !== id || !(descriptor.depends?.auth || descriptor.optional?.auth)) continue;
    checkPluginImports(folder);
    if (functionPlacement(folder)?.providers.some(providesSignIn)) return id;
  }
}

function installedSignIn(directory: string, dependencies: Set<string>) {
  const folders = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => resolve(directory, entry.name));
  for (const folder of [directory, ...folders]) {
    const path = ["manifest.json", "dist/manifest.json"]
      .map((name) => resolve(folder, name))
      .find(existsSync);
    if (!path) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // Invalid artifacts are diagnosed by catalog loading.
    }
    const id = manifest?.plugin?.id;
    if (
      typeof id === "string" &&
      dependencies.has(id) &&
      Array.isArray(manifest.contractProviders) &&
      manifest.contractProviders.some(providesSignIn)
    )
      return id;
  }
}
