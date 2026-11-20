import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { packageName, sharedPackages } from "./shared-libraries.mts";

export async function readPluginPackage(root: string) {
  const path = resolve(root, "package.json");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const manifest = JSON.parse(source);
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    const entries = manifest[section] ?? {};
    for (const [name, version] of Array.isArray(entries)
      ? entries.map((id) => [id, ""])
      : Object.entries(entries)) {
      const alias = typeof version === "string" && /^npm:((?:@[^/]+\/)?[^@]+)/.exec(version)?.[1];
      if (sharedPackages.has(name) || (alias && sharedPackages.has(packageName(alias)))) {
        throw new Error(
          `${path}: ${section} lists ${JSON.stringify(name)}, a shared library. Remove it; the app provides shared libraries.`,
        );
      }
    }
  }
  return manifest;
}

// Bun discovers workspace packages from the plugin folder when it is in a checkout.
export function installPluginPackages(root: string) {
  const install = spawnSync("proto", ["run", "bun", "--", "install", "--cwd", root, "--no-save"], {
    cwd: resolve(import.meta.dirname, "../../.."),
    stdio: "inherit",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  if (install.status !== 0) {
    const reason = install.error?.message ?? `exit ${install.status ?? install.signal}`;
    throw new Error(
      `Could not install npm packages in ${root}: ${reason}. Check registry access or the local Bun cache.`,
    );
  }
}
