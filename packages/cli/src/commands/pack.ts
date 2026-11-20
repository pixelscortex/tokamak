import type { Zippable } from "fflate";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Command } from "../command";
import { sha256 } from "../plugin-package";
import { runBuilder, withBuildLock } from "../plugin-build";

async function archive(outputFolder: string, destination: string) {
  const manifest = await readFile(resolve(outputFolder, "manifest.json"));
  const { plugin, hashes } = JSON.parse(manifest.toString()) as {
    plugin: { id: string; version: string };
    hashes: Record<string, string>;
  };
  const { id, version } = plugin;
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(id) || !/^[0-9][0-9A-Za-z.+-]*$/.test(version))
    throw new Error("Invalid plugin identity in the build manifest");

  const entries: Zippable = Object.assign(Object.create(null), { "manifest.json": manifest });
  for (const [name, hash] of Object.entries(hashes)) {
    if (
      name === "manifest.json" ||
      /[\\:]/.test(name) ||
      name.includes("\0") ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Invalid artifact path: ${name}`);
    }
    const bytes = await readFile(resolve(outputFolder, name));
    if (sha256(bytes) !== hash) throw new Error(`Artifact hash mismatch: ${name}`);
    entries[name] = bytes;
  }

  const { zipSync } = await import("fflate");
  const path = resolve(destination, `${id}-${version}.zip`);
  const temporary = resolve(dirname(path), `.tokamak-pack-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, zipSync(entries, { mtime: new Date(1980, 0, 1) }));
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path, id, version, buildId: sha256(manifest) };
}

export function packPlugin(
  folder: string | undefined,
  destination: string,
  next = "tokamak plugin pack --help",
) {
  return withBuildLock(folder, async (root) => {
    const { outputFolder } = await runBuilder(root, "--result-json", next);
    if (!outputFolder) throw new Error("The build did not report its output folder");
    return archive(outputFolder, destination);
  });
}

export default {
  path: "plugin pack",
  summary: "Build a plugin and write its ZIP package in the current folder.",
  args: { name: "folder", optional: true },
  example: "tokamak plugin pack ./my-plugin --json",
  async run([folder]) {
    const data = await packPlugin(folder, process.cwd());
    return { data, text: `Packed ${data.id} ${data.version}: ${data.path} (build id ${data.buildId})` };
  },
} satisfies Command;
