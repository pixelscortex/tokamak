import { spawnSync } from "node:child_process";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { packageName, sharedPackages } from "./shared-libraries.mts";
import { BuildError } from "./diagnostics";

const dependencyMaps = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const checkout = resolve(import.meta.dirname, "../../..");

async function optionalFile(path: string) {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function readPluginPackage(root: string) {
  const path = resolve(root, "package.json");
  const source = await optionalFile(path);
  if (!source) return;
  const manifest = JSON.parse(source.toString());
  for (const section of [...dependencyMaps, "bundledDependencies", "bundleDependencies"]) {
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

async function bunLock(root: string) {
  for (const name of ["bun.lock", "bun.lockb"]) {
    const content = await optionalFile(resolve(root, name));
    if (content) return { name, content };
  }
}

async function installedState(root: string, installRoot: string, names: string[]) {
  const hash = createHash("sha256");
  for (const base of new Set([root, installRoot])) {
    for (const path of [
      "node_modules",
      "node_modules/.bun",
      ...names.map((name) => `node_modules/${name}/package.json`),
    ]) {
      const info = await stat(resolve(base, path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      hash.update(JSON.stringify([base, path, info?.ino, info?.mtimeMs, info?.size]));
    }
  }
  return hash.digest("hex");
}

export async function installPluginPackages(root: string, manifest: Record<string, unknown>) {
  const names = [...new Set(dependencyMaps.flatMap((section) => Object.keys(manifest[section] ?? {})))];
  if (!names.length) return;

  // The starter plugins belong to the checkout's Bun workspace.
  const local = relative(checkout, root).replaceAll("\\", "/");
  const installRoot = /^plugins\/[^/]+$/.test(local) ? checkout : root;
  const lock = await bunLock(installRoot);
  if (!lock) {
    for (const name of ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]) {
      if (await optionalFile(resolve(root, name)))
        throw new BuildError([
          {
            file: resolve(root, name),
            line: 1,
            column: 1,
            code: "PLUGIN_LOCKFILE_FORMAT",
            message: `Found ${name} in ${root}. Migrate it to a Bun lockfile before building so the recorded dependencies are preserved.`,
          },
        ]);
    }
  }
  const stamp = resolve(root, ".tokamak/npm-install");
  const signature = async (locked: NonNullable<Awaited<ReturnType<typeof bunLock>>>) =>
    createHash("sha256")
      .update(JSON.stringify([manifest, locked.name, process.platform, process.arch]))
      .update(locked.content)
      .update(await installedState(root, installRoot, names))
      .digest("hex");
  if (lock && (await optionalFile(stamp))?.toString() === (await signature(lock))) return;

  const install = spawnSync(
    "proto",
    ["run", "bun", "--", "install", "--cwd", root, ...(lock ? ["--frozen-lockfile"] : [])],
    {
      cwd: checkout,
      stdio: ["inherit", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      killSignal: "SIGKILL",
    },
  );
  if (install.stdout) process.stdout.write(install.stdout);
  if (install.stderr) process.stderr.write(install.stderr);
  if (install.status !== 0) {
    const reason = install.error?.message ?? `exit ${install.status ?? install.signal}`;
    const disagreement = lock && /lockfile had changes/i.test(install.stderr ?? "");
    throw new BuildError([
      {
        file: disagreement ? resolve(installRoot, lock.name) : resolve(root, "package.json"),
        line: 1,
        column: 1,
        code: disagreement ? "PLUGIN_LOCKFILE_MISMATCH" : "PLUGIN_DEPENDENCY_INSTALL",
        message:
          `Could not install npm packages in ${root}: ${reason}. ` +
          (lock ? `The frozen ${lock.name} must agree with package.json. ` : "") +
          "Check registry access or the local Bun cache.",
      },
    ]);
  }
  const installedLock = await bunLock(installRoot);
  if (installedLock) {
    await mkdir(resolve(root, ".tokamak"), { recursive: true });
    await writeFile(stamp, await signature(installedLock));
  }
}
